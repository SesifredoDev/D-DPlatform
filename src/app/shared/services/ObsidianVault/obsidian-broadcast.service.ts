import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { BroadcastDialog } from '../../../objects/broadcast-dialog/broadcast-dialog';
import type { BroadcastData, BroadcastEmbeddedFile } from '../../models/objects/broadcast-dialog/broadcast-dialog.model';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { VaultIndex, VaultIndexService } from './vault-index.service';
import { getVaultDisplayName, getVaultFileType, inferImageMimeType, isVaultFileType } from './vault-file-types';
import { SECRET_SELECTOR, stripSecrets } from './secrets';
import { CALLOUT_ACTION_CLASS, CALLOUT_MARKER_CLASS, formatCalloutsForBroadcast, resolveCalloutType } from './callouts';
import {
  baseMarkdown,
  calendarMarkdown,
  canvasMarkdown,
  isEmbedSize,
  linkDisplayName,
  noteBroadcastMarkdown,
  outsideCode,
  playerFamilyTree,
  playerText,
  statblockMarkdown,
  timelineMarkdown,
} from './broadcast-format';
import { renderFamilyTreeImage, renderMapImage } from './broadcast-render';
import { parseBase, runBaseView } from './bases';
import { CalendarEngine } from './calendar-engine';
import { CalendarService } from './calendar.service';
import { FamilyPerson, layoutFamilyTree, noteImageCandidates, parseFamilyTree } from './family-tree';
import { blockKindOf, findStatblocks } from './statblock';
import { parseCalendarFile } from './vault-calendar';
import { findImage } from './vault-image.service';
import { isMapLink, linkName, MapPin, parseVaultMap, SUBMAP_ICON } from './vault-map';
import { broadcastMapBlock, playerPin } from './broadcast-map';
import { parseTimeline } from './vault-timeline';

/**
 * Statblock cards and note embeds in the editor (see statblock-node-views.ts), and the image
 * controls. They're interactive GM tools, so they're left out of broadcast HTML; embeds and cards
 * that say what they show (`data-broadcast-*`) are written out as Markdown first.
 */
const STATBLOCK_SELECTOR = '.statblock-node, .resizable-image-cast, .resizable-image-handle, .resizable-image-readout';
/** Editor embeds and statblock cards that carry their source (set in statblock-node-views.ts). */
const BROADCAST_SOURCE_SELECTOR = '[data-broadcast-embed], [data-broadcast-block]';
/** How deep embeds inside embedded notes are followed. */
const MAX_EMBED_DEPTH = 2;

/** Where a broadcast comes from: the vault and the note whose relative links should be resolved. */
export interface VaultBroadcastContext {
  serverId: string;
  /** Path of the open note; relative embeds resolve from its folder. */
  currentFilePath: string;
}

export interface VaultDocumentBroadcast extends VaultBroadcastContext {
  fileName: string;
  /**
   * Text of the file for text types (notes, maps, family trees, calendars, timelines, canvases,
   * bases), which are formatted for players. Null for other files: they're sent as the file itself.
   */
  content: string | null;
  /** Bases: the view on screen, whose rows are broadcast. */
  baseViewIndex?: number;
}

export interface VaultImageBroadcast {
  src: string;
  alt: string;
  /** Vault path from the image's data-path attribute, if present. */
  path: string | null;
}

/** What a broadcast left out. `allSecret` means nothing was sent because everything selected was GM-only. */
export interface BroadcastSecretsReport {
  removed: number;
  allSecret: boolean;
}

interface TokenizeState {
  embeddedFiles: BroadcastEmbeddedFile[];
  /** Resolved vault path -> token URL, so the same file is only attached once. */
  tokens: Map<string, string>;
  /** GM secrets (and GM-only map pins) left out along the way. */
  removed: number;
}

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Builds broadcast payloads from vault content, then opens the broadcast dialog. Every kind of file
 * is formatted for players, with GM-only content left out:
 * - notes: secret callouts and `%%comments%%` removed, statblocks written out as cards, embeds
 *   resolved (images attached, maps and family trees drawn, calendars and timelines listed);
 * - maps: interactive player maps (pan, zoom, pin names, layer toggles), without GM-only pins;
 * - family trees: drawn, plus a list of everyone; calendars: this month; timelines: their entries;
 * - canvases: their cards in reading order; bases: the view's rows as a table;
 * - anything else (images, PDFs, music, video…) is sent as the file itself.
 * Vault files are replaced with `broadcast-file://` tokens and attached; the dialog uploads them.
 */
@Injectable({
  providedIn: 'root',
})
export class ObsidianBroadcastService {
  constructor(
    private dialog: MatDialog,
    private vaultService: ObsidianVaultService,
    private vaultIndex: VaultIndexService,
    private calendarService: CalendarService
  ) {}

  /** Broadcasts a whole file. Throws (with a message for the GM) when the file can't be read. */
  async broadcastDocument(request: VaultDocumentBroadcast): Promise<BroadcastSecretsReport> {
    const data: BroadcastData = {
      source: 'obsidian-view',
      filename: request.fileName,
    };
    const state = this.newTokenizeState();
    const markdown = request.content === null ? null : await this.formatFile(request, request.content, state, request.baseViewIndex ?? 0);

    if (markdown !== null) {
      data.text = await this.tokenizeMarkdownImages(request, markdown, state);
      data.embeddedFiles = state.embeddedFiles;
      data.preferTextForBroadcast = true;
    } else {
      const blob = await this.vaultService.readFileAsBlob(request.serverId, request.currentFilePath);
      data.file = new File([blob], request.fileName, { type: blob.type });
    }

    this.openDialog(data);
    return { removed: state.removed, allSecret: false };
  }

  /**
   * Broadcasts a DOM selection made inside the note editor. GM-only parts are removed; if the whole
   * selection is GM-only, nothing is broadcast. Embeds and statblock cards in it are written out as
   * Markdown (a selection inside one broadcasts that whole embed).
   */
  async broadcastSelection(context: VaultBroadcastContext, selection: Selection): Promise<BroadcastSecretsReport> {
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorElement = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (ancestorElement?.closest(SECRET_SELECTOR)) {
      return { removed: 1, allSecret: true };
    }

    const state = this.newTokenizeState();
    const embedHost = ancestorElement?.closest<HTMLElement>(BROADCAST_SOURCE_SELECTOR);
    if (embedHost) {
      const markdown = await this.sourceElementMarkdown(context, embedHost, state);
      if (!markdown.trim()) return { removed: state.removed, allSecret: state.removed > 0 };
      this.openDialog({
        source: 'obsidian-view-selection',
        text: await this.tokenizeMarkdownImages(context, markdown, state),
        embeddedFiles: state.embeddedFiles,
        preferTextForBroadcast: true,
      });
      return { removed: state.removed, allSecret: false };
    }

    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const secretElements = container.querySelectorAll(SECRET_SELECTOR);
    secretElements.forEach(element => element.remove());
    // Embeds and statblock cards: their Markdown, in place of the interactive view.
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(BROADCAST_SOURCE_SELECTOR))) {
      const markdown = await this.sourceElementMarkdown(context, element, state);
      if (!markdown.trim()) {
        element.remove();
        continue;
      }
      const block = document.createElement('p');
      block.textContent = markdown;
      element.replaceWith(block);
    }
    container.querySelectorAll(`.${CALLOUT_ACTION_CLASS}, ${STATBLOCK_SELECTOR}`).forEach(element => element.remove());
    formatCalloutElements(container);
    // Text from the cleaned HTML (selection.toString() would still include the secrets), then
    // strip any secret syntax the editor didn't mark.
    const stripped = stripSecrets(selectionText(container));
    const removed = secretElements.length + stripped.removed + state.removed;
    if (!stripped.markdown.trim() && !container.querySelector('img')) {
      return { removed, allSecret: removed > 0 };
    }

    // Rendered <img> tags in the selected HTML.
    const images = Array.from(container.querySelectorAll('img'));
    for (const img of images) {
      const src = img.getAttribute('src');
      if (src) {
        img.setAttribute('src', await this.tokenizeImage(context, img.getAttribute('data-path') || src, img.getAttribute('alt') || '', state, src));
      }
    }

    const data: BroadcastData = {
      text: await this.tokenizeMarkdownImages(context, formatCalloutsForBroadcast(stripped.markdown), state),
      embeddedFiles: state.embeddedFiles,
      htmlContent: container.innerHTML,
      source: 'obsidian-view-selection',
    };

    if (images.length === 1 && (container.textContent ?? '').trim() === '') {
      data.imageUrl = images[0].src;
    }

    this.openDialog(data);
    return { removed, allSecret: false };
  }

  /**
   * Broadcasts a single block (a read-aloud callout's Broadcast button), formatted like a note:
   * GM secrets removed and the callout header turned into a bold title.
   */
  async broadcastBlock(context: VaultBroadcastContext, block: { markdown: string; html: string }): Promise<BroadcastSecretsReport> {
    const state = this.newTokenizeState();
    const markdown = await this.noteMarkdown(context, block.markdown, state, 0);
    const data: BroadcastData = {
      source: 'obsidian-view-read-aloud',
      text: await this.tokenizeMarkdownImages(context, markdown, state),
      embeddedFiles: state.embeddedFiles,
      preferTextForBroadcast: true,
    };

    this.openDialog(data);
    return { removed: state.removed, allSecret: false };
  }

  /** Broadcasts a right-clicked image, sending the vault file itself when it can be resolved. */
  async broadcastImage(context: VaultBroadcastContext, image: VaultImageBroadcast): Promise<void> {
    const searchPath = image.path || this.toVaultSearchPath(image.src);
    const fallbackName = searchPath?.split('/').pop() || image.alt || image.src.split('/').pop() || 'image';
    const data: BroadcastData = {
      source: 'obsidian-view-image',
      filename: fallbackName.includes('.') ? fallbackName : `${fallbackName}.png`,
    };

    const resolvedPath = searchPath ? await this.resolveVaultPath(context, searchPath) : null;
    if (resolvedPath && isVaultFileType(resolvedPath, 'image')) {
      try {
        const blob = await this.vaultService.readFileAsBlob(context.serverId, resolvedPath);
        data.filename = resolvedPath.split('/').pop() || data.filename;
        data.file = new File([blob], data.filename!, { type: blob.type || inferImageMimeType(data.filename!) });
        this.openDialog(data);
        return;
      } catch (error) {
        console.warn('[ObsidianBroadcast] Failed to read right-clicked image from vault', resolvedPath, error);
      }
    }

    data.imageUrl = image.src;
    this.openDialog(data);
  }

  private openDialog(data: BroadcastData): void {
    this.dialog.open(BroadcastDialog, {
      data,
      maxWidth: '600px',
      width: '100%',
      panelClass: ['glass-dialog-container', 'broadcast-dialog-panel'],
    });
  }

  private newTokenizeState(): TokenizeState {
    return { embeddedFiles: [], tokens: new Map(), removed: 0 };
  }

  // ---- Formatting files for players ----

  /** A file's player version as Markdown (with `![[embeds]]` resolved), or null to send the file itself. */
  private async formatFile(context: VaultBroadcastContext, content: string, state: TokenizeState, baseViewIndex: number): Promise<string | null> {
    const path = context.currentFilePath;
    const title = `## ${getVaultDisplayName(path.split('/').pop() || path)}`;
    switch (getVaultFileType(path).id) {
      case 'markdown':
        return this.noteMarkdown(context, content, state, 0);
      case 'map':
        return this.mapMarkdown(context, content, state);
      case 'family-tree':
        return `${title}\n\n${await this.familyTreeMarkdown(context, content, state)}`;
      case 'calendar':
        return this.calendarFileMarkdown(content, null, state);
      case 'timeline':
        return `${title}\n\n${await this.timelineFileMarkdown(context, content, state)}`;
      case 'canvas': {
        const canvas = canvasMarkdown(content);
        state.removed += canvas.removed;
        return `${title}\n\n${await this.expandEmbeds(context, canvas.markdown, state, 0)}`;
      }
      case 'base':
        return `${title}\n\n${await this.baseFileMarkdown(context, content, baseViewIndex)}`;
      default:
        return null;
    }
  }

  /** A note (or part of one) for players: secrets out, callouts titled, embeds resolved. */
  private async noteMarkdown(context: VaultBroadcastContext, markdown: string, state: TokenizeState, depth: number): Promise<string> {
    const stripped = stripSecrets(markdown);
    state.removed += stripped.removed;
    const formatted = noteBroadcastMarkdown(formatCalloutsForBroadcast(stripped.markdown));
    return this.expandEmbeds(context, formatted, state, depth);
  }

  /**
   * The map as an interactive player map (see broadcast-map.ts): its image uploaded, and the pins
   * players may see, named and unlinked. GM-only pins, pins whose whole label is a secret, and
   * layers left without pins are dropped. Layers keep their visibility; players can toggle them.
   */
  private async mapMarkdown(context: VaultBroadcastContext, content: string, state: TokenizeState): Promise<string> {
    const map = parseVaultMap(content);
    const index = await this.index(context.serverId);
    state.removed += map.pins.filter(pin => pin.gmOnly).length;
    const name = getVaultDisplayName(context.currentFilePath.split('/').pop() || 'Map');

    const pins: MapPin[] = [];
    for (const pin of map.pins) {
      if (pin.gmOnly) continue;
      const entry = pin.link ? index.resolveLink(pin.link, context.currentFilePath) : null;
      const rawLabel = pin.label || (entry?.kind === 'file' ? getVaultDisplayName(entry.name) : linkName(pin.link));
      const label = playerText(rawLabel);
      state.removed += label.removed;
      if (rawLabel.trim() && !label.text) continue;
      const icon = isMapLink(pin.link) && pin.icon === 'location_on' ? SUBMAP_ICON : pin.icon;
      pins.push(playerPin(pin, label.text, icon));
    }
    const used = new Set(pins.map(pin => pin.layer));
    const layers = map.layers.filter(layer => used.has(layer.id)).map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible }));
    const layerIds = new Set(layers.map(layer => layer.id));
    for (const pin of pins) if (pin.layer && !layerIds.has(pin.layer)) pin.layer = null;

    let image: string | null = null;
    if (map.image) {
      const source = await this.mapImageSource(context, map.image, index);
      // A copy no bigger than players need; a web image that can't be copied is used as it is.
      const copy = source ? await renderMapImage(source) : null;
      if (copy) image = this.addEmbeddedFile(state, copy, `${safeFileName(name)}.jpg`);
      else if (/^https?:\/\//i.test(map.image)) image = map.image;
    }
    if (!image && !pins.length) return '*This map is empty.*';
    return broadcastMapBlock(name, { image, size: null, pins, layers });
  }

  /** The map's image: the vault file, or its web URL. */
  private async mapImageSource(context: VaultBroadcastContext, ref: string, index: VaultIndex): Promise<Blob | string | null> {
    if (/^https?:\/\//i.test(ref)) return ref;
    const text = ref.replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1').trim();
    const path = findImage(index, text, context.currentFilePath)?.relativePath
      ?? (getVaultFileType(text).viewer === 'image' ? text.replace(/^\/+/, '') : null);
    if (!path) return null;
    try {
      return await this.vaultService.readFileAsBlob(context.serverId, path);
    } catch {
      return null;
    }
  }

  /** The family tree drawn, with portraits. */
  private async familyTreeMarkdown(context: VaultBroadcastContext, content: string, state: TokenizeState): Promise<string> {
    const player = playerFamilyTree(parseFamilyTree(content));
    state.removed += player.removed;
    if (!player.tree.people.length) return '*This family tree is empty.*';
    const index = await this.index(context.serverId);
    const portraits = new Map<string, Blob>();
    await Promise.all(player.tree.people.map(async person => {
      const portrait = await this.portraitFor(context, person, index);
      if (portrait) portraits.set(person.id, portrait);
    }));
    const name = getVaultDisplayName(context.currentFilePath.split('/').pop() || 'Family tree');
    const rendered = await renderFamilyTreeImage(player.tree, layoutFamilyTree(player.tree), portraits);
    return rendered
      ? `![${name}](${this.addEmbeddedFile(state, rendered, `${safeFileName(name)}.png`)})`
      : '*This family tree couldn’t be drawn.*';
  }

  /**
   * A person's picture, found the way the family tree view finds it: their own portrait, else the
   * first image in their linked note (outside its GM secrets). Null when there's none or it can't be read.
   */
  private async portraitFor(context: VaultBroadcastContext, person: FamilyPerson, index: VaultIndex): Promise<Blob | null> {
    try {
      if (person.portrait) return await this.imageBlob(context.serverId, person.portrait, context.currentFilePath, index);
      const note = person.link ? index.resolveLink(person.link, context.currentFilePath) : null;
      if (note?.kind !== 'file' || !isVaultFileType(note.name, 'markdown')) return null;
      const content = stripSecrets(await this.read(context, note)).markdown;
      for (const candidate of noteImageCandidates(content)) {
        const blob = await this.imageBlob(context.serverId, candidate, note.relativePath, index);
        if (blob) return blob;
      }
    } catch (error) {
      console.warn(`[ObsidianBroadcast] Could not load portrait for ${person.name}`, error);
    }
    return null;
  }

  /** An image reference (vault link or web URL) as a file. Web images must allow being fetched. */
  private async imageBlob(serverId: string, ref: string, fromPath: string, index: VaultIndex): Promise<Blob | null> {
    const text = ref.trim().replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1').trim();
    if (/^https?:\/\//i.test(text)) {
      try {
        const response = await fetch(text);
        return response.ok ? await response.blob() : null;
      } catch {
        return null;
      }
    }
    const entry = findImage(index, text, fromPath);
    return entry ? this.vaultService.readFileAsBlob(serverId, entry.relativePath) : null;
  }

  /** A calendar's month (the anchor's, else today's), headed by the calendar's name. */
  private calendarFileMarkdown(content: string, anchor: string | null, state: TokenizeState): string {
    const engine = new CalendarEngine(parseCalendarFile(content));
    const focus = anchor ? engine.parse(anchor)?.date ?? null : null;
    const result = calendarMarkdown(engine, focus);
    state.removed += result.removed;
    return `## ${engine.def.name}\n\n${result.markdown}`;
  }

  /** A timeline's entries (its events, and the dated notes and holidays it shows). */
  private async timelineFileMarkdown(context: VaultBroadcastContext, content: string, state: TokenizeState): Promise<string> {
    const timeline = parseTimeline(content);
    const [calendars] = await Promise.all([
      this.calendarService.load(context.serverId),
      this.vaultIndex.ensureContentIndexed(context.serverId),
    ]);
    const index = await this.index(context.serverId);
    const calendar = this.calendarService.find(calendars, timeline.calendar, index, context.currentFilePath)
      ?? this.calendarService.defaultCalendar(calendars);
    if (!calendar) return '*This timeline needs a calendar.*';
    const { entries } = this.calendarService.timelineEntries(context.serverId, calendar, timeline, context.currentFilePath);
    const result = timelineMarkdown(calendar.engine, entries);
    state.removed += result.removed;
    return result.markdown;
  }

  /** A base view's rows as a table. */
  private async baseFileMarkdown(context: VaultBroadcastContext, content: string, viewIndex: number): Promise<string> {
    const config = parseBase(content);
    if (config.error) throw new Error('This base file can’t be read.');
    await this.vaultIndex.ensureContentIndexed(context.serverId);
    const index = await this.index(context.serverId);
    const view = Math.min(Math.max(0, viewIndex), Math.max(0, config.views.length - 1));
    return baseMarkdown(config, view, runBaseView(config, view, index, context.currentFilePath));
  }

  // ---- Embeds ----

  /** Resolves every `![[embed]]` outside code (see expandEmbed). */
  private async expandEmbeds(context: VaultBroadcastContext, markdown: string, state: TokenizeState, depth: number): Promise<string> {
    // Mark embeds outside code synchronously, then resolve them in order.
    const embeds: string[] = [];
    const marked = outsideCode(markdown, text => text.replace(/!\[\[([^\]\n]+)\]\]/g, (_, inner: string) => {
      embeds.push(inner);
      return `\u0000${embeds.length - 1}\u0000`;
    }));
    if (!embeds.length) return markdown;
    const resolved: string[] = [];
    for (const inner of embeds) resolved.push(await this.expandEmbed(context, inner, state, depth));
    return marked.replace(/\u0000(\d+)\u0000/g, (_, i: string) => resolved[Number(i)]);
  }

  /**
   * One `![[target#anchor|caption]]` for players: images are attached; maps and family trees are
   * drawn; calendars and timelines written out; a note with a statblock shows the card (other notes
   * their name); music, video, PDFs and other files are attached as links.
   */
  private async expandEmbed(context: VaultBroadcastContext, inner: string, state: TokenizeState, depth: number): Promise<string> {
    const [target, ...captionParts] = inner.split('|');
    const caption = captionParts.join('|').trim();
    const [pathPart, ...anchorParts] = target.split('#');
    const anchor = anchorParts.join('#').trim();
    const path = pathPart.replace(/\\/g, '/').trim();
    const index = await this.index(context.serverId);
    const linked = path ? index.resolveLink(path, context.currentFilePath) : null;
    const entry = linked?.kind === 'file' ? linked : path ? findImage(index, path, context.currentFilePath) : null;
    const name = entry ? getVaultDisplayName(entry.name) : linkDisplayName(path) || anchor;
    const label = caption && !isEmbedSize(caption) ? caption : name;
    if (!entry) {
      console.warn(`[ObsidianBroadcast] Could not resolve embed for broadcast: ${inner}`);
      return label ? `*${label}*` : '';
    }

    const embedded: VaultBroadcastContext = { serverId: context.serverId, currentFilePath: entry.relativePath };
    try {
      switch (getVaultFileType(entry.name).id) {
        case 'image':
          return `![${label}](${await this.tokenizeImage(context, entry.relativePath, entry.name, state)})`;
        case 'map':
          // On lines of its own, so an embed mid-sentence still reads as a map block.
          return `\n\n${await this.mapMarkdown(embedded, await this.read(context, entry), state)}\n\n`;
        case 'family-tree':
          return await this.familyTreeMarkdown(embedded, await this.read(context, entry), state);
        case 'calendar':
          return this.calendarFileMarkdown(await this.read(context, entry), anchor || null, state);
        case 'timeline':
          return `**${label}**\n\n${await this.timelineFileMarkdown(embedded, await this.read(context, entry), state)}`;
        case 'markdown': {
          if (depth >= MAX_EMBED_DEPTH) return `**${label}**`;
          const block = findStatblocks(stripSecrets(await this.read(context, entry)).markdown)[0];
          if (!block) return `**${label}**`;
          return await this.expandEmbeds(embedded, statblockMarkdown(block.kind, block.source), state, depth + 1);
        }
        case 'canvas':
        case 'base':
          return `**${label}**`;
        default: {
          // Music, video, PDFs and other files: attached and linked by name.
          const token = await this.tokenizeFile(context.serverId, entry, state);
          return token ? `[${entry.name}](${token})` : `*${label}*`;
        }
      }
    } catch (error) {
      console.warn(`[ObsidianBroadcast] Could not format embed for broadcast: ${inner}`, error);
      return `*${label}*`;
    }
  }

  /** Markdown for an editor embed or statblock card, from its `data-broadcast-*` attributes. */
  private async sourceElementMarkdown(context: VaultBroadcastContext, element: HTMLElement, state: TokenizeState): Promise<string> {
    const embed = element.dataset['broadcastEmbed'];
    if (embed) return this.expandEmbed(context, embed, state, 0);
    const kind = blockKindOf(element.dataset['broadcastBlock']);
    if (!kind) return '';
    return this.expandEmbeds(context, statblockMarkdown(kind, element.dataset['broadcastSource'] ?? ''), state, 0);
  }

  private read(context: VaultBroadcastContext, entry: VaultEntry): Promise<string> {
    return this.vaultService.readFile(context.serverId, entry.relativePath);
  }

  private async index(serverId: string): Promise<VaultIndex> {
    return this.vaultIndex.get(serverId) ?? await this.vaultIndex.load(serverId);
  }

  // ---- Attached files ----

  /** Attaches a generated file (a drawn map or tree) and returns its token. */
  private addEmbeddedFile(state: TokenizeState, blob: Blob, filename: string): string {
    const tokenUrl = `broadcast-file://${crypto.randomUUID()}`;
    state.embeddedFiles.push({ tokenUrl, file: new File([blob], filename, { type: blob.type }) });
    return tokenUrl;
  }

  /** Attaches a vault file (once per broadcast) and returns its token, or null if it can't be read. */
  private async tokenizeFile(serverId: string, entry: VaultEntry, state: TokenizeState, filename = entry.name): Promise<string | null> {
    const cached = state.tokens.get(entry.relativePath);
    if (cached) return cached;
    try {
      const blob = await this.vaultService.readFileAsBlob(serverId, entry.relativePath);
      const type = blob.type || (isVaultFileType(entry.name, 'image') ? inferImageMimeType(entry.name) : '');
      const token = this.addEmbeddedFile(state, type === blob.type ? blob : new Blob([blob], { type }), filename);
      state.tokens.set(entry.relativePath, token);
      return token;
    } catch (error) {
      console.error(`[ObsidianBroadcast] Error reading file for broadcast: ${entry.relativePath}`, error);
      return null;
    }
  }

  /** Rewrites `![alt](url)` vault images to tokenized images. */
  private async tokenizeMarkdownImages(context: VaultBroadcastContext, content: string, state: TokenizeState): Promise<string> {
    return replaceAsync(content, /!\[(.*?)\]\(([^)]+)\)/g, async (_, alt: string, url: string) => {
      return `![${alt}](${await this.tokenizeImage(context, url.trim(), alt, state)})`;
    });
  }

  /**
   * Returns a `broadcast-file://` token for a vault image, or `fallback` (the original URL) if it
   * isn't one. `filename` names the attached file.
   */
  private async tokenizeImage(context: VaultBroadcastContext, url: string, filename: string, state: TokenizeState, fallback = url): Promise<string> {
    const searchPath = this.toVaultSearchPath(url);
    if (!searchPath) return fallback;

    const resolvedPath = await this.resolveVaultPath(context, searchPath);
    if (!resolvedPath || !isVaultFileType(resolvedPath, 'image')) {
      console.warn(`[ObsidianBroadcast] Could not resolve image path for broadcast: ${searchPath}`);
      return fallback;
    }

    const name = resolvedPath.split('/').pop() || 'image';
    const attachedName = filename?.trim() && !isEmbedSize(filename) && filename.trim() !== 'image' ? filename.trim() : name;
    const entry = { relativePath: resolvedPath, name } as VaultEntry;
    return await this.tokenizeFile(context.serverId, entry, state, attachedName) ?? fallback;
  }

  /**
   * Turns an image src/href into a vault-relative search path, or null for external resources.
   * Handles browser-prefixed origins, URL encoding, autolink angle brackets, and the editor's
   * `wikilink-blob:` / `file:///` markers.
   */
  private toVaultSearchPath(url: string): string | null {
    let value = url.trim().replace(ZERO_WIDTH, '');

    const origin = window.location.origin;
    if (value.startsWith(origin)) {
      value = value.substring(origin.length).replace(/^\/+/, '');
    }

    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }

    value = value.replace(/^<+|<+$/g, '').replace(/^>+|>+$/g, '');

    const marker = value.match(/(?:wikilink-blob:|file:\/\/\/)(.*)$/);
    if (marker) {
      return marker[1].split('|')[0].replace(/\\/g, '/') || null;
    }

    if (/^(https?:|blob:|data:|broadcast-file:)/i.test(value)) {
      return null;
    }

    return value.replace(/\\/g, '/') || null;
  }

  /** Resolves via the vault index, falling back to disk checks in case the index is stale. */
  private async resolveVaultPath(context: VaultBroadcastContext, searchPath: string): Promise<string | null> {
    const index = await this.index(context.serverId);
    const indexed = index.resolveFile(searchPath, context.currentFilePath) ?? findImage(index, searchPath, context.currentFilePath);
    if (indexed) return indexed.relativePath;

    const currentDir = context.currentFilePath.split('/').slice(0, -1).join('/');
    const candidates = [searchPath, this.vaultService.resolveRelativePath(currentDir, searchPath)];
    for (const candidate of candidates) {
      if (await this.vaultService.fileExists(context.serverId, candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...match: string[]) => Promise<string>
): Promise<string> {
  let output = '';
  let lastIndex = 0;

  for (const match of input.matchAll(pattern)) {
    output += input.slice(lastIndex, match.index);
    output += await replacer(...(match as unknown as string[]));
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  return output + input.slice(lastIndex);
}

/** A name usable as a file name. */
function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'broadcast';
}

/**
 * Replaces the editor's `[!type]` marker spans with a bold title, so players see "Read aloud" or
 * the callout's own title instead of the raw syntax.
 */
function formatCalloutElements(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(`.${CALLOUT_MARKER_CLASS}`).forEach(marker => {
    const line = marker.parentElement;
    const label = marker.closest('[data-callout-label]')?.getAttribute('data-callout-label')
      ?? resolveCalloutType(marker.textContent?.match(/\[!([\w-]+)\]/)?.[1] ?? 'note').label;
    marker.remove();
    if (!line) return;

    // The header is everything up to the first line break; the rest of the paragraph is body text.
    const title: Node[] = [];
    let rest: Node[] = [];
    const children = Array.from(line.childNodes);
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      // Milkdown renders soft line breaks as <span data-type="hardbreak">, hard ones as <br>.
      if (node.nodeName === 'BR' || (node instanceof HTMLElement && node.dataset['type'] === 'hardbreak')) {
        rest = children.slice(i + 1);
        break;
      }
      const newline = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').indexOf('\n') : -1;
      if (newline >= 0) {
        const text = node.textContent ?? '';
        title.push(document.createTextNode(text.slice(0, newline)));
        rest = [document.createTextNode(text.slice(newline + 1)), ...children.slice(i + 1)];
        break;
      }
      title.push(node);
    }

    const strong = document.createElement('strong');
    if (title.some(node => (node.textContent ?? '').trim())) {
      if (title[0]?.nodeType === Node.TEXT_NODE) {
        title[0].textContent = (title[0].textContent ?? '').trimStart();
      }
      strong.append(...title);
    } else {
      strong.textContent = label;
    }
    line.replaceChildren(strong, ...(rest.length ? [document.createElement('br'), ...rest] : []));
  });
}

const BLOCK_TAGS = /^(P|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|DIV|TABLE|TR)$/;

/** Plain text of a cloned selection, with one line per block when it spans several blocks. */
function selectionText(container: HTMLElement): string {
  const spansBlocks = Array.from(container.children).some(child => BLOCK_TAGS.test(child.tagName));
  if (!spansBlocks) return container.textContent ?? '';
  return Array.from(container.childNodes)
    .map(node => node.textContent ?? '')
    .filter(text => text.trim())
    .join('\n');
}

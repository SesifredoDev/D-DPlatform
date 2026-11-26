import { Injectable } from '@angular/core';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { isVaultFileType } from './vault-file-types';
import { BlockKind, findStatblocks } from './statblock';
import { mapLinksFromText } from './vault-map';
import { calendarLinksFromText } from './vault-calendar';
import { timelineLinksFromText } from './vault-timeline';
import { extractInlineDates } from './inline-dates';
import { PropertyType, PropertyValue, propertyTypeFromObsidian, readFrontmatterTags, readProperties, splitFrontmatter } from './frontmatter';

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * In-memory lookup tables for one vault: path/name lookups, link resolution and,
 * once notes are indexed, outgoing links, backlinks and tags.
 *
 * Built from the scanned tree in O(n); every lookup is a Map hit instead of a tree walk.
 */
export class VaultIndex {
  readonly files: VaultEntry[] = [];
  readonly folders: VaultEntry[] = [];

  private readonly byPath = new Map<string, VaultEntry>();
  private readonly byName = new Map<string, VaultEntry[]>();
  private readonly byBaseName = new Map<string, VaultEntry[]>();

  /** Raw link targets per note path (lower-cased path key). */
  private readonly outgoingLinks = new Map<string, string[]>();
  /** Per note: raw link target -> the lines of text it appears in. */
  private readonly linkSnippets = new Map<string, Map<string, string[]>>();
  private readonly tagsByNote = new Map<string, string[]>();
  private readonly propertiesByNote = new Map<string, IndexedProperty[]>();
  private readonly modifiedByNote = new Map<string, number>();
  /** Notes containing a ```statblock or ```item block, with the kind of their first one. */
  private readonly statblockNotes = new Map<string, BlockKind>();
  /** `[date:: …]` texts written in each note, in order. */
  private readonly datesByNote = new Map<string, string[]>();
  /** `source:` keys of each note's statblock blocks (e.g. `open5e/srd_goblin`), lower-cased. */
  private readonly sourcesByNote = new Map<string, string[]>();
  private backlinkCache: Map<string, Set<string>> | null = null;
  private version = 0;

  constructor(readonly entries: VaultEntry[]) {
    this.addEntries(entries);
  }

  /** Increments whenever indexed note content changes; use it to cache derived views. */
  get contentVersion(): number {
    return this.version;
  }

  get fileCount(): number {
    return this.files.length;
  }

  get folderCount(): number {
    return this.folders.length;
  }

  getByPath(path: string): VaultEntry | null {
    return this.byPath.get(normalizeKey(path)) ?? null;
  }

  getByName(name: string): VaultEntry | null {
    return pickPreferringFiles(this.byName.get(name.toLowerCase()));
  }

  getFileByBaseName(baseName: string): VaultEntry | null {
    return this.byBaseName.get(baseName.toLowerCase())?.[0] ?? null;
  }

  /**
   * Resolves an Obsidian-style link (`Note`, `folder/Note`, `../Note.md`, `Note#Heading`, `Note|Alias`)
   * the way Obsidian does: exact path, path relative to the linking note, file name, then base name.
   */
  resolveLink(rawLink: string, fromFilePath = ''): VaultEntry | null {
    const link = cleanLinkTarget(rawLink);
    if (!link) return null;

    const fromDir = fromFilePath.split('/').slice(0, -1).join('/');
    const relative = resolveRelativePath(fromDir, link);
    const fileName = link.split('/').pop()!;
    const baseName = fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;

    // Evaluated lazily, in priority order. A matching file wins over a folder of the same name.
    const lookups = [
      () => this.getByPath(link),
      () => this.getByPath(withMarkdownExtension(link)),
      () => this.getByPath(relative),
      () => this.getByPath(withMarkdownExtension(relative)),
      () => this.getByName(fileName),
      () => this.getByName(withMarkdownExtension(fileName)),
      () => this.getFileByBaseName(baseName),
    ];

    let folderMatch: VaultEntry | null = null;
    for (const lookup of lookups) {
      const entry = lookup();
      if (entry?.kind === 'file') return entry;
      folderMatch ??= entry;
    }
    return folderMatch;
  }

  /**
   * The shortest text that links to `entry` from anywhere in the vault, like Obsidian:
   * notes drop `.md`, and the folder path is only included when another file has the same name.
   */
  linkTextFor(entry: VaultEntry): string {
    const isMarkdown = /\.md$/i.test(entry.name);
    const strip = (value: string) => (isMarkdown ? value.slice(0, -3) : value);
    const sameName = (this.byName.get(entry.name.toLowerCase()) ?? []).filter(other => other.kind === 'file').length;
    return sameName <= 1 ? strip(entry.name) : strip(entry.relativePath);
  }

  /** Resolves an embed/attachment path to a file: exact path, relative path, then file name anywhere. */
  resolveFile(rawPath: string, fromFilePath = ''): VaultEntry | null {
    const path = rawPath.trim().replace(ZERO_WIDTH, '').replace(/\\/g, '/');
    if (!path) return null;

    const fromDir = fromFilePath.split('/').slice(0, -1).join('/');
    const candidates = [
      this.getByPath(path),
      this.getByPath(resolveRelativePath(fromDir, path)),
      this.getByName(path.split('/').pop()!),
    ];
    return candidates.find(entry => entry?.kind === 'file') ?? null;
  }

  /**
   * Records the links, tags and properties found in a note. Call when a note is read or saved.
   * `modified` (ms) is the file's last-modified time when known; otherwise the previous one is kept.
   */
  indexNoteContent(path: string, content: string, modified?: number): void {
    const key = normalizeKey(path);
    if (modified !== undefined) this.modifiedByNote.set(key, modified);
    const mentions = extractLinkMentions(content);
    const snippets = new Map<string, string[]>();
    for (const mention of mentions) {
      const list = snippets.get(mention.link) ?? [];
      if (mention.snippet && !list.includes(mention.snippet)) list.push(mention.snippet);
      snippets.set(mention.link, list);
    }

    this.outgoingLinks.set(key, Array.from(snippets.keys()));
    this.linkSnippets.set(key, snippets);
    this.tagsByNote.set(key, extractTags(content));
    this.propertiesByNote.set(key, extractProperties(content));
    const blocks = content.includes('```') || content.includes('~~~') ? findStatblocks(content) : [];
    if (blocks.length) this.statblockNotes.set(key, blocks[0].kind);
    else this.statblockNotes.delete(key);
    const dates = content.includes('[date::') ? extractInlineDates(content) : [];
    if (dates.length) this.datesByNote.set(key, dates);
    else this.datesByNote.delete(key);
    const sources = blocks.map(block => blockSourceKey(block.source)).filter((source): source is string => !!source);
    if (sources.length) this.sourcesByNote.set(key, sources);
    else this.sourcesByNote.delete(key);
    this.backlinkCache = null;
    this.version++;
  }

  /** True when the note contains a statblock or item (only known once the note has been indexed). */
  isStatblockNote(path: string): boolean {
    return this.statblockNotes.has(normalizeKey(path));
  }

  /**
   * The note holding a block imported from `sourceKey` (e.g. `open5e/srd_goblin`), if any. Only
   * covers notes indexed so far (see VaultIndexService.ensureContentIndexed).
   */
  findBySource(sourceKey: string): VaultEntry | null {
    const wanted = sourceKey.trim().toLowerCase();
    if (!wanted) return null;
    for (const [key, sources] of this.sourcesByNote) {
      if (sources.includes(wanted)) return this.byPath.get(key) ?? null;
    }
    return null;
  }

  /** What the note's first statblock block is (creature, item or spell), or null when it has none. */
  getStatblockKind(path: string): BlockKind | null {
    return this.statblockNotes.get(normalizeKey(path)) ?? null;
  }

  /**
   * Records the links of a map file (its pins and image), so notes pinned on a map list it in their
   * backlinks. Call when a map is read or saved.
   */
  indexMapContent(path: string, content: string, modified?: number): void {
    this.indexFileLinks(path, mapLinksFromText(content), modified);
  }

  /** Calendars (holidays → notes) and timelines (events → notes) link to notes too. */
  indexCalendarContent(path: string, content: string, modified?: number): void {
    this.indexFileLinks(path, calendarLinksFromText(content), modified);
  }

  indexTimelineContent(path: string, content: string, modified?: number): void {
    this.indexFileLinks(path, timelineLinksFromText(content), modified);
  }

  /** The `[date:: …]` texts written in a note, in order. */
  getInlineDates(path: string): readonly string[] {
    return this.datesByNote.get(normalizeKey(path)) ?? [];
  }

  /** Notes with `[date:: …]` texts. */
  notesWithInlineDates(): VaultEntry[] {
    return uniqueEntries(Array.from(this.datesByNote.keys(), key => this.byPath.get(key) ?? null));
  }

  /** Records the links of a JSON-based file (map, calendar, timeline) with their backlink snippets. */
  private indexFileLinks(path: string, links: { target: string; snippet: string }[], modified?: number): void {
    const key = normalizeKey(path);
    if (modified !== undefined) this.modifiedByNote.set(key, modified);
    const snippets = new Map<string, string[]>();
    for (const link of links) {
      const list = snippets.get(link.target) ?? [];
      if (!list.includes(link.snippet)) list.push(link.snippet);
      snippets.set(link.target, list);
    }
    this.outgoingLinks.set(key, Array.from(snippets.keys()));
    this.linkSnippets.set(key, snippets);
    this.backlinkCache = null;
    this.version++;
  }

  isNoteIndexed(path: string): boolean {
    return this.outgoingLinks.has(normalizeKey(path));
  }

  /** Link targets as written in a note (including ones that don't resolve to a file). */
  getLinkTargets(path: string): readonly string[] {
    return this.outgoingLinks.get(normalizeKey(path)) ?? [];
  }

  getOutgoingLinks(path: string): VaultEntry[] {
    const links = this.outgoingLinks.get(normalizeKey(path)) ?? [];
    return uniqueEntries(links.map(link => this.resolveLink(link, path)));
  }

  /** Notes that link to `path`. Only covers notes indexed so far (see VaultIndexService.ensureContentIndexed). */
  getBacklinks(path: string): VaultEntry[] {
    if (!this.backlinkCache) {
      this.backlinkCache = new Map();
      for (const [sourceKey, links] of this.outgoingLinks) {
        const source = this.byPath.get(sourceKey);
        if (!source) continue;
        for (const link of links) {
          const target = this.resolveLink(link, source.relativePath);
          if (!target || target === source) continue;
          const targetKey = normalizeKey(target.relativePath);
          if (!this.backlinkCache.has(targetKey)) this.backlinkCache.set(targetKey, new Set());
          this.backlinkCache.get(targetKey)!.add(sourceKey);
        }
      }
    }

    const sources = this.backlinkCache.get(normalizeKey(path)) ?? new Set<string>();
    return uniqueEntries(Array.from(sources, key => this.byPath.get(key) ?? null));
  }

  /**
   * Notes linking to `path`, each with the lines where the link appears.
   * Only covers notes indexed so far (see VaultIndexService.ensureContentIndexed).
   */
  getBacklinkMentions(path: string): BacklinkMention[] {
    const target = this.getByPath(path);
    if (!target) return [];

    return this.getBacklinks(path)
      .map(source => {
        const snippets = this.linkSnippets.get(normalizeKey(source.relativePath)) ?? new Map<string, string[]>();
        const lines: string[] = [];
        for (const [link, linkLines] of snippets) {
          if (this.resolveLink(link, source.relativePath) === target) {
            linkLines.forEach(line => lines.includes(line) || lines.push(line));
          }
        }
        return { source, snippets: lines };
      })
      .sort((a, b) => a.source.name.localeCompare(b.source.name));
  }

  getTags(path: string): string[] {
    return this.tagsByNote.get(normalizeKey(path)) ?? [];
  }

  /** All tags across indexed notes with their note counts, most used first. */
  getAllTags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const tags of this.tagsByNote.values()) {
      tags.forEach(tag => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  getNotesWithTag(tag: string): VaultEntry[] {
    const wanted = tag.replace(/^#/, '').toLowerCase();
    const keys = Array.from(this.tagsByNote)
      .filter(([, tags]) => tags.some(t => t === wanted || t.startsWith(`${wanted}/`)))
      .map(([key]) => key);
    return uniqueEntries(keys.map(key => this.byPath.get(key) ?? null));
  }

  /** When the note was last modified (ms), if known. */
  getModified(path: string): number | null {
    return this.modifiedByNote.get(normalizeKey(path)) ?? null;
  }

  /** A note's frontmatter properties (as of its last indexing). */
  getProperties(path: string): IndexedProperty[] {
    return this.propertiesByNote.get(normalizeKey(path)) ?? [];
  }

  /**
   * Every property key used in the vault, most used first. Keys are grouped case-insensitively
   * (like Obsidian); each gets its most common spelling and the most common type of its values.
   */
  getPropertyKeys(): PropertyKeySummary[] {
    const groups = new Map<string, { spellings: Map<string, number>; types: Map<PropertyType, number>; count: number }>();
    for (const properties of this.propertiesByNote.values()) {
      for (const property of properties) {
        const id = property.key.toLowerCase();
        const group = groups.get(id) ?? { spellings: new Map(), types: new Map(), count: 0 };
        group.count++;
        group.spellings.set(property.key, (group.spellings.get(property.key) ?? 0) + 1);
        if (!property.empty && property.type !== 'complex') {
          group.types.set(property.type, (group.types.get(property.type) ?? 0) + 1);
        }
        groups.set(id, group);
      }
    }
    return Array.from(groups.values(), group => ({
      key: mostCommon(group.spellings) ?? '',
      type: mostCommon(group.types),
      count: group.count,
    })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** Values used for a property across the vault (list items included), most used first. */
  getPropertyValues(key: string): { value: string; count: number }[] {
    const wanted = key.toLowerCase();
    const counts = new Map<string, { value: string; count: number }>();
    for (const properties of this.propertiesByNote.values()) {
      for (const property of properties) {
        if (property.key.toLowerCase() !== wanted) continue;
        for (const value of property.values) {
          const id = value.toLowerCase();
          const item = counts.get(id) ?? { value, count: 0 };
          item.count++;
          counts.set(id, item);
        }
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  /** Carries already-indexed note content over to a rebuilt index (paths that no longer exist are dropped). */
  copyContentIndexTo(next: VaultIndex): void {
    for (const [key, links] of this.outgoingLinks) {
      if (next.byPath.has(key)) next.outgoingLinks.set(key, links);
    }
    for (const [key, snippets] of this.linkSnippets) {
      if (next.byPath.has(key)) next.linkSnippets.set(key, snippets);
    }
    for (const [key, tags] of this.tagsByNote) {
      if (next.byPath.has(key)) next.tagsByNote.set(key, tags);
    }
    for (const [key, properties] of this.propertiesByNote) {
      if (next.byPath.has(key)) next.propertiesByNote.set(key, properties);
    }
    for (const [key, modified] of this.modifiedByNote) {
      if (next.byPath.has(key)) next.modifiedByNote.set(key, modified);
    }
    for (const [key, kind] of this.statblockNotes) {
      if (next.byPath.has(key)) next.statblockNotes.set(key, kind);
    }
    for (const [key, sources] of this.sourcesByNote) {
      if (next.byPath.has(key)) next.sourcesByNote.set(key, sources);
    }
    for (const [key, dates] of this.datesByNote) {
      if (next.byPath.has(key)) next.datesByNote.set(key, dates);
    }
  }

  private addEntries(entries: VaultEntry[]): void {
    for (const entry of entries) {
      this.byPath.set(normalizeKey(entry.relativePath), entry);
      pushTo(this.byName, entry.name.toLowerCase(), entry);

      if (entry.kind === 'file') {
        this.files.push(entry);
        const baseName = entry.name.includes('.') ? entry.name.substring(0, entry.name.lastIndexOf('.')) : entry.name;
        pushTo(this.byBaseName, baseName.toLowerCase(), entry);
      } else {
        this.folders.push(entry);
        this.addEntries(entry.children ?? []);
      }
    }
  }
}

/** Holds one VaultIndex per server and keeps note content (links/tags) indexed. */
@Injectable({
  providedIn: 'root',
})
export class VaultIndexService {
  private readonly indexes = new Map<string, VaultIndex>();
  private readonly contentIndexing = new Map<string, Promise<void>>();
  private readonly propertyTypes = new Map<string, Promise<PropertyTypeMap>>();
  private readonly graphGroups = new Map<string, Promise<GraphColorGroup[] | null>>();

  constructor(private vaultService: ObsidianVaultService) {}

  /** Rebuilds the index for a freshly scanned tree, keeping content already indexed. */
  rebuild(serverId: string, entries: VaultEntry[]): VaultIndex {
    const next = new VaultIndex(entries);
    this.indexes.get(serverId)?.copyContentIndexTo(next);
    this.indexes.set(serverId, next);
    return next;
  }

  get(serverId: string): VaultIndex | null {
    return this.indexes.get(serverId) ?? null;
  }

  /** Loads (from cache if possible) and indexes the vault tree. */
  async load(serverId: string, useCache = true): Promise<VaultIndex> {
    const entries = await this.vaultService.listVaultFiles(serverId, useCache);
    const existing = this.indexes.get(serverId);
    return existing && existing.entries === entries ? existing : this.rebuild(serverId, entries);
  }

  /**
   * Property types assigned in Obsidian (`.obsidian/types.json`), keyed by lower-cased property name.
   * Empty if the vault has none or it can't be read. Cached per server; pass `force` to re-read.
   */
  getPropertyTypes(serverId: string, options: { force?: boolean } = {}): Promise<PropertyTypeMap> {
    const cached = this.propertyTypes.get(serverId);
    if (cached && !options.force) return cached;

    const load = this.vaultService.readFile(serverId, '.obsidian/types.json')
      .then(text => parsePropertyTypes(text))
      .catch(() => ({}));
    this.propertyTypes.set(serverId, load);
    return load;
  }

  /**
   * Colour groups from Obsidian's graph settings (`.obsidian/graph.json`), or null if the vault has
   * none (or they can't be read). Cached per server; pass `force` to re-read.
   */
  getGraphColorGroups(serverId: string, options: { force?: boolean } = {}): Promise<GraphColorGroup[] | null> {
    const cached = this.graphGroups.get(serverId);
    if (cached && !options.force) return cached;

    const load = this.vaultService.readFile(serverId, '.obsidian/graph.json')
      .then(text => parseGraphColorGroups(text))
      .catch(() => null);
    this.graphGroups.set(serverId, load);
    return load;
  }

  indexNoteContent(serverId: string, path: string, content: string, modified?: number): void {
    if (isVaultFileType(path, 'markdown')) {
      this.indexes.get(serverId)?.indexNoteContent(path, content, modified);
    } else if (isVaultFileType(path, 'map')) {
      this.indexes.get(serverId)?.indexMapContent(path, content, modified);
    } else if (isVaultFileType(path, 'calendar')) {
      this.indexes.get(serverId)?.indexCalendarContent(path, content, modified);
    } else if (isVaultFileType(path, 'timeline')) {
      this.indexes.get(serverId)?.indexTimelineContent(path, content, modified);
    }
  }

  /**
   * Reads and indexes every markdown note not indexed yet. Needed before backlinks/tag queries
   * cover the whole vault. Safe to call repeatedly; concurrent calls share one run.
   */
  ensureContentIndexed(serverId: string, options: { force?: boolean } = {}): Promise<void> {
    const running = this.contentIndexing.get(serverId);
    if (running) return options.force ? running.then(() => this.ensureContentIndexed(serverId, options)) : running;

    const run = (async () => {
      const index = this.indexes.get(serverId) ?? await this.load(serverId);
      // Notes, and maps (their pins are links too).
      const pending = index.files.filter(file =>
        LINKING_TYPES.some(type => isVaultFileType(file.name, type)) &&
        (options.force || !index.isNoteIndexed(file.relativePath))
      );

      const batchSize = 16;
      for (let i = 0; i < pending.length; i += batchSize) {
        await Promise.all(pending.slice(i, i + batchSize).map(async file => {
          try {
            const { content, lastModified } = await this.vaultService.readFileWithMeta(serverId, file.relativePath);
            if (isVaultFileType(file.name, 'map')) index.indexMapContent(file.relativePath, content, lastModified);
            else if (isVaultFileType(file.name, 'calendar')) index.indexCalendarContent(file.relativePath, content, lastModified);
            else if (isVaultFileType(file.name, 'timeline')) index.indexTimelineContent(file.relativePath, content, lastModified);
            else index.indexNoteContent(file.relativePath, content, lastModified);
          } catch (error) {
            console.warn('[VaultIndex] Failed to index note', file.relativePath, error);
          }
        }));
      }
    })().finally(() => this.contentIndexing.delete(serverId));

    this.contentIndexing.set(serverId, run);
    return run;
  }
}

/** A block's `source:` value (lower-cased), read without parsing the whole YAML. */
function blockSourceKey(source: string): string | null {
  const match = source.match(/^source:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/m);
  return match ? match[1].trim().toLowerCase() : null;
}

/** File types whose content links to other files (read when the vault is indexed). */
const LINKING_TYPES = ['markdown', 'map', 'calendar', 'timeline'];

function normalizeKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function cleanLinkTarget(link: string): string {
  return link
    .replace(ZERO_WIDTH, '')
    .split('|')[0]
    .split('#')[0]
    .trim()
    .replace(/\\/g, '/');
}

function withMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
}

function resolveRelativePath(basePath: string, targetPath: string): string {
  const resolved = basePath.split('/').filter(Boolean);
  for (const part of targetPath.split('/').filter(Boolean)) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}

function pushTo(map: Map<string, VaultEntry[]>, key: string, entry: VaultEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

function pickPreferringFiles(entries: VaultEntry[] | undefined): VaultEntry | null {
  if (!entries?.length) return null;
  return entries.find(entry => entry.kind === 'file') ?? entries[0];
}

function uniqueEntries(entries: (VaultEntry | null)[]): VaultEntry[] {
  return Array.from(new Set(entries.filter((entry): entry is VaultEntry => !!entry)));
}

function stripCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** A frontmatter property as kept in the index: enough for suggestions and (later) database views. */
export interface IndexedProperty {
  key: string;
  type: PropertyType;
  empty: boolean;
  /** Scalar value, or list items; empty for complex values. */
  values: string[];
}

export interface PropertyKeySummary {
  key: string;
  /** Most common type of the key's non-empty values; null if it's always empty or complex. */
  type: PropertyType | null;
  /** Number of notes using the key. */
  count: number;
}

/** Frontmatter properties of a note, without `tags` (indexed separately). */
export function extractProperties(content: string): IndexedProperty[] {
  return readProperties(content)
    .filter(property => !/^tags?$/i.test(property.key))
    .map(property => ({
      key: property.key,
      type: property.type,
      empty: property.empty,
      values: property.type === 'list' ? property.items : property.type === 'complex' || property.empty ? [] : [property.value],
    }));
}

export type PropertyTypeMap = Record<string, PropertyValue['type']>;

/** A graph colour group: notes matching `query` (Obsidian search syntax) get `color`. */
export interface GraphColorGroup {
  query: string;
  /** CSS colour, e.g. '#e03e3e'. */
  color: string;
}

/** Parses the `colorGroups` of Obsidian's `graph.json`; null if there are none. */
export function parseGraphColorGroups(text: string): GraphColorGroup[] | null {
  try {
    const groups = JSON.parse(text)?.colorGroups;
    if (!Array.isArray(groups)) return null;
    const result = groups
      .filter(group => typeof group?.query === 'string' && group.query.trim() && typeof group?.color?.rgb === 'number')
      .map(group => ({ query: group.query.trim(), color: `#${(group.color.rgb >>> 0).toString(16).padStart(6, '0').slice(-6)}` }));
    return result.length ? result : null;
  } catch {
    return null;
  }
}

/** Parses Obsidian's `types.json` (`{"types": {"status": "text", ...}}`). */
export function parsePropertyTypes(text: string): PropertyTypeMap {
  const result: PropertyTypeMap = {};
  try {
    const types = JSON.parse(text)?.types;
    if (types && typeof types === 'object') {
      for (const [key, name] of Object.entries(types)) {
        const type = propertyTypeFromObsidian(name);
        if (type) result[key.toLowerCase()] = type;
      }
    }
  } catch {
    // Not valid JSON: treat as no types.
  }
  return result;
}

function mostCommon<T>(counts: Map<T, number>): T | null {
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export interface BacklinkMention {
  source: VaultEntry;
  /** Cleaned-up lines from the source note where the link appears. */
  snippets: string[];
}

/** Wikilinks/embeds (`[[Note]]`, `![[img.png]]`) and relative markdown links (`[x](Note.md)`). */
export function extractLinks(content: string): string[] {
  return Array.from(new Set(extractLinkMentions(content).map(mention => mention.link)));
}

/** Every link in a note, with a readable snippet of the line it appears in. */
export function extractLinkMentions(content: string): { link: string; snippet: string }[] {
  const mentions: { link: string; snippet: string }[] = [];

  for (const line of stripCode(content).split(/\r?\n/)) {
    for (const match of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
      pushMention(mentions, match[1], line, match.index ?? 0, match[0].startsWith('!'));
    }
    // [text](target), [text](<target with spaces>) and their ![image] forms
    for (const match of line.matchAll(/!?\[[^\]]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)) {
      let target = match[1] ?? match[2];
      // Notes saved by older app versions wrote wikilinks as [x](wikilink:Note) / ![x](wikilink-blob:img.png).
      const legacy = target.match(/^wikilink(?:-blob)?:(.+)$/);
      if (legacy) {
        target = legacy[1];
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
        continue;
      }
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // keep raw target
      }
      pushMention(mentions, decoded, line, match.index ?? 0, match[0].startsWith('!'));
    }
  }

  return mentions;
}

function pushMention(
  mentions: { link: string; snippet: string }[],
  rawLink: string,
  line: string,
  index: number,
  isEmbed: boolean
): void {
  const link = rawLink.trim();
  if (!link) return;
  mentions.push({ link, snippet: isEmbed ? '' : buildSnippet(line, index) });
}

const SNIPPET_RADIUS = 70;

/** Plain-text version of a Markdown line, trimmed around the link position. */
function buildSnippet(line: string, linkIndex: number): string {
  const marker = '\u0000';
  const withMarker = `${line.slice(0, linkIndex)}${marker}${line.slice(linkIndex)}`;
  const plain = withMarker
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => target.split('#')[0])
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const at = Math.max(0, plain.indexOf(marker));
  const text = plain.replace(marker, '');
  if (text.length <= SNIPPET_RADIUS * 2) return text;

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Inline `#tags` (outside code) plus `tags:` frontmatter, lower-cased, without the leading '#'. */
export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  readFrontmatterTags(content).forEach(tag => addTag(tags, tag));
  extractInlineTags(content).forEach(tag => addTag(tags, tag));
  return Array.from(tags);
}

/** `#tags` written in the note body (outside code), lower-cased, without '#'. Excludes frontmatter tags. */
export function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const body = stripCode(splitFrontmatter(content).body);
  // `\#tag` is how older app versions saved a tag at the start of a line.
  for (const match of body.matchAll(/(?:^|[\s(])\\?#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
    addTag(tags, match[1]);
  }
  return Array.from(tags);
}

function addTag(tags: Set<string>, raw: string): void {
  const tag = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').toLowerCase();
  if (tag) tags.add(tag);
}

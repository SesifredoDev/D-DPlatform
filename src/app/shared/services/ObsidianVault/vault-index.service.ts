import { Injectable } from '@angular/core';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { isVaultFileType } from './vault-file-types';
import { readFrontmatterTags, splitFrontmatter } from './frontmatter';

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

  /** Records the links and tags found in a note. Call when a note is read or saved. */
  indexNoteContent(path: string, content: string): void {
    const key = normalizeKey(path);
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
    this.backlinkCache = null;
    this.version++;
  }

  isNoteIndexed(path: string): boolean {
    return this.outgoingLinks.has(normalizeKey(path));
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

  indexNoteContent(serverId: string, path: string, content: string): void {
    if (isVaultFileType(path, 'markdown')) {
      this.indexes.get(serverId)?.indexNoteContent(path, content);
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
      const pending = index.files.filter(file =>
        isVaultFileType(file.name, 'markdown') && (options.force || !index.isNoteIndexed(file.relativePath))
      );

      const batchSize = 16;
      for (let i = 0; i < pending.length; i += batchSize) {
        await Promise.all(pending.slice(i, i + batchSize).map(async file => {
          try {
            index.indexNoteContent(file.relativePath, await this.vaultService.readFile(serverId, file.relativePath));
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

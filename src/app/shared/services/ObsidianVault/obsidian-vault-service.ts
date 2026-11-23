import { Injectable } from '@angular/core';
import { IServer } from '../../models/server/server.model';
import { ChannelType, IChannel } from '../../models/server/channel.model';
import { get, set } from 'idb-keyval';
import type { VaultEntry, VaultSearchResult } from '../../models/ObsidianVault/obsidian-vault-service.model';
export type { VaultEntry, VaultSearchResult } from '../../models/ObsidianVault/obsidian-vault-service.model';

type VaultPermissionMode = 'read' | 'readwrite';

export interface VaultFileText {
  content: string;
  /** File's lastModified timestamp when it was read; pass back to writeFile to detect external edits. */
  lastModified: number;
}

export interface VaultWriteOptions {
  /**
   * When set, the write is refused with VaultConflictError if the file on disk was modified
   * after this timestamp (e.g. edited in Obsidian while open here).
   */
  expectedLastModified?: number;
}

export class VaultConflictError extends Error {
  constructor(readonly relativePath: string, readonly diskLastModified: number) {
    super(`File changed on disk: ${relativePath}`);
    this.name = 'VaultConflictError';
  }
}

@Injectable({
  providedIn: 'root',
})
export class ObsidianVaultService {
  private readonly STORAGE_KEY_PREFIX = 'obsidian_handle_';
  private readonly LOCALHOST_ROUTE_STORAGE_KEY_PREFIX = 'obsidian_localhost_route_';

  private vaultCache: Map<string, VaultEntry[]> = new Map();
  private readonly fileTextCache = new Map<string, string>();
  /** In-memory copy of the IndexedDB-stored root handles, so each file read doesn't hit IndexedDB. */
  private readonly handleCache = new Map<string, FileSystemDirectoryHandle>();

  constructor() {}

  isFileSystemApiSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }

  async attachVaultToServer(serverId: string, startIn?: FileSystemHandle): Promise<string> {
    if (!this.isFileSystemApiSupported()) {
      throw new Error('File System Access API is not supported in this browser.');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
        ...(startIn ? { startIn } : {}),
      });
      await set(`${this.STORAGE_KEY_PREFIX}${serverId}`, handle);
      localStorage.setItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`, 'true');
      this.handleCache.set(serverId, handle);
      this.invalidateServerCaches(serverId);
      return handle.name;
    } catch (err) {
      console.error('User cancelled or browser blocked folder access', err);
      throw err;
    }
  }

  async getVaultHandle(serverId: string): Promise<FileSystemDirectoryHandle | null> {
    const cached = this.handleCache.get(serverId);
    if (cached) return cached;

    const handle = (await get(`${this.STORAGE_KEY_PREFIX}${serverId}`)) as FileSystemDirectoryHandle | undefined;
    if (handle) {
      this.handleCache.set(serverId, handle);
    }
    return handle || null;
  }

  async requestPermission(
    handle: FileSystemHandle,
    mode: VaultPermissionMode = 'readwrite'
  ): Promise<boolean> {
    const options = { mode };
    return (await (handle as any).requestPermission(options)) === 'granted';
  }

  async hasPermission(
    serverId: string,
    mode: VaultPermissionMode = 'readwrite'
  ): Promise<boolean> {
    const handle = await this.getVaultHandle(serverId);
    if (!handle) return false;

    const options = { mode };
    if (typeof (handle as any).queryPermission !== 'function') {
      return true;
    }

    return (await (handle as any).queryPermission(options)) === 'granted';
  }

  async listVaultFiles(serverId: string, useCache = true): Promise<VaultEntry[]> {
    if (useCache && this.vaultCache.has(serverId) && this.vaultCache.get(serverId)!.length > 0) {
      return this.vaultCache.get(serverId)!;
    }

    const handle = await this.getVaultHandle(serverId);
    if (!handle) return [];

    const entries = await this.scanDirectory(handle);
    this.vaultCache.set(serverId, entries);
    return entries;
  }

  private async scanDirectory(directoryHandle: FileSystemDirectoryHandle, path = ''): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = [];
    try {
        for await (const entry of (directoryHandle as any).values()) {
          const relativePath = path ? `${path}/${entry.name}` : entry.name;
          if (entry.name.startsWith('.')) continue;

          const vaultEntry: VaultEntry = {
            name: entry.name,
            kind: entry.kind,
            handle: entry,
            relativePath: relativePath,
            parentPath: path
          };

          if (entry.kind === 'directory') {
            vaultEntry.children = await this.scanDirectory(entry, relativePath);
          }
          entries.push(vaultEntry);
        }
    } catch (e) {
        console.error("Error scanning directory", path, e);
    }

    return entries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'directory' ? -1 : 1;
    });
  }

  resolveRelativePath(basePath: string, targetPath: string): string {
    const baseParts = basePath.split(/[/\\]/).filter(p => p !== '');
    const targetParts = targetPath.split(/[/\\]/).filter(p => p !== '');
    const resolvedParts: string[] = [...baseParts];

    for (const part of targetParts) {
      if (part === '..') {
        resolvedParts.pop();
      } else if (part !== '.') {
        resolvedParts.push(part);
      }
    }
    return resolvedParts.join('/');
  }

  async findFileByFilename(serverId: string, filename: string): Promise<string | null> {
    // If cache is empty, try to list files once
    let vaultEntries = await this.listVaultFiles(serverId);

    const lowerFilename = filename.toLowerCase();
    const search = (entries: VaultEntry[]): string | null => {
      for (const entry of entries) {
        if (entry.kind === 'file' && entry.name.toLowerCase() === lowerFilename) {
          return entry.relativePath;
        }
        if (entry.kind === 'directory' && entry.children) {
          const found = search(entry.children);
          if (found) return found;
        }
      }
      return null;
    };

    return search(vaultEntries);
  }

  async readFile(serverId: string, relativePath: string): Promise<string> {
    const blob = await this.readFileAsBlob(serverId, relativePath);
    return await blob.text();
  }

  async readFileWithMeta(serverId: string, relativePath: string): Promise<VaultFileText> {
    const file = await this.readFileAsBlob(serverId, relativePath);
    return { content: await file.text(), lastModified: file.lastModified };
  }

  async readFileAsBlob(serverId: string, relativePath: string): Promise<File> {
    const rootHandle = await this.requireVaultHandle(serverId);
    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    return await fileHandle.getFile();
  }

  /** Returns true when a file exists at the path. Cheaper than reading it as a probe. */
  async fileExists(serverId: string, relativePath: string): Promise<boolean> {
    try {
      const rootHandle = await this.requireVaultHandle(serverId);
      await this.getFileHandleByPath(rootHandle, relativePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes text or binary content. Returns the file's new lastModified timestamp.
   * The cached file tree is only invalidated when the write creates a new file.
   */
  async writeFile(
    serverId: string,
    relativePath: string,
    content: string | Blob,
    options: VaultWriteOptions = {}
  ): Promise<number> {
    const rootHandle = await this.requireVaultHandle(serverId);

    let fileHandle: FileSystemFileHandle;
    let created = false;
    try {
      fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    } catch {
      fileHandle = await this.getFileHandleByPath(rootHandle, relativePath, true);
      created = true;
    }

    if (!created && options.expectedLastModified !== undefined) {
      const diskLastModified = (await fileHandle.getFile()).lastModified;
      if (diskLastModified > options.expectedLastModified) {
        throw new VaultConflictError(relativePath, diskLastModified);
      }
    }

    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    if (created) {
      this.vaultCache.delete(serverId);
    }
    this.fileTextCache.delete(this.fileCacheKey(serverId, relativePath));
    return (await fileHandle.getFile()).lastModified;
  }

  async createFolder(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.requireVaultHandle(serverId);

    const parts = this.splitPath(relativePath).filter(part => part.trim() !== '');
    if (parts.length === 0) throw new Error('Invalid folder path');

    await this.getDirectoryByParts(rootHandle, parts, true);
    this.vaultCache.delete(serverId);
  }

  async renameFile(serverId: string, oldPath: string, newName: string): Promise<string> {
    const rootHandle = await this.requireVaultHandle(serverId);

    const parentParts = this.splitPath(oldPath);
    const oldName = parentParts.pop()!;
    const parentDir = await this.getDirectoryByParts(rootHandle, parentParts);
    const newPath = parentParts.length > 0 ? `${parentParts.join('/')}/${newName}` : newName;

    if (newName === oldName) return oldPath;
    // Case-only renames are the same entry on case-insensitive file systems.
    if (newName.toLowerCase() !== oldName.toLowerCase() && await this.childExists(parentDir, newName)) {
      throw new Error(`An entry named "${newName}" already exists.`);
    }

    const fileHandle = await parentDir.getFileHandle(oldName);
    if (typeof (fileHandle as any).move === 'function') {
      await (fileHandle as any).move(newName);
    } else {
      await this.copyHandle(fileHandle, parentDir, newName);
      await parentDir.removeEntry(oldName);
    }

    this.invalidateServerCaches(serverId);
    return newPath;
  }

  /** Moves a file or folder into targetDirectoryPath ('' = vault root). Returns the new relative path. */
  async moveEntry(serverId: string, entryPath: string, targetDirectoryPath: string): Promise<string> {
    const rootHandle = await this.requireVaultHandle(serverId);

    const sourceParts = this.splitPath(entryPath);
    const entryName = sourceParts.pop()!;
    const sourceDir = await this.getDirectoryByParts(rootHandle, sourceParts);
    const targetDir = await this.getDirectoryByParts(rootHandle, this.splitPath(targetDirectoryPath));
    const newRelativePath = targetDirectoryPath ? `${targetDirectoryPath}/${entryName}` : entryName;

    if (await this.childExists(targetDir, entryName)) {
      throw new Error(`An entry named "${entryName}" already exists in the target folder.`);
    }

    const handle = await this.getChildHandle(sourceDir, entryName);
    if (handle.kind === 'file' && typeof (handle as any).move === 'function') {
      await (handle as any).move(targetDir, entryName);
    } else {
      // Directory moves (and browsers without move()) fall back to copy + delete, preserving bytes.
      await this.copyHandle(handle, targetDir, entryName);
      await sourceDir.removeEntry(entryName, { recursive: true });
    }

    this.invalidateServerCaches(serverId);
    return newRelativePath;
  }

  async deleteEntry(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.requireVaultHandle(serverId);

    const parts = this.splitPath(relativePath);
    const name = parts.pop()!;
    const parentDir = await this.getDirectoryByParts(rootHandle, parts);

    await parentDir.removeEntry(name, { recursive: true });
    this.invalidateServerCaches(serverId);
  }

  private async requireVaultHandle(serverId: string): Promise<FileSystemDirectoryHandle> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');
    return rootHandle;
  }

  private splitPath(path: string): string[] {
    return path.split(/[/\\]/).filter(p => p !== '');
  }

  private async getDirectoryByParts(
    root: FileSystemDirectoryHandle,
    parts: string[],
    create = false
  ): Promise<FileSystemDirectoryHandle> {
    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create });
    }
    return currentDir;
  }

  private async getChildHandle(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemHandle> {
    try {
      return await dir.getFileHandle(name);
    } catch {
      return await dir.getDirectoryHandle(name);
    }
  }

  private async childExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    try {
      await this.getChildHandle(dir, name);
      return true;
    } catch {
      return false;
    }
  }

  /** Recursively copies a file or directory handle into targetDir under `name`, byte-for-byte. */
  private async copyHandle(source: FileSystemHandle, targetDir: FileSystemDirectoryHandle, name: string): Promise<void> {
    if (source.kind === 'file') {
      const file = await (source as FileSystemFileHandle).getFile();
      const targetFile = await targetDir.getFileHandle(name, { create: true });
      const writable = await targetFile.createWritable();
      await writable.write(file);
      await writable.close();
      return;
    }

    const newDir = await targetDir.getDirectoryHandle(name, { create: true });
    for await (const child of (source as any).values() as AsyncIterable<FileSystemHandle>) {
      await this.copyHandle(child, newDir, child.name);
    }
  }

  private invalidateServerCaches(serverId: string): void {
    this.vaultCache.delete(serverId);
    const prefix = this.fileCacheKey(serverId, '');
    for (const key of Array.from(this.fileTextCache.keys())) {
      if (key.startsWith(prefix)) {
        this.fileTextCache.delete(key);
      }
    }
  }

  async searchVault(serverId: string, query: string, limit = 30): Promise<VaultSearchResult[]> {
    const normalizedQuery = this.normalizeSearchText(query);
    const terms = normalizedQuery.split(' ').filter(Boolean);

    if (terms.length === 0 || !this.hasVaultAttached(serverId) || !(await this.hasPermission(serverId, 'read'))) {
      return [];
    }

    const entries = await this.listVaultFiles(serverId);
    const files = this.flattenEntries(entries).filter(entry => entry.kind === 'file');
    const results: VaultSearchResult[] = [];

    for (const file of files) {
      const name = this.normalizeSearchText(file.name);
      const path = this.normalizeSearchText(file.relativePath);
      const titleMatch = terms.every(term => name.includes(term));
      const pathMatch = !titleMatch && terms.every(term => path.includes(term));

      let content = '';
      let contentMatch = false;
      if (this.isSearchableTextFile(file.name)) {
        content = await this.readCachedText(serverId, file.relativePath);
        const normalizedContent = this.normalizeSearchText(content);
        contentMatch = terms.every(term => normalizedContent.includes(term));
      }

      if (!titleMatch && !pathMatch && !contentMatch) {
        continue;
      }

      results.push({
        serverId,
        name: file.name,
        relativePath: file.relativePath,
        snippet: contentMatch ? this.buildSnippet(content, terms) : file.relativePath,
        matchType: titleMatch ? 'title' : pathMatch ? 'path' : 'content',
        score: this.scoreVaultMatch(file, normalizedQuery, terms, { titleMatch, pathMatch, contentMatch }),
      });
    }

    return results
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, limit);
  }

  getObsidianCanvasTemplate(): string {
    return JSON.stringify({ nodes: [], edges: [] }, null, 2);
  }

  private async getFileHandleByPath(
    root: FileSystemDirectoryHandle,
    path: string,
    create = false
  ): Promise<FileSystemFileHandle> {
    const parts = path.split(/[/\\]/).filter(p => p !== '');
    const fileName = parts.pop();

    if (!fileName) throw new Error("Invalid path: no filename found");

    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create });
    }

    return await currentDir.getFileHandle(fileName, { create });
  }

  setVaultLocalhostRoute(serverId: string, route: string): void {
    localStorage.setItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`, route);
  }

  getVaultLocalhostRoute(serverId: string): string | null {
    return localStorage.getItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`);
  }

  isOwner(server: IServer, currentUserId: string): boolean {
    return server.owner === currentUserId;
  }

  getObsidianChannel(serverId: string): IChannel {
    return {
      _id: `obsidian-${serverId}`,
      name: 'obsidian-vault',
      type: ChannelType.Obsidian,
      icon: 'book',
      server: serverId
    };
  }

  hasVaultAttached(serverId: string): boolean {
    return !!localStorage.getItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`) ||
           !!localStorage.getItem(`${this.LOCALHOST_ROUTE_STORAGE_KEY_PREFIX}${serverId}`);
  }

  private flattenEntries(entries: VaultEntry[]): VaultEntry[] {
    return entries.flatMap(entry => [
      entry,
      ...(entry.children ? this.flattenEntries(entry.children) : []),
    ]);
  }

  private async readCachedText(serverId: string, relativePath: string): Promise<string> {
    const cacheKey = this.fileCacheKey(serverId, relativePath);
    const cached = this.fileTextCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const text = await this.readFile(serverId, relativePath);
      this.fileTextCache.set(cacheKey, text);
      return text;
    } catch (error) {
      console.warn('Failed to read vault file for search', relativePath, error);
      return '';
    }
  }

  private scoreVaultMatch(
    entry: VaultEntry,
    normalizedQuery: string,
    terms: string[],
    matches: { titleMatch: boolean; pathMatch: boolean; contentMatch: boolean }
  ): number {
    const name = this.normalizeSearchText(entry.name);
    const baseName = this.normalizeSearchText(entry.name.replace(/\.[^.]+$/, ''));
    const path = this.normalizeSearchText(entry.relativePath);

    let score = 0;
    if (baseName === normalizedQuery || name === normalizedQuery) score += 140;
    if (baseName.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) score += 90;
    if (matches.titleMatch) score += 65;
    if (matches.pathMatch) score += 35;
    if (matches.contentMatch) score += 20;
    score += terms.filter(term => path.includes(term)).length * 3;
    return score;
  }

  private buildSnippet(content: string, terms: string[]): string {
    const compact = content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[\[[^\]]+]]/g, ' ')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, '$1')
      .replace(/[#>*_`|[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!compact) {
      return '';
    }

    const lower = compact.toLowerCase();
    const matchIndex = terms
      .map(term => lower.indexOf(term))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;

    const start = Math.max(0, matchIndex - 80);
    const snippet = compact.slice(start, start + 220);
    return `${start > 0 ? '...' : ''}${snippet}${start + 220 < compact.length ? '...' : ''}`;
  }

  private isSearchableTextFile(name: string): boolean {
    return /\.(md|markdown|canvas|txt|json|yaml|yml|csv)$/i.test(name);
  }

  private normalizeSearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private fileCacheKey(serverId: string, relativePath: string): string {
    return `${serverId}::${relativePath}`;
  }
}

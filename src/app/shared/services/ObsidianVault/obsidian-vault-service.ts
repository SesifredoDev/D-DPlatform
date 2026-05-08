import { Injectable } from '@angular/core';
import { IServer } from '../../models/server/server.model';
import { ChannelType, IChannel } from '../../models/server/channel.model';
import { get, set, del } from 'idb-keyval';

export interface VaultEntry {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemHandle;
  relativePath: string;
  parentPath: string;
  children?: VaultEntry[];
}

export interface VaultSearchResult {
  serverId: string;
  name: string;
  relativePath: string;
  snippet: string;
  matchType: 'title' | 'path' | 'content';
  score: number;
}

@Injectable({
  providedIn: 'root',
})
export class ObsidianVaultService {
  private readonly STORAGE_KEY_PREFIX = 'obsidian_handle_';
  private readonly LOCALHOST_ROUTE_STORAGE_KEY_PREFIX = 'obsidian_localhost_route_';

  private vaultCache: Map<string, VaultEntry[]> = new Map();
  private readonly fileTextCache = new Map<string, string>();

  constructor() {}

  isFileSystemApiSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }

  async attachVaultToServer(serverId: string): Promise<string> {
    if (!this.isFileSystemApiSupported()) {
      throw new Error('File System Access API is not supported in this browser.');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite'
      });
      await set(`${this.STORAGE_KEY_PREFIX}${serverId}`, handle);
      localStorage.setItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`, 'true');
      this.vaultCache.delete(serverId);
      return handle.name;
    } catch (err) {
      console.error('User cancelled or browser blocked folder access', err);
      throw err;
    }
  }

  async getVaultHandle(serverId: string): Promise<FileSystemDirectoryHandle | null> {
    const handle = await get(`${this.STORAGE_KEY_PREFIX}${serverId}`);
    return (handle as FileSystemDirectoryHandle) || null;
  }

  async requestPermission(handle: FileSystemHandle): Promise<boolean> {
    const options = { mode: 'readwrite' };
    return (await (handle as any).requestPermission(options)) === 'granted';
  }

  async hasPermission(serverId: string): Promise<boolean> {
    const handle = await this.getVaultHandle(serverId);
    if (!handle) return false;

    const options = { mode: 'readwrite' };
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

  async readFileAsBlob(serverId: string, relativePath: string): Promise<Blob> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    return await fileHandle.getFile();
  }

  async writeFile(serverId: string, relativePath: string, content: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, relativePath));
  }

  async renameFile(serverId: string, oldPath: string, newName: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, oldPath);
    if ((fileHandle as any).move) {
      await (fileHandle as any).move(newName);
    } else {
      const file = await fileHandle.getFile();
      const content = await file.text();
      const pathParts = oldPath.split(/[/\\]/).filter(p => p !== '');
      pathParts.pop();
      const newPath = pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;
      await this.writeFile(serverId, newPath, content);
      await this.deleteEntry(serverId, oldPath);
      return newPath;
    }

    const pathParts = oldPath.split(/[/\\]/).filter(p => p !== '');
    pathParts.pop();
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, oldPath));
    return pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;
  }

  async moveEntry(serverId: string, entryPath: string, targetDirectoryPath: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const entryName = entryPath.split(/[/\\]/).pop()!;
    const newRelativePath = targetDirectoryPath ? `${targetDirectoryPath}/${entryName}` : entryName;

    const parts = entryPath.split(/[/\\]/).filter(p => p !== '');
    const fileName = parts.pop()!;
    let sourceDir = rootHandle;
    for (const part of parts) {
      sourceDir = await sourceDir.getDirectoryHandle(part);
    }

    const targetParts = targetDirectoryPath ? targetDirectoryPath.split(/[/\\]/).filter(p => p !== '') : [];
    let targetDir = rootHandle;
    for (const part of targetParts) {
      targetDir = await targetDir.getDirectoryHandle(part);
    }

    const handle = await (sourceDir as any).getFileHandle(fileName);
    if (handle.move) {
      await handle.move(targetDir, fileName);
    } else {
      const file = await handle.getFile();
      const content = await file.text();
      await this.writeFile(serverId, newRelativePath, content);
      await sourceDir.removeEntry(fileName);
    }

    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, entryPath));
    return newRelativePath;
  }

  async deleteEntry(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const parts = relativePath.split(/[/\\]/).filter(p => p !== '');
    const name = parts.pop()!;
    let currentDir = rootHandle;

    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part);
    }

    await currentDir.removeEntry(name, { recursive: true });
    this.vaultCache.delete(serverId);
    this.fileTextCache.delete(this.fileCacheKey(serverId, relativePath));
  }

  async searchVault(serverId: string, query: string, limit = 30): Promise<VaultSearchResult[]> {
    const normalizedQuery = this.normalizeSearchText(query);
    const terms = normalizedQuery.split(' ').filter(Boolean);

    if (terms.length === 0 || !this.hasVaultAttached(serverId) || !(await this.hasPermission(serverId))) {
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
    return /\.(md|markdown|txt|json|yaml|yml|csv)$/i.test(name);
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

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

@Injectable({
  providedIn: 'root',
})
export class ObsidianVaultService {
  private readonly STORAGE_KEY_PREFIX = 'obsidian_handle_';
  private readonly LOCALHOST_ROUTE_STORAGE_KEY_PREFIX = 'obsidian_localhost_route_';

  private vaultCache: Map<string, VaultEntry[]> = new Map();

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
}

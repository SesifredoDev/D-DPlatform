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

  constructor() {}

  /**
   * Checks if the File System Access API is supported by the current browser.
   */
  isFileSystemApiSupported(): boolean {
    return 'showDirectoryPicker' in window;
  }

  /**
   * Triggers the browser folder picker and saves the handle to IndexedDB for persistence.
   */
  async attachVaultToServer(serverId: string): Promise<string> {
    if (!this.isFileSystemApiSupported()) {
      throw new Error('File System Access API is not supported in this browser.');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite'
      });

      // Persist the actual handle object in IndexedDB
      await set(`${this.STORAGE_KEY_PREFIX}${serverId}`, handle);

      // We still keep a small marker in localStorage for quick synchronous checks
      localStorage.setItem(`${this.STORAGE_KEY_PREFIX}${serverId}_exists`, 'true');

      return handle.name;
    } catch (err) {
      console.error('User cancelled or browser blocked folder access', err);
      throw err;
    }
  }

  /**
   * Retrieves the stored FileSystemDirectoryHandle from IndexedDB.
   */
  async getVaultHandle(serverId: string): Promise<FileSystemDirectoryHandle | null> {
    const handle = await get(`${this.STORAGE_KEY_PREFIX}${serverId}`);
    return (handle as FileSystemDirectoryHandle) || null;
  }

  async requestPermission(handle: FileSystemHandle): Promise<boolean> {
    const options = { mode: 'readwrite' };
    return (await (handle as any).requestPermission(options)) === 'granted';
  }

  /**
   * Recursively lists files and directories in the vault.
   */
  async listVaultFiles(serverId: string): Promise<VaultEntry[]> {
    const handle = await this.getVaultHandle(serverId);
    if (!handle) return [];

    return this.scanDirectory(handle);
  }

  private async scanDirectory(directoryHandle: FileSystemDirectoryHandle, path = ''): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = [];
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

    return entries.sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name);
      return a.kind === 'directory' ? -1 : 1;
    });
  }

  /**
   * Resolves a target path relative to a base path, handling '.' and '..' segments.
   * @param basePath The base directory path (e.g., 'folder1/subfolder').
   * @param targetPath The path to resolve (e.g., '../image.png', 'another/file.md', 'file.txt').
   * @returns The resolved absolute path relative to the vault root.
   */
  resolveRelativePath(basePath: string, targetPath: string): string {
    const baseParts = basePath.split('/').filter(p => p !== '');
    const targetParts = targetPath.split('/').filter(p => p !== '');
    const resolvedParts: string[] = [...baseParts];

    for (const part of targetParts) {
      if (part === '..') {
        resolvedParts.pop(); // Go up one directory
      } else if (part !== '.') {
        resolvedParts.push(part); // Add directory/file name
      }
    }
    return resolvedParts.join('/');
  }

  /**
   * Finds a file by its exact filename (case-insensitive) anywhere in the vault.
   * This is a fallback for when a direct relative path doesn't work.
   * @param serverId The ID of the server/vault.
   * @param filename The base name of the file to find (e.g., 'image.jpeg').
   * @returns The full relative path of the file if found, otherwise null.
   */
  async findFileByFilename(serverId: string, filename: string): Promise<string | null> {
    const vaultEntries = await this.listVaultFiles(serverId); // This will re-scan or use cached entries
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
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    const file = await fileHandle.getFile();
    return await file.text();
  }

  async readFileAsBlob(serverId: string, relativePath: string): Promise<Blob> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath);
    const file = await fileHandle.getFile();
    return file;
  }

  async writeFile(serverId: string, relativePath: string, content: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, relativePath, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async renameFile(serverId: string, oldPath: string, newName: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const fileHandle = await this.getFileHandleByPath(rootHandle, oldPath);

    // Check if move/rename is supported directly
    if ((fileHandle as any).move) {
      await (fileHandle as any).move(newName);
    } else {
      // Fallback: Copy and Delete
      const file = await fileHandle.getFile();
      const content = await file.text();
      const pathParts = oldPath.split('/');
      pathParts.pop();
      const newPath = pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;

      await this.writeFile(serverId, newPath, content);
      await this.deleteEntry(serverId, oldPath);
      return newPath;
    }

    const pathParts = oldPath.split('/');
    pathParts.pop();
    return pathParts.length > 0 ? `${pathParts.join('/')}/${newName}` : newName;
  }

  async moveEntry(serverId: string, entryPath: string, targetDirectoryPath: string): Promise<string> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const entryName = entryPath.split('/').pop()!;
    const newRelativePath = targetDirectoryPath ? `${targetDirectoryPath}/${entryName}` : entryName;

    // We can't easily move directories with the current API if .move() isn't available
    // but for files it's easier.
    const parts = entryPath.split('/');
    const fileName = parts.pop()!;
    let sourceDir = rootHandle;
    for (const part of parts) {
      sourceDir = await sourceDir.getDirectoryHandle(part);
    }

    const targetParts = targetDirectoryPath ? targetDirectoryPath.split('/') : [];
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

    return newRelativePath;
  }

  async deleteEntry(serverId: string, relativePath: string): Promise<void> {
    const rootHandle = await this.getVaultHandle(serverId);
    if (!rootHandle) throw new Error('Vault not found');

    const parts = relativePath.split('/');
    const name = parts.pop()!;
    let currentDir = rootHandle;

    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part);
    }

    await currentDir.removeEntry(name, { recursive: true });
  }

  private async getFileHandleByPath(
    root: FileSystemDirectoryHandle,
    path: string,
    create = false
  ): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    const fileName = parts.pop()!;
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

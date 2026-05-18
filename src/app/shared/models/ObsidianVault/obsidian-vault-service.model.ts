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

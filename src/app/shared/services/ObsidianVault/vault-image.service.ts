import { Injectable } from '@angular/core';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { VaultIndex, VaultIndexService } from './vault-index.service';
import { getVaultFileType } from './vault-file-types';

/** Tried, in order, for an image embed written without its extension (`![[map]]`). */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'tiff'];
/** Object URLs kept at once; the oldest are released first. */
const MAX_CACHED_URLS = 300;
/** Thumbnails kept at once, and their width (px; sharp on high-DPI screens at grid-tile size). */
const MAX_CACHED_THUMBS = 600;
const THUMB_WIDTH = 320;
/** Thumbnails made at the same time (each decodes a full image, which can be a huge battle map). */
const THUMB_CONCURRENCY = 3;

interface CachedUrl {
  url: string;
  lastModified: number;
  size: number;
}

/**
 * Finds vault images and hands out object URLs for them, quickly:
 *
 * - **Finding** uses the vault index (instant lookups by path, relative path, file name), never a
 *   walk of the file tree. Answers, including "not found", are remembered until the vault is
 *   re-scanned (a new index), so a missing image costs nothing on later edits.
 * - **Loading** keeps one object URL per file, reused by every note, embed and preview that shows
 *   it, and refreshed only when the file changes. Callers must not revoke these URLs.
 */
@Injectable({ providedIn: 'root' })
export class VaultImageService {
  private readonly resolved = new WeakMap<VaultIndex, Map<string, string | null>>();
  private readonly urls = new Map<string, CachedUrl>();
  private readonly loading = new Map<string, Promise<string | null>>();
  private readonly thumbs = new Map<string, CachedUrl>();
  private readonly thumbLoading = new Map<string, Promise<string | null>>();
  private readonly thumbQueue: (() => void)[] = [];
  private thumbsRunning = 0;

  constructor(private vaultIndex: VaultIndexService, private vaultService: ObsidianVaultService) {}

  /**
   * The vault path of an image link (`map`, `maps/map.png`, `../map.png`), or null. Resolves the
   * way Obsidian does, relative to `fromPath` (the note it's in).
   */
  async resolve(serverId: string, link: string, fromPath = ''): Promise<string | null> {
    if (!serverId) return null;
    const index = this.vaultIndex.get(serverId) ?? await this.vaultIndex.load(serverId).catch(() => null);
    return index ? this.resolveIn(index, link, fromPath) : null;
  }

  /** As `resolve`, against an index already in hand (synchronous). */
  resolveIn(index: VaultIndex, link: string, fromPath = ''): string | null {
    const clean = cleanImageLink(link);
    if (!clean) return null;
    let cache = this.resolved.get(index);
    if (!cache) {
      cache = new Map();
      this.resolved.set(index, cache);
    }
    const key = `${fromPath}\u0000${clean}`;
    if (cache.has(key)) return cache.get(key)!;

    const found = findImage(index, clean, fromPath);
    cache.set(key, found?.relativePath ?? null);
    return found?.relativePath ?? null;
  }

  /** An object URL for an image at a vault path (cached; refreshed when the file changes). */
  url(serverId: string, relativePath: string): Promise<string | null> {
    const key = `${serverId}\u0000${relativePath}`;
    const pending = this.loading.get(key);
    if (pending) return pending;

    const load = this.loadUrl(serverId, relativePath, key).finally(() => this.loading.delete(key));
    this.loading.set(key, load);
    return load;
  }

  /**
   * A small preview of an image (for pickers and grids): decoded straight to ~320px wide, so a
   * grid of 4,000px battle maps doesn't decode dozens of full-size images. Cached, made a few at
   * a time, refreshed when the file changes. Falls back to the full image if it can't be scaled
   * (e.g. some SVGs). Callers must not revoke these URLs.
   */
  thumbnail(serverId: string, relativePath: string): Promise<string | null> {
    const key = `${serverId}\u0000${relativePath}`;
    const pending = this.thumbLoading.get(key);
    if (pending) return pending;

    const load = this.whenThumbSlotFree()
      .then(() => this.loadThumbnail(serverId, relativePath, key))
      .finally(() => {
        this.thumbLoading.delete(key);
        this.thumbsRunning--;
        this.thumbQueue.shift()?.();
      });
    this.thumbLoading.set(key, load);
    return load;
  }

  /** The thumbnail already made for an image, if any (synchronous, for templates). */
  cachedThumbnail(serverId: string, relativePath: string): string | null {
    return this.thumbs.get(`${serverId}\u0000${relativePath}`)?.url ?? null;
  }

  private whenThumbSlotFree(): Promise<void> {
    if (this.thumbsRunning < THUMB_CONCURRENCY) {
      this.thumbsRunning++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.thumbQueue.push(() => {
      this.thumbsRunning++;
      resolve();
    }));
  }

  private async loadThumbnail(serverId: string, relativePath: string, key: string): Promise<string | null> {
    const file = await this.readFile(serverId, relativePath);
    if (!file) return null;

    const cached = this.thumbs.get(key);
    if (cached && cached.lastModified === file.lastModified && cached.size === file.size) {
      this.thumbs.delete(key);
      this.thumbs.set(key, cached);
      return cached.url;
    }
    if (cached) URL.revokeObjectURL(cached.url);

    const blob = await scaleImage(file, THUMB_WIDTH);
    // Couldn't scale it (or it's small already): the full image is fine.
    const url = blob ? URL.createObjectURL(blob) : await this.url(serverId, relativePath);
    if (!url) return null;
    if (blob) {
      this.thumbs.set(key, { url, lastModified: file.lastModified, size: file.size });
      while (this.thumbs.size > MAX_CACHED_THUMBS) {
        const [oldestKey, oldest] = this.thumbs.entries().next().value as [string, CachedUrl];
        URL.revokeObjectURL(oldest.url);
        this.thumbs.delete(oldestKey);
      }
    }
    return url;
  }

  private async readFile(serverId: string, relativePath: string): Promise<File | null> {
    try {
      const entry = this.vaultIndex.get(serverId)?.getByPath(relativePath);
      return entry?.handle && entry.kind === 'file'
        ? await (entry.handle as FileSystemFileHandle).getFile()
        : await this.vaultService.readFileAsBlob(serverId, relativePath);
    } catch {
      return null;
    }
  }

  /** Resolve and load in one go: an object URL for an image link, or null. */
  async urlFor(serverId: string, link: string, fromPath = ''): Promise<string | null> {
    const path = await this.resolve(serverId, link, fromPath);
    return path ? this.url(serverId, path) : null;
  }

  private async loadUrl(serverId: string, relativePath: string, key: string): Promise<string | null> {
    // The indexed handle is one call away from the file; the path walk is the fallback.
    const file = await this.readFile(serverId, relativePath);
    if (!file) return null;

    const cached = this.urls.get(key);
    if (cached && cached.lastModified === file.lastModified && cached.size === file.size) {
      // Most recently used goes to the end.
      this.urls.delete(key);
      this.urls.set(key, cached);
      return cached.url;
    }
    if (cached) URL.revokeObjectURL(cached.url);

    const url = URL.createObjectURL(file);
    this.urls.delete(key);
    this.urls.set(key, { url, lastModified: file.lastModified, size: file.size });
    this.trim();
    return url;
  }

  private trim(): void {
    while (this.urls.size > MAX_CACHED_URLS) {
      const [oldestKey, oldest] = this.urls.entries().next().value as [string, CachedUrl];
      URL.revokeObjectURL(oldest.url);
      this.urls.delete(oldestKey);
    }
  }
}

/** The path part of an embed link: no `#heading`, `|size`, `wikilink-blob:` or zero-width spaces. */
export function cleanImageLink(link: string): string {
  let text = (link || '').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (text.startsWith('wikilink-blob:')) text = text.slice('wikilink-blob:'.length);
  if (text.startsWith('file:///')) text = text.slice('file:///'.length);
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not URI-encoded.
  }
  return text.split('|')[0].split('#')[0].replace(/\\/g, '/').trim();
}

/** The image a link points at: the link as written, then with each image extension. */
export function findImage(index: VaultIndex, link: string, fromPath = ''): VaultEntry | null {
  const isImage = (entry: VaultEntry | null): entry is VaultEntry =>
    !!entry && entry.kind === 'file' && getVaultFileType(entry.name).viewer === 'image';

  const direct = index.resolveFile(link, fromPath);
  if (isImage(direct)) return direct;
  const viaLink = index.resolveLink(link, fromPath);
  if (isImage(viaLink)) return viaLink;

  const name = link.split('/').pop() ?? '';
  if (/\.[a-z0-9]{2,5}$/i.test(name) && getVaultFileType(name).viewer === 'image') return null;
  for (const extension of IMAGE_EXTENSIONS) {
    const entry = index.resolveFile(`${link}.${extension}`, fromPath);
    if (isImage(entry)) return entry;
  }
  return null;
}

/**
 * Decodes an image straight to `width` px wide (the browser scales while decoding, which is far
 * cheaper than decoding full size) and re-encodes it small. Null when it can't, or when the image
 * is small enough already (under ~200 KB).
 */
async function scaleImage(file: Blob, width: number): Promise<Blob | null> {
  if (file.size < 200_000 || typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: width, resizeQuality: 'medium' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

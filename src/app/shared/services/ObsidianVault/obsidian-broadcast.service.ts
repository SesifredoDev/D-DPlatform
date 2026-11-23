import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { BroadcastDialog } from '../../../objects/broadcast-dialog/broadcast-dialog';
import type { BroadcastData, BroadcastEmbeddedFile } from '../../models/objects/broadcast-dialog/broadcast-dialog.model';
import { ObsidianVaultService } from './obsidian-vault-service';
import { VaultIndexService } from './vault-index.service';
import { inferImageMimeType, isVaultFileType } from './vault-file-types';
import { SECRET_SELECTOR, stripSecrets } from './secrets';

/** Where a broadcast comes from: the vault and the note whose relative links should be resolved. */
export interface VaultBroadcastContext {
  serverId: string;
  /** Path of the open note; relative embeds resolve from its folder. */
  currentFilePath: string;
}

export interface VaultDocumentBroadcast extends VaultBroadcastContext {
  fileName: string;
  /** Markdown text for notes; ignored for other files (they are sent as the file itself). */
  markdown: string | null;
  /** Rendered editor HTML, if available. */
  html?: string;
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
  /** Resolved vault path -> token URL, so the same image is only attached once. */
  tokens: Map<string, string>;
}

const ZERO_WIDTH = /[​-‍﻿]/g;

/**
 * Builds broadcast payloads from vault content: resolves embedded vault images, replaces them with
 * `broadcast-file://` tokens and attaches the image files, then opens the broadcast dialog.
 */
@Injectable({
  providedIn: 'root',
})
export class ObsidianBroadcastService {
  constructor(
    private dialog: MatDialog,
    private vaultService: ObsidianVaultService,
    private vaultIndex: VaultIndexService
  ) {}

  /** Broadcasts a whole file. GM-only secrets are removed from notes first. */
  async broadcastDocument(request: VaultDocumentBroadcast): Promise<BroadcastSecretsReport> {
    const data: BroadcastData = {
      source: 'obsidian-view',
      filename: request.fileName,
    };
    let removed = 0;

    if (request.markdown !== null) {
      const stripped = stripSecrets(request.markdown);
      removed = stripped.removed;
      const state = this.newTokenizeState();
      data.text = await this.tokenizeMarkdownImages(request, stripped.markdown, state);
      data.embeddedFiles = state.embeddedFiles;
      data.htmlContent = request.html === undefined ? undefined : removeSecretElements(request.html);
      data.preferTextForBroadcast = true;
    } else {
      const blob = await this.vaultService.readFileAsBlob(request.serverId, request.currentFilePath);
      data.file = new File([blob], request.fileName, { type: blob.type });
    }

    this.openDialog(data);
    return { removed, allSecret: false };
  }

  /**
   * Broadcasts a DOM selection made inside the note editor. GM-only parts are removed; if the whole
   * selection is GM-only, nothing is broadcast.
   */
  async broadcastSelection(context: VaultBroadcastContext, selection: Selection): Promise<BroadcastSecretsReport> {
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorElement = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (ancestorElement?.closest(SECRET_SELECTOR)) {
      return { removed: 1, allSecret: true };
    }

    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const secretElements = container.querySelectorAll(SECRET_SELECTOR);
    secretElements.forEach(element => element.remove());
    // Text from the cleaned HTML (selection.toString() would still include the secrets), then
    // strip any secret syntax the editor didn't mark.
    const stripped = stripSecrets(selectionText(container));
    const removed = secretElements.length + stripped.removed;
    if (!stripped.markdown.trim() && !container.querySelector('img')) {
      return { removed, allSecret: removed > 0 };
    }

    const state = this.newTokenizeState();

    // Rendered <img> tags in the selected HTML.
    const images = Array.from(container.querySelectorAll('img'));
    for (const img of images) {
      const src = img.getAttribute('src');
      if (src) {
        img.setAttribute('src', await this.tokenizeImage(context, src, img.getAttribute('alt') || 'image', state));
      }
    }

    const data: BroadcastData = {
      text: await this.tokenizeMarkdownImages(context, stripped.markdown, state),
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
    return { embeddedFiles: [], tokens: new Map() };
  }

  /** Rewrites `![[embed|alt]]` and `![alt](url)` images to tokenized markdown images. */
  private async tokenizeMarkdownImages(context: VaultBroadcastContext, content: string, state: TokenizeState): Promise<string> {
    const withEmbeds = await replaceAsync(content, /!\[\[(.*?)\]\]/g, async (_, inner: string) => {
      const [rawPath, rawAlt] = inner.trim().split('|');
      const filePath = rawPath.trim().replace(/\\/g, '/');
      const alt = rawAlt !== undefined ? rawAlt.trim() : filePath;
      return `![${alt}](${await this.tokenizeImage(context, filePath, alt, state)})`;
    });

    return replaceAsync(withEmbeds, /!\[(.*?)\]\(([^)]+)\)/g, async (_, alt: string, url: string) => {
      return `![${alt}](${await this.tokenizeImage(context, url.trim(), alt, state)})`;
    });
  }

  /** Returns a `broadcast-file://` token for a vault image, or the original URL if it isn't one. */
  private async tokenizeImage(context: VaultBroadcastContext, url: string, alt: string, state: TokenizeState): Promise<string> {
    const searchPath = this.toVaultSearchPath(url);
    if (!searchPath) return url;

    const resolvedPath = await this.resolveVaultPath(context, searchPath);
    if (!resolvedPath || !isVaultFileType(resolvedPath, 'image')) {
      console.warn(`[ObsidianBroadcast] Could not resolve image path for broadcast: ${searchPath}`);
      return url;
    }

    const cached = state.tokens.get(resolvedPath);
    if (cached) return cached;

    try {
      const blob = await this.vaultService.readFileAsBlob(context.serverId, resolvedPath);
      const filename = alt?.trim() || resolvedPath.split('/').pop() || 'image';
      const tokenUrl = `broadcast-file://${crypto.randomUUID()}`;

      state.embeddedFiles.push({ tokenUrl, file: new File([blob], filename, { type: blob.type }) });
      state.tokens.set(resolvedPath, tokenUrl);
      return tokenUrl;
    } catch (error) {
      console.error(`[ObsidianBroadcast] Error reading resolved image for broadcast: ${resolvedPath}`, error);
      return url;
    }
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
      return marker[1].replace(/\\/g, '/') || null;
    }

    if (/^(https?:|blob:|data:|broadcast-file:)/i.test(value)) {
      return null;
    }

    return value.replace(/\\/g, '/') || null;
  }

  /** Resolves via the vault index, falling back to disk checks in case the index is stale. */
  private async resolveVaultPath(context: VaultBroadcastContext, searchPath: string): Promise<string | null> {
    const index = this.vaultIndex.get(context.serverId) ?? await this.vaultIndex.load(context.serverId);
    const indexed = index.resolveFile(searchPath, context.currentFilePath);
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

/** Removes GM-only elements (as marked by the editor) from an HTML string. */
function removeSecretElements(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  container.querySelectorAll(SECRET_SELECTOR).forEach(element => element.remove());
  return container.innerHTML;
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

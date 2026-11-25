import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { TabService } from '../tab/tab-service';
import { ObsidianVaultService, VaultEntry } from './obsidian-vault-service';
import { VaultIndex, VaultIndexService } from './vault-index.service';
import { getVaultDisplayName } from './vault-file-types';

/** A vault view showing a note that text can be inserted into (see ObsidianViewComponent). */
export interface NoteInsertTarget {
  serverId(): string;
  /** The open note's path, or null when no editable note is open (folder, image, preview tab…). */
  notePath(): string | null;
  /** Inserts Markdown at the note's cursor (or at the end if it was never clicked into). */
  insert(markdown: string): boolean;
}

/**
 * Lets other parts of the app (the search drawer) save notes into the vault and insert text into
 * the note the GM has open. Vault views register themselves; the one used most recently wins.
 */
@Injectable({ providedIn: 'root' })
export class NoteInsertService {
  private targets: NoteInsertTarget[] = [];

  /** Emits a server id when a note was saved into its vault from elsewhere, so file lists refresh. */
  readonly vaultChanged$ = new Subject<string>();

  constructor(
    private vaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private tabService: TabService
  ) {}

  /** Registers a vault view; returns the function that unregisters it. */
  register(target: NoteInsertTarget): () => void {
    this.touch(target);
    return () => (this.targets = this.targets.filter(existing => existing !== target));
  }

  /** Marks a vault view as the one used most recently (on focus or click). */
  touch(target: NoteInsertTarget): void {
    this.targets = [...this.targets.filter(existing => existing !== target), target];
  }

  /** The most recently used view of this server's vault that has an editable note open. */
  activeTarget(serverId: string): NoteInsertTarget | null {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const target = this.targets[i];
      if (target.serverId() === serverId && target.notePath()) return target;
    }
    return null;
  }

  /** The open note's title, for button labels ("Insert into Session 3"). */
  activeNoteTitle(serverId: string): string | null {
    const path = this.activeTarget(serverId)?.notePath();
    return path ? getVaultDisplayName(path.split('/').pop() || path) : null;
  }

  insertIntoActiveNote(serverId: string, markdown: string): boolean {
    return this.activeTarget(serverId)?.insert(markdown) ?? false;
  }

  /**
   * Makes sure this server has a vault the app may write to, asking the browser for permission
   * again if needed (call from a click, since browsers only show that prompt after one).
   */
  async ensureAccess(serverId: string): Promise<'ok' | 'no-vault' | 'denied'> {
    const handle = await this.vaultService.getVaultHandle(serverId);
    if (!handle) return 'no-vault';
    if (await this.vaultService.hasPermission(serverId)) return 'ok';
    try {
      return (await this.vaultService.requestPermission(handle)) ? 'ok' : 'denied';
    } catch {
      return 'denied';
    }
  }

  /** The vault's index, loading the file list (and, with `withContent`, every note) if needed. */
  async index(serverId: string, withContent = false): Promise<VaultIndex> {
    if (withContent) await this.vaultIndexService.ensureContentIndexed(serverId);
    return this.vaultIndexService.get(serverId) ?? this.vaultIndexService.load(serverId);
  }

  /** Every folder in the vault, sorted by path ('' is the vault root). */
  async folders(serverId: string): Promise<string[]> {
    const index = await this.index(serverId);
    return ['', ...index.folders.map(folder => folder.relativePath).filter(path => !path.startsWith('.')).sort((a, b) => a.localeCompare(b))];
  }

  /**
   * Writes a new note into `folder`, named after `title` ("Goblin", then "Goblin 2"… if taken),
   * indexes it and returns its path.
   */
  async createNote(serverId: string, folder: string, title: string, content: string): Promise<string> {
    const cleanFolder = folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const base = title.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim() || 'Untitled';

    // Creates the folder if it's new; a no-op for one that exists.
    if (cleanFolder) await this.vaultService.createFolder(serverId, cleanFolder);

    let path = '';
    for (let i = 1; i < 100 && !path; i++) {
      const candidate = `${cleanFolder ? `${cleanFolder}/` : ''}${base}${i > 1 ? ` ${i}` : ''}.md`;
      if (!(await this.vaultService.fileExists(serverId, candidate))) path = candidate;
    }
    if (!path) throw new Error(`No free file name for “${base}”.`);

    await this.vaultService.writeFile(serverId, path, content);
    const index = await this.vaultIndexService.load(serverId, false);
    index.indexNoteContent(path, content);
    this.vaultChanged$.next(serverId);
    return path;
  }

  /** `![[Link]]` text for embedding a note, using the shortest link that resolves to it. */
  async embedFor(serverId: string, path: string): Promise<string> {
    const index = await this.index(serverId);
    const entry = index.getByPath(path);
    return `![[${entry ? index.linkTextFor(entry) : path.replace(/\.md$/i, '')}]]`;
  }

  /** Opens a note in this server's vault tab. */
  openInVault(serverId: string, path: string): void {
    this.tabService.openTab(`obsidian-${serverId}`, 'obsidian-vault', 'obsidian', 'left', {
      serverId,
      openPath: path,
      openRequestId: Date.now(),
    });
  }

  /** The note already holding a block imported from `sourceKey`, if any (reads every note once). */
  async findImported(serverId: string, sourceKey: string): Promise<VaultEntry | null> {
    const index = await this.index(serverId, true);
    return index.findBySource(sourceKey);
  }
}

import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ObsidianVaultService, VaultEntry } from '../../services/ObsidianVault/obsidian-vault-service';
import { StatblockBlock, findStatblocks } from '../../services/ObsidianVault/statblock';
import { VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import { StatblockCardComponent } from './statblock-card.component';

/**
 * `![[Note]]` in a note. A note with a statblock or item shows as a collapsible card; any other
 * note shows as a link card, and an image (`![[map]]` without its extension) as the image.
 */
@Component({
  selector: 'app-note-embed',
  standalone: true,
  imports: [MatIconModule, StatblockCardComponent],
  template: `
    @if (statblock && entry) {
      <app-statblock-card
        mode="embed"
        [kind]="statblock.kind"
        [source]="statblock.source"
        [notePath]="entry.relativePath"
        [serverId]="serverId"
        [readonly]="true"
        (openNote)="openNote.emit($event)">
      </app-statblock-card>
    } @else if (imageUrl) {
      <img class="embed-image" [src]="imageUrl" [alt]="title">
    } @else {
      <button type="button" class="embed-note" [class.is-missing]="!entry && !loading" (click)="openNote.emit(entry?.relativePath ?? link)">
        <span class="material-icons">{{ entry ? 'description' : loading ? 'hourglass_empty' : 'link_off' }}</span>
        <span class="embed-title">{{ title }}</span>
        <span class="embed-hint">{{ entry ? 'Embedded note' : loading ? 'Loading…' : 'Not found' }}</span>
      </button>
    }
  `,
  styles: [`
    :host { display: block; margin: 0.75rem 0; white-space: normal; }
    :host .embed-note {
      display: flex; align-items: center; gap: 10px; width: 100%; max-width: 820px; padding: 10px 14px;
      border: 1px solid var(--vv-border, rgba(255, 255, 255, 0.08)); border-left: 3px solid var(--vv-accent, var(--primary, #7289da));
      border-radius: 8px; background: rgba(0, 0, 0, 0.16); color: var(--vv-text, inherit); font: inherit; text-align: left; cursor: pointer;
    }
    :host .embed-note:hover { background: rgba(255, 255, 255, 0.04); }
    :host .embed-note.is-missing { border-left-color: var(--vv-danger, #ff8a8a); opacity: 0.8; }
    :host .embed-title { font-weight: 600; }
    :host .embed-hint { margin-left: auto; color: var(--vv-text-3, rgba(255, 255, 255, 0.5)); font-size: 0.8rem; }
    :host .embed-image { display: block; max-width: 100%; margin: 0; border-radius: 4px; }
  `],
})
export class NoteEmbedComponent implements OnChanges, OnDestroy {
  /** The embed target as written (`Goblin`, `Monsters/Goblin#Stats`). */
  @Input() link = '';
  /** The note the embed is in (links resolve relative to it). */
  @Input() fromPath = '';
  @Input() serverId = '';
  @Output() openNote = new EventEmitter<string>();

  entry: VaultEntry | null = null;
  statblock: StatblockBlock | null = null;
  imageUrl = '';
  loading = true;
  private loadId = 0;

  constructor(private vaultService: ObsidianVaultService, private vaultIndexService: VaultIndexService) {}

  get title(): string {
    return this.entry ? getVaultDisplayName(this.entry.name) : this.link.split('#')[0];
  }

  ngOnChanges(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.loadId++;
    if (this.imageUrl.startsWith('blob:')) URL.revokeObjectURL(this.imageUrl);
  }

  private async load(): Promise<void> {
    const id = ++this.loadId;
    this.loading = true;
    try {
      if (!this.serverId) return;
      const index = this.vaultIndexService.get(this.serverId) ?? await this.vaultIndexService.load(this.serverId);
      if (id !== this.loadId) return;
      const entry = index.resolveLink(this.link, this.fromPath);
      this.entry = entry?.kind === 'file' ? entry : null;
      if (!this.entry) return;

      const type = getVaultFileType(this.entry.name);
      if (type.viewer === 'image') {
        const blob = await this.vaultService.readFileAsBlob(this.serverId, this.entry.relativePath);
        if (id === this.loadId) this.imageUrl = URL.createObjectURL(blob);
        return;
      }
      if (type.id !== 'markdown') return;

      const content = await this.vaultService.readFile(this.serverId, this.entry.relativePath);
      if (id !== this.loadId) return;
      this.statblock = findStatblocks(content)[0] ?? null;
    } catch (error) {
      console.warn('[NoteEmbed] Failed to load', this.link, error);
    } finally {
      if (id === this.loadId) this.loading = false;
    }
  }
}

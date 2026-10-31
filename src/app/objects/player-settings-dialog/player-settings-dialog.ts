import { Component, DestroyRef, ElementRef, Inject, OnInit, Optional, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';

import { ServerService } from '../../shared/services/server/server';
import { FileService } from '../../shared/services/file/file';
import { HomebrewPackService } from '../../shared/services/homebrew-pack/homebrew-pack.service';
import { IServer } from '../../shared/models/server/server.model';
import { IHomebrewPack, IHomebrewPackItem } from '../../shared/models/homebrew-pack/homebrew-pack.model';

export interface PlayerSettingsDialogData {
  /** Server that is open in the side panel. New and imported packs are attached to it. */
  currentServerId?: string | null;
}

@Component({
  selector: 'app-player-settings-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatSnackBarModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatTooltipModule,
    MatPaginatorModule
  ],
  templateUrl: './player-settings-dialog.html',
  styleUrl: './player-settings-dialog.scss'
})
export class PlayerSettingsDialog implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  readonly servers = signal<IServer[]>([]);
  readonly isSaving = signal(false);

  selectedPackId: string | null = null;
  isCreatingPack = false;
  packItems: IHomebrewPackItem[] = [];
  packForm: FormGroup = this.initPackForm();

  // --- Item list view state (keeps the DOM small for very large packs) ---
  readonly pageSizeOptions = [10, 25, 50, 100];
  pageSize = 25;
  pageIndex = 0;
  itemFilter = '';
  /** Absolute indices into packItems for the cards currently rendered. */
  visibleIndices: number[] = [];
  /** Number of items matching the filter (or all items when there is no filter). */
  filteredCount = 0;

  private filteredIndices: number[] | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Items that have already been copied for editing (copy-on-write; see editableItem). */
  private ownedItems = new WeakSet<object>();
  private readonly itemsTop = viewChild<ElementRef<HTMLElement>>('itemsTop');

  readonly currentServerId: string | null;

  constructor(
    private dialogRef: MatDialogRef<PlayerSettingsDialog>,
    private snackBar: MatSnackBar,
    private serverService: ServerService,
    private fileService: FileService,
    public homebrewPackService: HomebrewPackService,
    @Optional() @Inject(MAT_DIALOG_DATA) data: PlayerSettingsDialogData | null
  ) {
    this.currentServerId = data?.currentServerId ?? null;
  }

  ngOnInit(): void {
    void this.homebrewPackService.loadPacks();

    this.serverService.getMyServersObservable()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(servers => this.servers.set(servers ?? []));
  }

  get allPacks(): IHomebrewPack[] {
    return this.homebrewPackService.packs();
  }

  /** Always resolved from the live list so attachment changes show up immediately. */
  get activePack(): IHomebrewPack | null {
    if (!this.selectedPackId) return null;
    return this.allPacks.find(pack => pack.id === this.selectedPackId) ?? null;
  }

  /** The server open in the side panel, if it is still in the user's server list. */
  get currentServer(): IServer | null {
    if (!this.currentServerId) return null;
    return this.servers().find(server => server._id === this.currentServerId) ?? null;
  }

  async toggleForCurrentServer(pack: IHomebrewPack, attach: boolean): Promise<void> {
    const server = this.currentServer;
    if (server) await this.toggleAttachment(pack, server, attach);
  }

  isAttached(pack: IHomebrewPack, serverId: string): boolean {
    return pack.attachedServerIds?.includes(serverId) ?? false;
  }

  attachedCount(pack: IHomebrewPack): number {
    return pack.attachedServerIds?.length ?? 0;
  }

  serverIconUrl(server: IServer): string {
    const icon = typeof server.icon === 'string' ? server.icon.trim() : '';
    return icon ? this.fileService.resolveFileUrl(icon) : 'assets/default-avatar.png';
  }

  async toggleAttachment(pack: IHomebrewPack, server: IServer, attach: boolean): Promise<void> {
    await this.homebrewPackService.toggleServerAttachment(pack.id, server._id, attach);
    this.snackBar.open(
      attach ? `Attached "${pack.name}" to ${server.name}.` : `Detached "${pack.name}" from ${server.name}.`,
      'OK',
      { duration: 2000 }
    );
  }

  // --- Pack selection / editing ---

  selectPack(pack: IHomebrewPack, preserveView = false): void {
    this.isCreatingPack = false;
    this.selectedPackId = pack.id;
    // Shallow copy only: cloning tens of thousands of items up front is what made big packs
    // slow. Individual items are copied lazily the first time they are edited.
    this.packItems = [...(pack.items || [])];
    this.ownedItems = new WeakSet();
    this.packForm = this.initPackForm(pack);
    if (preserveView) {
      this.applyFilter(false);
    } else {
      this.resetItemView();
    }
  }

  createNewPack(): void {
    this.selectedPackId = null;
    this.isCreatingPack = true;
    this.packItems = [];
    this.ownedItems = new WeakSet();
    this.packForm = this.initPackForm();
    this.resetItemView();
  }

  cancelPackEdit(): void {
    const pack = this.activePack;
    if (this.isCreatingPack || !pack) {
      this.selectedPackId = null;
      this.isCreatingPack = false;
      return;
    }
    this.selectPack(pack);
  }

  async onSavePack(): Promise<void> {
    if (this.packForm.invalid) return;

    const val = this.packForm.getRawValue();
    const existing = this.activePack;
    const packToSave: IHomebrewPack = {
      id: existing?.id || `pack_${Date.now()}`,
      name: val.name,
      version: val.version,
      author: val.author,
      description: val.description,
      attachedServerIds: existing?.attachedServerIds ?? (this.currentServerId ? [this.currentServerId] : []),
      items: this.packItems,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    this.isSaving.set(true);
    // Let the disabled/saving state paint before the (potentially heavy) stringify + IPC call.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      await this.homebrewPackService.savePack(packToSave);
      this.snackBar.open('Homebrew pack saved locally.', 'OK', { duration: 2000 });
      this.selectPack(packToSave, true);
    } catch (error) {
      console.error('Failed to save homebrew pack', error);
      this.snackBar.open('Failed to save pack.', 'Close', { duration: 3000 });
    } finally {
      this.isSaving.set(false);
    }
  }

  async onDeletePack(packId: string): Promise<void> {
    if (!confirm('Are you sure you want to delete this homebrew pack?')) return;
    await this.homebrewPackService.deletePack(packId);
    this.selectedPackId = null;
    this.isCreatingPack = false;
    this.snackBar.open('Homebrew pack deleted.', 'OK', { duration: 2000 });
  }

  onImportPackFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const pack = JSON.parse(e.target?.result as string) as IHomebrewPack;
        if (!pack.name || !Array.isArray(pack.items)) {
          throw new Error('Invalid pack schema.');
        }
        pack.id = pack.id || `pack_${Date.now()}`;
        // Server ids in a file from someone else's machine mean nothing here.
        pack.attachedServerIds = this.currentServerId ? [this.currentServerId] : [];
        await this.homebrewPackService.savePack(pack);
        this.selectPack(pack);
        this.snackBar.open('Modpack imported successfully!', 'OK', { duration: 2000 });
      } catch {
        this.snackBar.open('Failed to import pack file. Invalid JSON.', 'Close', { duration: 3000 });
      }
    };
    reader.readAsText(file);
    input.value = '';
  }

  addPackItem(): void {
    const item: IHomebrewPackItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: 'New Custom Item',
      description: 'Markdown item description...',
      properties: { type: 'item', rarity: 'common' }
    };
    this.ownedItems.add(item);
    this.packItems.push(item);
    this.packForm.markAsDirty();

    // Clear the filter and jump to the last page so the new item is visible.
    this.itemFilter = '';
    this.filteredIndices = null;
    this.pageIndex = Math.floor((this.packItems.length - 1) / this.pageSize);
    this.refreshVisibleItems();
    this.scrollItemsIntoView();
  }

  removePackItem(index: number): void {
    this.packItems.splice(index, 1);
    this.packForm.markAsDirty();
    // Indices shifted, so any cached filter result is stale.
    this.applyFilter(false);
  }

  updateItemField(index: number, field: keyof IHomebrewPackItem, value: any): void {
    (this.editableItem(index) as any)[field] = value;
    this.packForm.markAsDirty();
  }

  getItemPropertiesArray(index: number): Array<{ key: string; value: string }> {
    const props = this.packItems[index]?.properties || {};
    return Object.entries(props).map(([key, value]) => ({ key, value: String(value) }));
  }

  addItemProperty(index: number): void {
    const item = this.editableItem(index);
    const propCount = Object.keys(item.properties).length;
    item.properties[`key_${propCount + 1}`] = 'value';
    this.packForm.markAsDirty();
  }

  removeItemProperty(index: number, key: string): void {
    delete this.editableItem(index).properties[key];
    this.packForm.markAsDirty();
  }

  updateItemPropertyKey(index: number, oldKey: string, newKey: string): void {
    if (!newKey || oldKey === newKey) return;
    const props = this.editableItem(index).properties;
    const value = props[oldKey];
    delete props[oldKey];
    props[newKey] = value;
    this.packForm.markAsDirty();
  }

  updateItemPropertyValue(index: number, key: string, value: string): void {
    this.editableItem(index).properties[key] = value;
    this.packForm.markAsDirty();
  }

  // --- Item list paging / filtering ---

  onItemFilterInput(value: string): void {
    this.itemFilter = value;
    if (this.filterTimer) clearTimeout(this.filterTimer);
    // Debounce so typing in a 30k+ item pack doesn't re-scan on every keystroke.
    this.filterTimer = setTimeout(() => this.applyFilter(true), 200);
  }

  onItemPage(event: PageEvent): void {
    this.pageSize = event.pageSize;
    this.pageIndex = event.pageIndex;
    this.refreshVisibleItems();
    this.scrollItemsIntoView();
  }

  private resetItemView(): void {
    this.itemFilter = '';
    this.filteredIndices = null;
    this.pageIndex = 0;
    this.refreshVisibleItems();
  }

  private applyFilter(resetPage: boolean): void {
    const query = this.itemFilter.trim().toLowerCase();
    if (!query) {
      this.filteredIndices = null;
    } else {
      const matches: number[] = [];
      for (let i = 0; i < this.packItems.length; i++) {
        if (this.itemMatches(this.packItems[i], query)) matches.push(i);
      }
      this.filteredIndices = matches;
    }
    if (resetPage) this.pageIndex = 0;
    this.refreshVisibleItems();
  }

  private itemMatches(item: IHomebrewPackItem, query: string): boolean {
    if (item.name?.toLowerCase().includes(query)) return true;
    if (item.description?.toLowerCase().includes(query)) return true;
    for (const [key, value] of Object.entries(item.properties ?? {})) {
      if (key.toLowerCase().includes(query) || String(value).toLowerCase().includes(query)) return true;
    }
    return false;
  }

  private refreshVisibleItems(): void {
    const total = this.filteredIndices ? this.filteredIndices.length : this.packItems.length;
    this.filteredCount = total;

    const pageCount = Math.max(1, Math.ceil(total / this.pageSize));
    this.pageIndex = Math.min(this.pageIndex, pageCount - 1);

    const start = this.pageIndex * this.pageSize;
    const end = Math.min(start + this.pageSize, total);
    const indices: number[] = [];
    for (let i = start; i < end; i++) {
      indices.push(this.filteredIndices ? this.filteredIndices[i] : i);
    }
    this.visibleIndices = indices;
  }

  private scrollItemsIntoView(): void {
    setTimeout(() => this.itemsTop()?.nativeElement.scrollIntoView({ block: 'start' }));
  }

  /**
   * Copy-on-write: the working list shares item objects with the live pack state until an item
   * is first edited, at which point that single item is cloned so the live state is never mutated.
   */
  private editableItem(index: number): IHomebrewPackItem {
    const item = this.packItems[index];
    if (this.ownedItems.has(item)) return item;
    const copy: IHomebrewPackItem = { ...item, properties: { ...(item.properties ?? {}) } };
    this.packItems[index] = copy;
    this.ownedItems.add(copy);
    return copy;
  }

  close(): void {
    this.dialogRef.close();
  }

  private initPackForm(pack?: IHomebrewPack | null): FormGroup {
    return this.fb.group({
      name: [pack?.name ?? '', Validators.required],
      version: [pack?.version ?? '1.0.0', Validators.required],
      author: [pack?.author ?? '', Validators.required],
      description: [pack?.description ?? '']
    });
  }
}

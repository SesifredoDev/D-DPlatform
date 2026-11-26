import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ObsidianVaultService, VaultEntry } from '../../services/ObsidianVault/obsidian-vault-service';
import {
  BlockKind,
  ParsedStatblock,
  StatblockData,
  blockIcon,
  blockNoun,
  canAddToMap,
  StatblockEntry,
  dndModifier,
  entriesValue,
  extraKeys,
  formatSigned,
  formatSubtitle,
  keyLabel,
  parseStatblock,
  scalar,
  scoresValue,
  serializeStatblock,
  statblockImage,
  textValue,
} from '../../services/ObsidianVault/statblock';
import { StatblockField, StatblockSystem, getStatblockSystem, systemsFor } from '../../services/ObsidianVault/statblock-systems';
import { StatblockVttService } from '../../services/ObsidianVault/statblock-vtt.service';
import { findDiceExpressions } from '../../services/dice/dice';
import { DiceRollService } from '../../services/dice/dice-roll.service';
import { VaultIndex, VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getFileExtension, getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import { VaultImageService } from '../../services/ObsidianVault/vault-image.service';

interface FieldView {
  key: string;
  label: string;
  value: string;
  placeholder: string;
  extraKey?: string;
  extraLabel?: string;
  extraValue?: string;
}

type BlockView =
  | { kind: 'fields'; fields: FieldView[] }
  | { kind: 'scores'; key: string; items: { label: string; value: string; note: string }[] }
  | { kind: 'entries'; key: string; title: string; untitled: boolean; entries: StatblockEntry[] }
  | { kind: 'text'; key: string; title: string; value: string };

interface UsedIn {
  entry: VaultEntry;
  embedded: boolean;
}

const OPEN_EMBEDS_KEY = 'statblock.open-embeds';
const ROLL_INITIATIVE_KEY = 'statblock.roll-initiative';
const PICKER_LIMIT = 60;

/**
 * A statblock or item: a card with Stats and Properties tabs and an "Add to map" button.
 *
 * `block` mode is the statblock inside its own note (editable; changes come out as new block text).
 * `embed` mode is `![[Note]]` in another note: a collapsible, read-only card.
 */
@Component({
  selector: 'app-statblock-card',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './statblock-card.component.html',
  styleUrl: './statblock-card.component.scss',
})
export class StatblockCardComponent implements OnChanges, OnDestroy {
  /** The YAML inside the ```statblock block. */
  @Input() source = '';
  /** The note holding the block. */
  @Input() notePath = '';
  @Input() serverId = '';
  @Input() mode: 'block' | 'embed' = 'block';
  /** A creature (```statblock) or an item (```item). */
  @Input() kind: BlockKind = 'creature';
  @Input() readonly = false;
  /** New block text after an edit (block mode). */
  @Output() sourceChange = new EventEmitter<string>();
  /** A link (note path or link text) to open. */
  @Output() openNote = new EventEmitter<string>();
  /** A picture was saved into the vault, so the file list should be refreshed. */
  @Output() filesAdded = new EventEmitter<void>();

  parsed: ParsedStatblock = parseStatblock('');
  data: StatblockData = {};
  system: StatblockSystem = getStatblockSystem(undefined);
  name = '';
  subtitle = '';
  summary: { label: string; value: string }[] = [];
  blocks: BlockView[] = [];
  extraFields: FieldView[] = [];
  extraEntries: { key: string; title: string; entries: StatblockEntry[] }[] = [];
  subtitleFields: FieldView[] = [];

  tab: 'stats' | 'properties' = 'stats';
  editing = false;
  showSource = false;
  sourceDraft = '';
  expanded = false;

  /** The token picture as written, and what it resolves to (a vault path or web URL). */
  imageRef = '';
  imagePath: string | null = null;
  /** Object URLs (or web URLs) per image path; '' when it couldn't be loaded. */
  imageUrls: Record<string, string> = {};
  imageUrlDraft = '';

  isPicking = false;
  pickerQuery = '';
  pickerImages: VaultEntry[] = [];
  /** Small previews for the picker grid. */
  thumbUrls: Record<string, string> = {};
  private pickerQueryTimer?: ReturnType<typeof setTimeout>;
  pickerTotal = 0;
  isUploading = false;

  usedIn: UsedIn[] = [];
  usedInLoading = false;

  addingToMap = false;
  rollInitiative = readFlag(ROLL_INITIATIVE_KEY, true);

  private lastEmitted: string | null = null;
  private readonly loadingImages = new Set<string>();
  private readonly htmlCache = new Map<string, SafeHtml>();

  constructor(
    private sanitizer: DomSanitizer,
    private snackBar: MatSnackBar,
    private vaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private statblockVtt: StatblockVttService,
    private diceRolls: DiceRollService,
    private vaultImages: VaultImageService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['source'] && this.source !== this.lastEmitted) || changes['kind']) {
      this.parsed = parseStatblock(this.source, this.kind);
      this.data = structuredClone(this.parsed.data);
      this.sourceDraft = this.source;
      this.rebuild();
    }
    if (changes['notePath'] || changes['mode']) {
      this.expanded = this.mode === 'block' || readOpenEmbeds().has(this.notePath);
    }
    if (changes['readonly'] && this.readonly) {
      this.editing = false;
      this.isPicking = false;
    }
    if (changes['notePath'] || changes['serverId']) {
      this.usedIn = [];
      this.resolveImage();
    }
  }

  ngOnDestroy(): void {
    Object.values(this.imageUrls).forEach(url => url.startsWith('blob:') && URL.revokeObjectURL(url));
    if (this.pickerQueryTimer) clearTimeout(this.pickerQueryTimer);
  }

  /** Systems offered for this kind of block. */
  get systems(): StatblockSystem[] {
    return systemsFor(this.kind);
  }

  get noun(): string {
    return blockNoun(this.kind);
  }

  /** "Statblock" / "Item" / "Spell". */
  get kindLabel(): string {
    const noun = this.noun;
    return noun.charAt(0).toUpperCase() + noun.slice(1);
  }

  get kindIcon(): string {
    return blockIcon(this.kind);
  }

  /** Creatures and items become tokens; a spell's picture is just its art. */
  get canAddToMap(): boolean {
    return canAddToMap(this.kind);
  }

  get pictureLabel(): string {
    return this.canAddToMap ? 'Token picture' : 'Picture';
  }

  get canEdit(): boolean {
    return this.mode === 'block' && !this.readonly && !this.parsed.error;
  }

  get tokenUrl(): string {
    return this.imagePath ? this.imageUrls[this.imagePath] ?? '' : '';
  }

  get initials(): string {
    return (this.name || '?').split(/\s+/).slice(0, 2).map(word => word.charAt(0).toUpperCase()).join('');
  }

  get noteTitle(): string {
    return getVaultDisplayName(this.notePath.split('/').pop() || this.notePath);
  }

  // ---- Building the view ----

  private rebuild(): void {
    const data = this.data;
    const system = (this.system = getStatblockSystem(data['system'], this.kind));
    this.name = textValue(data['name']);
    this.subtitle = formatSubtitle(system, data);
    this.summary = system.summary
      .map(item => ({ label: item.label, value: textValue(data[item.key]).split(/[\s(;]/)[0] }))
      .filter(item => item.value);
    this.subtitleFields = system.subtitleFields.map(field => this.fieldView(field));

    this.blocks = system.blocks.map((block): BlockView => {
      switch (block.kind) {
        case 'fields':
          return { kind: 'fields', fields: block.fields.map(field => this.fieldView(field)) };
        case 'scores': {
          const values = scoresValue(data[block.key], block.labels.length);
          return {
            kind: 'scores',
            key: block.key,
            items: block.labels.map((label, i) => {
              const modifier = block.modifier === 'dnd' ? dndModifier(values[i]) : null;
              const value = block.signed && /^\d/.test(values[i]) ? `+${values[i]}` : values[i];
              return { label, value, note: modifier === null ? '' : formatSigned(modifier) };
            }),
          };
        }
        case 'entries':
          return { kind: 'entries', key: block.key, title: block.title, untitled: !!block.untitled, entries: entriesValue(data[block.key]) };
        case 'text':
          return { kind: 'text', key: block.key, title: block.title, value: textValue(data[block.key]) };
      }
    });

    const extra = extraKeys(system, data);
    this.extraFields = extra.fields.map(key => this.fieldView({ key, label: keyLabel(key) }));
    this.extraEntries = extra.entries.map(key => ({ key, title: keyLabel(key), entries: entriesValue(data[key]) }));

    const imageRef = statblockImage(data);
    if (imageRef !== this.imageRef) {
      this.imageRef = imageRef;
      this.imageUrlDraft = /^https?:\/\//i.test(imageRef) ? imageRef : '';
      this.resolveImage();
    }
  }

  private fieldView(field: StatblockField): FieldView {
    return {
      key: field.key,
      label: field.label,
      value: textValue(this.data[field.key]),
      placeholder: field.placeholder ?? '',
      extraKey: field.extraKey,
      extraLabel: field.extraLabel,
      extraValue: field.extraKey ? textValue(this.data[field.extraKey]) : undefined,
    };
  }

  /** Blocks worth showing when reading: empty ones are hidden. */
  visible(block: BlockView): boolean {
    switch (block.kind) {
      case 'fields':
        return block.fields.some(field => field.value);
      case 'scores':
        return block.items.some(item => item.value);
      case 'entries':
        return block.entries.length > 0;
      case 'text':
        return !!block.value;
    }
  }

  /** Statblock text with **bold**, *italic*, [[links]] and clickable dice (`2d6 + 3`). */
  html(text: string): SafeHtml {
    let cached = this.htmlCache.get(text);
    if (!cached) {
      const markup = text
        .split(/(\[\[[^\]]+\]\])/)
        .map(segment => {
          const link = segment.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
          return link
            ? `<a class="sb-link" href="#" data-link="${escapeHtml(link[1].trim())}">${escapeHtml((link[2] ?? link[1]).trim())}</a>`
            : diceHtml(segment);
        })
        .join('')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\n/g, '<br>');
      // Escaped above; only the tags added here are markup.
      cached = this.sanitizer.bypassSecurityTrustHtml(markup);
      this.htmlCache.set(text, cached);
    }
    return cached;
  }

  onTextClick(event: MouseEvent): void {
    const dice = (event.target as HTMLElement).closest<HTMLElement>('.sb-dice');
    if (dice) {
      event.preventDefault();
      this.rollDice(dice, event.shiftKey);
      return;
    }

    const link = (event.target as HTMLElement).closest('a.sb-link') as HTMLElement | null;
    if (!link) return;
    event.preventDefault();
    this.openNote.emit(link.dataset['link'] ?? '');
  }

  /** Shift+click on dice posts the roll; don't let it extend the text selection too. */
  onTextMouseDown(event: MouseEvent): void {
    if (event.shiftKey && (event.target as HTMLElement).closest('.sb-dice')) event.preventDefault();
  }

  /** Enter or Space on focused dice rolls them (Shift to post). */
  onTextKeydown(event: KeyboardEvent): void {
    const dice = (event.target as HTMLElement).closest<HTMLElement>('.sb-dice');
    if (!dice || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    this.rollDice(dice, event.shiftKey);
  }

  /** Rolls clicked dice, labelled with the entry they're in, e.g. "Bite (Adult Red Dragon)". */
  private rollDice(element: HTMLElement, post: boolean): void {
    const expression = element.dataset['dice'];
    if (!expression) return;
    const entry = element.closest<HTMLElement>('[data-roll-label]')?.dataset['rollLabel']?.trim();
    const label = entry && this.name ? `${entry} (${this.name})` : entry || this.name || undefined;
    this.diceRolls.roll(expression, { label, post });
  }

  // ---- Header ----

  toggleExpanded(): void {
    if (this.mode !== 'embed') return;
    this.expanded = !this.expanded;
    const open = readOpenEmbeds();
    if (this.expanded) open.add(this.notePath);
    else open.delete(this.notePath);
    writeOpenEmbeds(open);
  }

  toggleEditing(): void {
    if (!this.canEdit) return;
    this.editing = !this.editing;
    this.showSource = false;
    this.tab = 'stats';
  }

  setTab(tab: 'stats' | 'properties'): void {
    this.tab = tab;
    if (tab === 'properties') void this.loadUsedIn();
  }

  // ---- Editing ----

  /**
   * A field was typed in (`final` once it loses focus). While typing the text is stored exactly as
   * typed, so the input never changes under the cursor; on blur it's tidied (trimmed, numbers).
   */
  setField(key: string, text: string, final = false): void {
    if (!this.canEdit) return;
    const value = final ? scalar(text) : asTyped(text);
    if (value === '' || (typeof value === 'string' && final && !value.trim())) delete this.data[key];
    else this.data[key] = value;
    if (!final || !sameStored(this.parsed.data[key], this.data[key])) this.commit();
  }

  setScore(key: string, index: number, count: number, text: string, final = false): void {
    if (!this.canEdit) return;
    // An emptied box is filled in on blur, not while the next number is being typed.
    if (!text.trim() && !final) return;
    const current = Array.isArray(this.data[key]) ? [...(this.data[key] as unknown[])] : [];
    while (current.length < count) current.push(0);
    const value = text.trim() ? (final ? scalar(text) : asTyped(text)) : 0;
    if (sameStored(current[index], value)) return;
    current[index] = value;
    this.data[key] = current;
    this.commit();
  }

  setEntry(key: string, index: number, field: 'name' | 'desc', text: string): void {
    if (!this.canEdit) return;
    const list = this.entryList(key);
    if (!list[index]) return;
    list[index] = { ...list[index], [field]: text };
    this.data[key] = list;
    this.commit();
  }

  addEntry(key: string): void {
    if (!this.canEdit) return;
    this.data[key] = [...this.entryList(key), { name: '', desc: '' }];
    this.commit();
  }

  removeEntry(key: string, index: number): void {
    if (!this.canEdit) return;
    const list = this.entryList(key);
    list.splice(index, 1);
    this.data[key] = list;
    this.commit();
  }

  /** Entries as objects, keeping keys the app doesn't know (e.g. Fantasy Statblocks' `dice`). */
  private entryList(key: string): Record<string, unknown>[] {
    const raw = this.data[key];
    const items = Array.isArray(raw) ? raw : [];
    return entriesValue(raw).map((entry, i) => {
      const original = items[i];
      const base = original && typeof original === 'object' && !Array.isArray(original) ? original as Record<string, unknown> : {};
      const { description: _d, text: _t, ...rest } = base;
      return { ...rest, name: entry.name, desc: entry.desc };
    });
  }

  setSystem(id: string): void {
    if (!this.canEdit) return;
    this.data['system'] = id;
    this.commit();
  }

  toggleSource(): void {
    this.showSource = !this.showSource;
    this.sourceDraft = this.lastEmitted ?? this.source;
  }

  /** The YAML edited by hand: used as is. */
  onSourceInput(text: string): void {
    if (this.mode !== 'block' || this.readonly) return;
    this.sourceDraft = text;
    this.parsed = parseStatblock(text, this.kind);
    this.data = structuredClone(this.parsed.data);
    this.rebuild();
    this.emit(text);
  }

  private commit(): void {
    const text = serializeStatblock(this.parsed, this.data);
    // Later edits apply to what was just written, so only their own keys change.
    this.parsed = parseStatblock(text, this.kind);
    this.data = structuredClone(this.parsed.data);
    this.sourceDraft = text;
    this.rebuild();
    this.emit(text);
  }

  private emit(text: string): void {
    this.lastEmitted = text;
    this.sourceChange.emit(text);
  }

  // ---- Token picture ----

  private get index(): VaultIndex | null {
    return this.serverId ? this.vaultIndexService.get(this.serverId) : null;
  }

  private resolveImage(): void {
    const ref = this.imageRef;
    if (!ref) {
      this.imagePath = null;
      return;
    }
    if (/^https?:\/\//i.test(ref)) {
      this.imagePath = ref;
      this.loadImage(ref);
      return;
    }

    const index = this.index;
    if (!index && this.serverId) {
      void this.vaultIndexService.load(this.serverId).then(() => this.resolveImage()).catch(() => undefined);
    }
    const entry = index?.resolveFile(ref, this.notePath) ?? index?.resolveLink(ref, this.notePath) ?? null;
    if (entry?.kind === 'file' && getVaultFileType(entry.name).viewer === 'image') {
      this.imagePath = entry.relativePath;
    } else {
      // Not in the index yet (e.g. just uploaded): use it as a vault path if it looks like an image.
      this.imagePath = getVaultFileType(ref).viewer === 'image' ? ref.replace(/^\/+/, '') : null;
    }
    if (this.imagePath) this.loadImage(this.imagePath);
  }

  private loadImage(path: string): void {
    if (path in this.imageUrls || this.loadingImages.has(path)) return;
    if (/^https?:\/\//i.test(path)) {
      this.imageUrls = { ...this.imageUrls, [path]: path };
      return;
    }
    if (!this.serverId) return;
    this.loadingImages.add(path);
    const serverId = this.serverId;
    void this.vaultService.readFileAsBlob(serverId, path)
      .then(blob => {
        if (serverId === this.serverId) this.imageUrls = { ...this.imageUrls, [path]: URL.createObjectURL(blob) };
      })
      .catch(() => (this.imageUrls = { ...this.imageUrls, [path]: '' }))
      .finally(() => this.loadingImages.delete(path));
  }

  imageUrlFor(path: string): string {
    return this.imageUrls[path] ?? '';
  }

  private setImage(ref: string | null): void {
    if (!this.canEdit) return;
    if (ref) this.data['image'] = ref;
    else delete this.data['image'];
    delete this.data['token'];
    this.commit();
  }

  applyImageUrl(): void {
    const url = this.imageUrlDraft.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      this.snackBar.open('Enter a web address starting with http:// or https://.', 'OK', { duration: 4000 });
      return;
    }
    this.setImage(url);
  }

  clearImage(): void {
    this.imageUrlDraft = '';
    this.setImage(null);
  }

  openPicker(): void {
    if (!this.canEdit) return;
    this.isPicking = true;
    this.pickerQuery = '';
    this.updatePicker();
  }

  closePicker(): void {
    this.isPicking = false;
  }

  /** The vault's images matching the filter, the note's own folder first. */
  updatePicker(): void {
    const q = this.pickerQuery.trim().toLowerCase();
    const folder = this.notePath.split('/').slice(0, -1).join('/');
    const images = (this.index?.files ?? [])
      .filter(entry => getVaultFileType(entry.name).viewer === 'image')
      .filter(entry => !q || entry.relativePath.toLowerCase().includes(q))
      .sort((a, b) =>
        Number(b.parentPath === folder) - Number(a.parentPath === folder) || a.relativePath.localeCompare(b.relativePath));
    this.pickerTotal = images.length;
    this.pickerImages = images.slice(0, PICKER_LIMIT);
    this.pickerImages.forEach(image => this.loadThumb(image.relativePath));
  }

  /** Picker thumbnails: small cached previews, not the full images (see VaultImageService). */
  private loadThumb(path: string): void {
    if (this.thumbUrls[path] !== undefined || !this.serverId) return;
    const serverId = this.serverId;
    void this.vaultImages.thumbnail(serverId, path).then(url => {
      if (serverId === this.serverId) this.thumbUrls = { ...this.thumbUrls, [path]: url ?? '' };
    });
  }

  /** The filter waits for a pause in typing, so each letter doesn't rebuild the grid. */
  onPickerQueryChange(): void {
    if (this.pickerQueryTimer) clearTimeout(this.pickerQueryTimer);
    this.pickerQueryTimer = setTimeout(() => {
      this.pickerQueryTimer = undefined;
      this.updatePicker();
    }, 150);
  }


  pickImage(image: VaultEntry): void {
    const index = this.index;
    this.isPicking = false;
    this.setImage(`[[${index ? index.linkTextFor(image) : image.relativePath}]]`);
  }

  /** Saves a picture from the computer next to the note (named after the creature) and uses it. */
  async uploadImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canEdit || !this.serverId) return;

    const extension = getFileExtension(file.name) || file.type.split('/')[1] || 'png';
    if (getVaultFileType(`x.${extension}`).viewer !== 'image') {
      this.snackBar.open('Choose an image file (PNG, JPG, WebP, GIF or SVG).', 'OK', { duration: 4000 });
      return;
    }
    const folder = this.notePath.split('/').slice(0, -1).join('/');
    const base = (this.name || this.kindLabel).replace(/[\\/:*?"<>|#^[\]]+/g, '-').trim() || 'Token';
    const serverId = this.serverId;

    this.isUploading = true;
    try {
      let path = '';
      for (let i = 0; i < 100 && !path; i++) {
        const suffix = this.canAddToMap ? ' token' : '';
        const candidate = `${folder ? `${folder}/` : ''}${base}${suffix}${i ? ` ${i}` : ''}.${extension}`;
        if (!(await this.vaultService.fileExists(serverId, candidate))) path = candidate;
      }
      if (!path) throw new Error('No free file name.');
      await this.vaultService.writeFile(serverId, path, file);
      this.isPicking = false;
      this.setImage(`[[${path}]]`);
      this.filesAdded.emit();
    } catch (error) {
      console.error('[Statblock] Failed to save token picture:', error);
      this.snackBar.open('Couldn’t save that picture to the vault.', 'OK', { duration: 4000 });
    } finally {
      this.isUploading = false;
    }
  }

  // ---- Used in ----

  private async loadUsedIn(): Promise<void> {
    if (!this.serverId || !this.notePath || this.usedInLoading) return;
    this.usedInLoading = true;
    try {
      await this.vaultIndexService.ensureContentIndexed(this.serverId);
      const index = this.index;
      this.usedIn = (index?.getBacklinkMentions(this.notePath) ?? []).map(mention => ({
        entry: mention.source,
        // The index keeps a snippet per plain link but none for embeds, so no snippets = embed only.
        embedded: mention.snippets.length === 0,
      }));
    } finally {
      this.usedInLoading = false;
    }
  }

  displayName(entry: VaultEntry): string {
    return getVaultDisplayName(entry.name);
  }

  // ---- VTT ----

  setRollInitiative(value: boolean): void {
    this.rollInitiative = value;
    writeFlag(ROLL_INITIATIVE_KEY, value);
  }

  async addToMap(count = 1): Promise<void> {
    if (this.addingToMap || this.parsed.error) return;
    this.addingToMap = true;
    try {
      const result = await this.statblockVtt.addToVtt({
        serverId: this.serverId,
        notePath: this.notePath,
        data: this.data,
        kind: this.kind,
        count,
        rollInitiative: this.kind === 'creature' && this.rollInitiative,
      });
      if (!result.added) {
        this.snackBar.open('Open or join the VTT map first.', 'OK', { duration: 3500 });
        return;
      }
      const what = result.added === 1 ? `${this.name || 'Token'}` : `${result.added} × ${this.name || 'token'}`;
      const rolls = result.initiative.length ? ` · initiative ${result.initiative.join(', ')}` : '';
      const problem = result.imageProblem ? ` (${result.imageProblem})` : '';
      this.snackBar.open(`Added ${what} to the map${rolls}${problem}.`, 'OK', { duration: 5000 });
    } catch (error) {
      console.error('[Statblock] Failed to add to the map:', error);
      this.snackBar.open('Couldn’t add the token to the map.', 'OK', { duration: 4000 });
    } finally {
      this.addingToMap = false;
    }
  }
}

/** Escaped text with each dice expression wrapped in a focusable, clickable span. */
function diceHtml(raw: string): string {
  let html = '';
  let last = 0;
  for (const match of findDiceExpressions(raw)) {
    html += escapeHtml(raw.slice(last, match.index));
    const expression = escapeHtml(match.text);
    html += `<span class="sb-dice" role="button" tabindex="0" data-dice="${expression}" title="Roll ${expression} (Shift+click to post it to chat)">${expression}</span>`;
    last = match.index + match.text.length;
  }
  return html + escapeHtml(raw.slice(last));
}

/** Text being typed, as stored: exactly as typed, except that a plain whole number is a number. */
function asTyped(text: string): string | number {
  return /^-?\d{1,11}$/.test(text) ? Number(text) : text;
}

function sameStored(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function readOpenEmbeds(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_EMBEDS_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeOpenEmbeds(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_EMBEDS_KEY, JSON.stringify(Array.from(open).slice(-200)));
  } catch {
    /* storage unavailable */
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable */
  }
}

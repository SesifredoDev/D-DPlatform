import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ObsidianVaultService, VaultEntry } from '../../../../shared/services/ObsidianVault/obsidian-vault-service';
import type { VaultIndex } from '../../../../shared/services/ObsidianVault/vault-index.service';
import { getFileExtension, getVaultDisplayName, getVaultFileType, isVaultFileType } from '../../../../shared/services/ObsidianVault/vault-file-types';
import {
  FamilyPerson,
  FamilyRelation,
  FamilyTree,
  PERSON_HEIGHT,
  PERSON_WIDTH,
  PersonPosition,
  PersonRelatives,
  addPerson,
  addRelation,
  layoutFamilyTree,
  noteImageCandidates,
  parseFamilyTree,
  relativesOf,
  removePerson,
  removeRelation,
  serializeFamilyTree,
  updatePerson,
} from '../../../../shared/services/ObsidianVault/family-tree';

type RelativeKind = 'parent' | 'spouse' | 'child';

interface Card {
  person: FamilyPerson;
  x: number;
  y: number;
  /** The linked note, if the link resolves. */
  note: VaultEntry | null;
  /** The picture to show: a vault path or a web URL; null when there is none (yet). */
  portrait: string | null;
  /** True when the picture comes from the linked note rather than the person's own portrait. */
  portraitFromNote: boolean;
}

interface Suggestion {
  kind: 'person' | 'note';
  label: string;
  hint: string;
  person?: FamilyPerson;
  note?: VaultEntry;
}

const MIN_ZOOM = 0.15;
/** Thumbnails shown at once in the "Choose from vault" picker; type to narrow the rest. */
const PICKER_LIMIT = 60;
const MAX_ZOOM = 2.5;

/**
 * A family tree file (see family-tree.ts), laid out by generation. Click a person to edit them, link
 * them to a note, and add parents, spouses and children; every change is written back to the file.
 */
@Component({
  selector: 'app-family-tree',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './family-tree.component.html',
  styleUrl: './family-tree.component.scss',
})
export class FamilyTreeComponent implements OnChanges, OnDestroy {
  /** The tree file's text. */
  @Input() content: string | null = null;
  @Input() path: string | null = null;
  @Input() index: VaultIndex | null = null;
  @Input() indexVersion = 0;
  @Input() readonly = false;
  /** Needed to load portraits and to save uploaded ones. */
  @Input() serverId = '';
  @Output() contentChange = new EventEmitter<string>();
  /** A portrait was uploaded into the vault, so the file list should be refreshed. */
  @Output() filesAdded = new EventEmitter<void>();
  @Output() openFile = new EventEmitter<string>();

  @ViewChild('viewport') private viewportRef?: ElementRef<HTMLElement>;
  @ViewChild('nameInput') private nameInputRef?: ElementRef<HTMLInputElement>;
  /** Focuses the picker's filter when it opens, so typing and Esc work straight away. */
  @ViewChild('pickerSearch') private set pickerSearch(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref) setTimeout(() => ref.nativeElement.focus());
  }

  readonly cardWidth = PERSON_WIDTH;
  readonly cardHeight = PERSON_HEIGHT;

  tree: FamilyTree = { people: [], relations: [] };
  cards: Card[] = [];
  connectors: { d: string; kind: FamilyRelation['kind'] }[] = [];
  parseError: string | null = null;

  selectedId: string | null = null;
  relatives: PersonRelatives = { parents: [], spouses: [], children: [] };
  nameDraft = '';
  detailsDraft = '';
  noteQuery = '';
  relativeKind: RelativeKind = 'child';
  relativeQuery = '';
  activeSuggestion = -1;
  relationError = '';

  transform = { k: 1, x: 40, y: 40 };
  private positions = new Map<string, PersonPosition>();
  private lastEmitted: string | null = null;
  private needsFit = true;
  private pointer: { id: number; startX: number; startY: number; tx: number; ty: number; moved: boolean } | null = null;

  /** Object URLs (or web URLs) per image path; '' when the image couldn't be loaded. */
  imageUrls: Record<string, string> = {};
  isUploadingPortrait = false;
  /** The "Choose from vault" image browser. */
  isPickingPortrait = false;
  pickerQuery = '';
  pickerImages: VaultEntry[] = [];
  pickerTotal = 0;
  private readonly loadingImages = new Set<string>();
  /** First image of each linked note, keyed by note path, with the note's modified time it was read at. */
  private readonly noteImages = new Map<string, { modified: number | null; image: string | null }>();
  private readonly loadingNotes = new Set<string>();

  constructor(private snackBar: MatSnackBar, private vaultService: ObsidianVaultService) {}

  ngOnDestroy(): void {
    Object.values(this.imageUrls).forEach(url => url.startsWith('blob:') && URL.revokeObjectURL(url));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['path']) {
      this.selectedId = null;
      this.needsFit = true;
    }
    if (changes['content'] && this.content !== this.lastEmitted) {
      this.load(this.content);
    } else if (changes['indexVersion'] || changes['index']) {
      this.refreshCards();
    }
  }

  // ---- Reading ----

  get selected(): Card | null {
    return this.cards.find(card => card.person.id === this.selectedId) ?? null;
  }

  get hasTree(): boolean {
    return this.content !== null && !!this.path;
  }

  get svgWidth(): number {
    return Math.max(0, ...this.cards.map(card => card.x + PERSON_WIDTH));
  }

  get svgHeight(): number {
    return Math.max(0, ...this.cards.map(card => card.y + PERSON_HEIGHT));
  }

  private load(content: string | null): void {
    this.lastEmitted = content;
    if (content === null) {
      this.tree = { people: [], relations: [] };
      this.parseError = null;
    } else {
      try {
        this.tree = parseFamilyTree(content);
        this.parseError = null;
      } catch {
        this.tree = { people: [], relations: [] };
        this.parseError = 'This file isn’t a valid family tree, so it can’t be shown. Fix or restore it outside the app.';
      }
    }
    this.refresh();
  }

  private refresh(): void {
    this.positions = layoutFamilyTree(this.tree);
    if (this.selectedId && !this.tree.people.some(person => person.id === this.selectedId)) this.selectedId = null;
    this.refreshCards();
    this.connectors = this.buildConnectors();
    if (this.needsFit && this.tree.people.length) {
      this.needsFit = false;
      setTimeout(() => this.fit());
    }
  }

  private refreshCards(): void {
    this.cards = this.tree.people.map(person => {
      const position = this.positions.get(person.id) ?? { x: 0, y: 0, generation: 0 };
      const note = this.resolve(person.link);
      const own = person.portrait ? this.resolveImage(person.portrait, this.path ?? '') : null;
      const fromNote = !own && note ? this.noteImage(note) : null;
      const portrait = own ?? fromNote;
      if (portrait) this.loadImage(portrait);
      return { person, x: position.x, y: position.y, note, portrait, portraitFromNote: !own && !!fromNote };
    });
    this.relatives = this.selectedId ? relativesOf(this.tree, this.selectedId) : { parents: [], spouses: [], children: [] };
  }

  // ---- Portraits ----

  /** An image path (or web URL) for a portrait reference, or null if it isn't an image. */
  private resolveImage(raw: string, fromPath: string): string | null {
    const text = raw.trim().replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    const entry = this.index?.resolveFile(text, fromPath);
    if (entry) return getVaultFileType(entry.name).viewer === 'image' ? entry.relativePath : null;
    // Not in the index yet (e.g. just uploaded): use it as a vault path if it looks like an image.
    return getVaultFileType(text).viewer === 'image' ? text.replace(/^\/+/, '') : null;
  }

  /** The first image in a linked note; read in the background the first time (and when the note changes). */
  private noteImage(note: VaultEntry): string | null {
    const modified = this.index?.getModified(note.relativePath) ?? null;
    const cached = this.noteImages.get(note.relativePath);
    if (cached && (cached.modified === modified || this.loadingNotes.has(note.relativePath))) return cached.image;
    if (!this.loadingNotes.has(note.relativePath) && this.serverId) {
      this.loadingNotes.add(note.relativePath);
      const serverId = this.serverId;
      void this.vaultService.readFile(serverId, note.relativePath)
        .then(content => {
          if (serverId !== this.serverId) return;
          const image = noteImageCandidates(content)
            .map(candidate => this.resolveImage(candidate, note.relativePath))
            .find((path): path is string => !!path) ?? null;
          this.noteImages.set(note.relativePath, { modified, image });
        })
        .catch(() => this.noteImages.set(note.relativePath, { modified, image: null }))
        .finally(() => {
          this.loadingNotes.delete(note.relativePath);
          this.refreshCards();
        });
    }
    return cached?.image ?? null;
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
        if (serverId !== this.serverId) return;
        this.imageUrls = { ...this.imageUrls, [path]: URL.createObjectURL(blob) };
      })
      .catch(() => {
        this.imageUrls = { ...this.imageUrls, [path]: '' };
      })
      .finally(() => this.loadingImages.delete(path));
  }

  portraitLabel(card: Card): string {
    if (card.person.portrait) {
      return card.portrait ? (card.portrait.split('/').pop() || card.portrait) : `Image not found: ${card.person.portrait}`;
    }
    if (card.portraitFromNote) return 'From the linked note';
    return card.note ? 'No image in the linked note' : 'No portrait';
  }

  portraitUrl(card: Card): string {
    return card.portrait ? this.imageUrls[card.portrait] ?? '' : '';
  }

  // ---- Choose from vault ----

  openPortraitPicker(): void {
    if (this.readonly || !this.selected) return;
    this.isPickingPortrait = true;
    this.pickerQuery = '';
    this.updatePickerImages();
  }

  closePortraitPicker(): void {
    this.isPickingPortrait = false;
  }

  /**
   * The vault's images matching the filter, the person's own folder (and their note's) first, capped
   * so a big vault doesn't load hundreds of thumbnails at once.
   */
  updatePickerImages(): void {
    const q = this.pickerQuery.trim().toLowerCase();
    const card = this.selected;
    const near = new Set([
      (this.path ?? '').split('/').slice(0, -1).join('/'),
      card?.note?.parentPath ?? '',
    ].filter(Boolean));
    const images = (this.index?.files ?? [])
      .filter(entry => getVaultFileType(entry.name).viewer === 'image')
      .filter(entry => !q || entry.relativePath.toLowerCase().includes(q))
      .sort((a, b) =>
        Number(near.has(b.parentPath)) - Number(near.has(a.parentPath)) || a.relativePath.localeCompare(b.relativePath));
    this.pickerTotal = images.length;
    this.pickerImages = images.slice(0, PICKER_LIMIT);
    this.pickerImages.forEach(image => this.loadImage(image.relativePath));
  }

  pickPortrait(image: VaultEntry): void {
    const card = this.selected;
    if (!card || !this.index || this.readonly) return;
    this.commit(updatePerson(this.tree, card.person.id, { portrait: this.index.linkTextFor(image) }));
    this.isPickingPortrait = false;
  }

  clearPortrait(): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    this.commit(updatePerson(this.tree, card.person.id, { portrait: null }));
  }

  /** Saves a picked image file next to the tree (named after the person) and uses it as the portrait. */
  async uploadPortrait(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const card = this.selected;
    if (!file || !card || this.readonly || !this.serverId) return;

    const extension = getFileExtension(file.name) || file.type.split('/')[1] || 'png';
    if (getVaultFileType(`x.${extension}`).viewer !== 'image') {
      this.snackBar.open('Choose an image file (PNG, JPG, WebP, GIF or SVG).', 'OK', { duration: 4000 });
      return;
    }
    const folder = (this.path ?? '').split('/').slice(0, -1).join('/');
    const base = (card.person.name || 'Portrait').replace(/[\\/:*?"<>|#^[\]]+/g, '-').trim() || 'Portrait';
    const serverId = this.serverId;
    const personId = card.person.id;

    this.isUploadingPortrait = true;
    try {
      let path = '';
      for (let i = 0; i < 100; i++) {
        const candidate = `${folder ? `${folder}/` : ''}${base}${i ? ` ${i}` : ''}.${extension}`;
        if (!(await this.vaultService.fileExists(serverId, candidate))) {
          path = candidate;
          break;
        }
      }
      if (!path) throw new Error('No free file name.');
      await this.vaultService.writeFile(serverId, path, file);
      this.commit(updatePerson(this.tree, personId, { portrait: path }));
      this.isPickingPortrait = false;
      this.filesAdded.emit();
    } catch (err) {
      console.error('Failed to save portrait:', err);
      this.snackBar.open('Couldn’t save that image to the vault.', 'OK', { duration: 4000 });
    } finally {
      this.isUploadingPortrait = false;
    }
  }

  private resolve(link: string | null): VaultEntry | null {
    if (!link || !this.index) return null;
    const entry = this.index.getByPath(link) ?? this.index.resolveLink(link, this.path ?? '');
    return entry?.kind === 'file' ? entry : null;
  }

  /** Elbow lines: parents drop to a join line, then a bus over their children; spouses side to side. */
  private buildConnectors(): { d: string; kind: FamilyRelation['kind'] }[] {
    const at = (id: string) => this.positions.get(id);
    const connectors: { d: string; kind: FamilyRelation['kind'] }[] = [];

    for (const relation of this.tree.relations) {
      if (relation.kind !== 'spouse') continue;
      const a = at(relation.from);
      const b = at(relation.to);
      if (!a || !b) continue;
      const [left, right] = a.x <= b.x ? [a, b] : [b, a];
      const d = left.y === right.y
        ? `M${left.x + PERSON_WIDTH} ${left.y + PERSON_HEIGHT / 2}H${right.x}`
        : `M${left.x + PERSON_WIDTH / 2} ${left.y + PERSON_HEIGHT / 2}L${right.x + PERSON_WIDTH / 2} ${right.y + PERSON_HEIGHT / 2}`;
      connectors.push({ d, kind: 'spouse' });
    }

    // Children grouped by their set of parents.
    const parentsOf = new Map<string, string[]>();
    for (const relation of this.tree.relations) {
      if (relation.kind === 'parent') parentsOf.set(relation.to, [...(parentsOf.get(relation.to) ?? []), relation.from]);
    }
    const families = new Map<string, { parents: string[]; children: string[] }>();
    for (const [child, parents] of parentsOf) {
      const key = [...parents].sort().join('|');
      const family = families.get(key) ?? { parents, children: [] };
      family.children.push(child);
      families.set(key, family);
    }

    const busesPerRow = new Map<number, number>();
    for (const family of families.values()) {
      const parents = family.parents.map(at).filter((p): p is PersonPosition => !!p);
      const children = family.children.map(at).filter((p): p is PersonPosition => !!p);
      if (!parents.length || !children.length) continue;

      const parentXs = parents.map(p => p.x + PERSON_WIDTH / 2);
      const joinY = Math.max(...parents.map(p => p.y + PERSON_HEIGHT)) + 16;
      const anchorX = parentXs.reduce((sum, x) => sum + x, 0) / parentXs.length;
      const childTop = Math.min(...children.map(c => c.y));
      const busIndex = busesPerRow.get(childTop) ?? 0;
      busesPerRow.set(childTop, busIndex + 1);
      const busY = Math.max(joinY, childTop - 30 - (busIndex % 3) * 8);
      const childXs = children.map(c => c.x + PERSON_WIDTH / 2);

      let d = parents.map((p, i) => `M${parentXs[i]} ${p.y + PERSON_HEIGHT}V${joinY}`).join('');
      if (parents.length > 1) d += `M${Math.min(...parentXs)} ${joinY}H${Math.max(...parentXs)}`;
      d += `M${anchorX} ${joinY}V${busY}`;
      d += `M${Math.min(anchorX, ...childXs)} ${busY}H${Math.max(anchorX, ...childXs)}`;
      d += children.map((c, i) => `M${childXs[i]} ${busY}V${c.y}`).join('');
      connectors.push({ d, kind: 'parent' });
    }
    return connectors;
  }

  // ---- Writing ----

  private commit(tree: FamilyTree): void {
    this.tree = tree;
    const text = serializeFamilyTree(tree);
    this.lastEmitted = text;
    this.refresh();
    this.contentChange.emit(text);
  }

  addStandalonePerson(): void {
    if (this.readonly || !this.hasTree) return;
    const { tree, id } = addPerson(this.tree, { name: 'New person' });
    this.commit(tree);
    this.select(id, true);
  }

  saveName(): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    const name = this.nameDraft.trim();
    if (!name) {
      this.nameDraft = card.person.name;
      return;
    }
    if (name !== card.person.name) this.commit(updatePerson(this.tree, card.person.id, { name }));
  }

  saveDetails(): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    const details = this.detailsDraft.trim();
    if (details !== card.person.details) this.commit(updatePerson(this.tree, card.person.id, { details }));
  }

  linkNote(note: VaultEntry): void {
    const card = this.selected;
    if (!card || !this.index || this.readonly) return;
    // A placeholder name takes the note's name.
    const keepName = card.person.name && card.person.name !== 'New person' && card.person.name !== 'Unnamed';
    const name = keepName ? card.person.name : getVaultDisplayName(note.name);
    this.commit(updatePerson(this.tree, card.person.id, { link: this.index.linkTextFor(note), name }));
    this.nameDraft = name;
    this.noteQuery = '';
  }

  unlinkNote(): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    this.commit(updatePerson(this.tree, card.person.id, { link: null }));
  }

  deleteSelected(): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    const before = serializeFamilyTree(this.tree);
    this.selectedId = null;
    this.commit(removePerson(this.tree, card.person.id));
    const ref = this.snackBar.open(`Removed ${card.person.name || 'person'} from the tree.`, 'Undo', { duration: 6000 });
    ref.onAction().subscribe(() => {
      this.load(before);
      this.lastEmitted = before;
      this.contentChange.emit(before);
      this.select(card.person.id);
    });
  }

  removeRelationById(relation: FamilyRelation): void {
    if (this.readonly) return;
    this.commit(removeRelation(this.tree, relation.id));
  }

  /** Adds a relative of the selected person: an existing person, a new one linked to a note, or a new named one. */
  addRelative(suggestion?: Suggestion): void {
    const card = this.selected;
    if (!card || this.readonly) return;
    this.relationError = '';

    let tree = this.tree;
    let otherId: string;
    if (suggestion?.person) {
      otherId = suggestion.person.id;
    } else if (suggestion?.note && this.index) {
      const added = addPerson(tree, { name: getVaultDisplayName(suggestion.note.name), link: this.index.linkTextFor(suggestion.note) });
      tree = added.tree;
      otherId = added.id;
    } else {
      const name = this.relativeQuery.trim();
      if (!name) return;
      const added = addPerson(tree, { name });
      tree = added.tree;
      otherId = added.id;
    }

    const me = card.person.id;
    const result = this.relativeKind === 'parent'
      ? addRelation(tree, 'parent', otherId, me)
      : this.relativeKind === 'child'
        ? addRelation(tree, 'parent', me, otherId)
        : addRelation(tree, 'spouse', me, otherId);
    if (result.error) {
      this.relationError = result.error;
      return;
    }

    // A new child of someone with exactly one spouse is usually that couple's child.
    let next = result.tree;
    if (this.relativeKind === 'child' && !suggestion?.person && this.relatives.spouses.length === 1) {
      next = addRelation(next, 'parent', this.relatives.spouses[0].person.id, otherId).tree;
    }
    this.commit(next);
    this.relativeQuery = '';
    this.activeSuggestion = -1;
  }

  // ---- Suggestions ----

  get noteSuggestions(): VaultEntry[] {
    return this.matchNotes(this.noteQuery, 8);
  }

  get relativeSuggestions(): Suggestion[] {
    const query = this.relativeQuery.trim().toLowerCase();
    if (!query) return [];
    const me = this.selectedId;
    const people: Suggestion[] = this.tree.people
      .filter(person => person.id !== me && person.name.toLowerCase().includes(query))
      .slice(0, 5)
      .map(person => ({ kind: 'person', label: person.name, hint: 'In this tree', person }));
    const linked = new Set(this.cards.map(card => card.note?.relativePath).filter(Boolean));
    const notes: Suggestion[] = this.matchNotes(query, 6)
      .filter(note => !linked.has(note.relativePath))
      .map(note => ({ kind: 'note', label: getVaultDisplayName(note.name), hint: note.parentPath || 'Note', note }));
    return [...people, ...notes];
  }

  private matchNotes(query: string, limit: number): VaultEntry[] {
    const q = query.trim().toLowerCase();
    if (!q || !this.index) return [];
    const notes = this.index.files.filter(entry => isVaultFileType(entry.name, 'markdown'));
    const starts: VaultEntry[] = [];
    const contains: VaultEntry[] = [];
    for (const note of notes) {
      const name = getVaultDisplayName(note.name).toLowerCase();
      if (name.startsWith(q)) starts.push(note);
      else if (name.includes(q) || note.relativePath.toLowerCase().includes(q)) contains.push(note);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
  }

  onRelativeKeydown(event: KeyboardEvent): void {
    const suggestions = this.relativeSuggestions;
    if (event.key === 'ArrowDown' && suggestions.length) {
      this.activeSuggestion = (this.activeSuggestion + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      this.activeSuggestion = this.activeSuggestion <= 0 ? suggestions.length - 1 : this.activeSuggestion - 1;
    } else if (event.key === 'Enter') {
      this.addRelative(suggestions[this.activeSuggestion]);
    } else if (event.key === 'Escape') {
      if (!this.relativeQuery) return;
      this.relativeQuery = '';
      this.activeSuggestion = -1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  onNoteQueryKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.noteSuggestions.length) {
      event.preventDefault();
      this.linkNote(this.noteSuggestions[0]);
    } else if (event.key === 'Escape' && this.noteQuery) {
      event.preventDefault();
      event.stopPropagation();
      this.noteQuery = '';
    }
  }

  // ---- Selection ----

  select(id: string | null, focusName = false): void {
    this.selectedId = id;
    const card = this.selected;
    this.nameDraft = card?.person.name ?? '';
    this.detailsDraft = card?.person.details ?? '';
    this.noteQuery = '';
    this.isPickingPortrait = false;
    this.relativeQuery = '';
    this.relationError = '';
    this.activeSuggestion = -1;
    this.relatives = id ? relativesOf(this.tree, id) : { parents: [], spouses: [], children: [] };
    if (focusName) {
      setTimeout(() => {
        this.nameInputRef?.nativeElement.focus();
        this.nameInputRef?.nativeElement.select();
      });
    }
  }

  onCardKeydown(event: KeyboardEvent, card: Card): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (event.key === 'Enter' && this.selectedId === card.person.id && card.note) this.openFile.emit(card.note.relativePath);
      else this.select(card.person.id);
    }
  }

  openCard(card: Card): void {
    if (card.note) this.openFile.emit(card.note.relativePath);
  }

  // ---- Pan and zoom ----

  get transformAttr(): string {
    return `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.k})`;
  }

  fit(): void {
    const viewport = this.viewportRef?.nativeElement;
    if (!viewport || !this.cards.length) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const padding = 40;
    const contentWidth = this.svgWidth || 1;
    const contentHeight = this.svgHeight || 1;
    const k = clamp(Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight), MIN_ZOOM, 1.2);
    this.transform = { k, x: (width - contentWidth * k) / 2, y: Math.max(padding, (height - contentHeight * k) / 2) };
  }

  zoomBy(factor: number): void {
    const viewport = this.viewportRef?.nativeElement;
    if (!viewport) return;
    this.zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    // Cards and the empty-state buttons handle their own clicks.
    if ((event.target as Element).closest('.person, button, input, select, textarea')) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, tx: this.transform.x, ty: this.transform.y, moved: false };
  }

  onPointerMove(event: PointerEvent): void {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
    pointer.moved = true;
    this.transform = { ...this.transform, x: pointer.tx + dx, y: pointer.ty + dy };
  }

  onPointerUp(): void {
    // A click on the background (not a drag) clears the selection.
    if (this.pointer && !this.pointer.moved) this.select(null);
    this.pointer = null;
  }

  onViewportKeydown(event: KeyboardEvent): void {
    if ((event.target as Element).closest('.person')) {
      if (event.key === 'Escape') this.select(null);
      return;
    }
    const pan = 60;
    switch (event.key) {
      case '+':
      case '=': this.zoomBy(1.25); break;
      case '-': this.zoomBy(0.8); break;
      case '0': this.fit(); break;
      case 'ArrowLeft': this.transform = { ...this.transform, x: this.transform.x + pan }; break;
      case 'ArrowRight': this.transform = { ...this.transform, x: this.transform.x - pan }; break;
      case 'ArrowUp': this.transform = { ...this.transform, y: this.transform.y + pan }; break;
      case 'ArrowDown': this.transform = { ...this.transform, y: this.transform.y - pan }; break;
      case 'Escape': this.select(null); break;
      default: return;
    }
    event.preventDefault();
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const { k, x, y } = this.transform;
    const next = clamp(k * factor, MIN_ZOOM, MAX_ZOOM);
    this.transform = { k: next, x: sx - ((sx - x) / k) * next, y: sy - ((sy - y) / k) * next };
  }

  truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  displayName(entry: VaultEntry): string {
    return getVaultDisplayName(entry.name);
  }

  firstLine(text: string): string {
    return text.split('\n')[0];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

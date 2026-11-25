import { Component, ElementRef, EventEmitter, HostBinding, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  NoteProperty,
  PropertyType,
  PropertyValue,
  convertProperty,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
} from '../../../../shared/services/ObsidianVault/frontmatter';
import type { PropertyTypeMap, VaultIndex } from '../../../../shared/services/ObsidianVault/vault-index.service';
import { getVaultDisplayName } from '../../../../shared/services/ObsidianVault/vault-file-types';
import { fuzzyMatch } from '../../../../shared/services/ObsidianVault/vault-search-utils';

type EditableType = PropertyValue['type'];

interface PropertyRow extends NoteProperty {
  /** Type shown and written: the parsed type, or for empty values the assigned/usual type. */
  shownType: PropertyType;
  /** Text split into plain parts and `[[links]]`, for the read view of text values. */
  segments: ValueSegment[];
  hasLinks: boolean;
}

interface ValueSegment {
  text: string;
  /** Link target (no alias) when this part is a `[[link]]`. */
  link: string | null;
}

interface Suggestion {
  label: string;
  detail: string;
  /** What gets inserted (a `[[link]]`, a value or a key). */
  insert: string;
  kind: 'link' | 'value' | 'key';
}

interface SuggestState {
  /** The input the list belongs to: a property key, or '' for the new-property input. */
  key: string;
  field: 'value' | 'item' | 'newKey';
  items: Suggestion[];
  active: number;
  /** For link suggestions: where `[[` starts in the input. */
  linkStart: number;
}

const OPEN_STORAGE_KEY = 'obsidian-view.properties-open';
const MAX_SUGGESTIONS = 8;
const LINK = /\[\[([^\]]+)\]\]/g;

export const PROPERTY_TYPES: { type: EditableType; label: string; icon: string }[] = [
  { type: 'text', label: 'Text', icon: 'notes' },
  { type: 'list', label: 'List', icon: 'format_list_bulleted' },
  { type: 'number', label: 'Number', icon: 'pin' },
  { type: 'checkbox', label: 'Checkbox', icon: 'check_box' },
  { type: 'date', label: 'Date', icon: 'calendar_today' },
  { type: 'datetime', label: 'Date & time', icon: 'schedule' },
];

/**
 * The note's frontmatter as a form (Obsidian's Properties view). Every edit rewrites only the lines
 * of the property that changed and is emitted as the note's full new content. `tags` aren't shown
 * here: the tag row under the title edits them.
 */
@Component({
  selector: 'app-note-properties',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './note-properties.component.html',
  styleUrl: './note-properties.component.scss',
})
export class NotePropertiesComponent implements OnChanges {
  @Input() content = '';
  @Input() filePath = '';
  @Input() readonly = false;
  @Input() index: VaultIndex | null = null;
  /** The index's content version; the index changes in place, so this tells us when to refresh. */
  @Input() indexVersion = 0;
  /** Types assigned in Obsidian (`.obsidian/types.json`), by lower-cased key. */
  @Input() typeHints: PropertyTypeMap = {};
  @Output() contentChange = new EventEmitter<string>();
  @Output() openLink = new EventEmitter<string>();

  readonly types = PROPERTY_TYPES;

  rows: PropertyRow[] = [];
  isOpen = readOpenFlag();
  isAdding = false;
  newKey = '';
  newKeyError = '';
  renamingKey: string | null = null;
  renameDraft = '';
  renameError = '';
  /** The text/number input being edited, and its unsaved text. */
  focusedKey: string | null = null;
  draft = '';
  /** Unsaved "add item" text per list property. */
  itemDrafts: Record<string, string> = {};
  suggest: SuggestState | null = null;

  /** Types chosen in this session for properties whose value is still empty. */
  private typeOverrides = new Map<string, EditableType>();
  private pendingFocusKey: string | null = null;
  /** Most used type per key in the vault; rebuilt with the rows. */
  private usualTypes: Map<string, EditableType> | null = null;

  constructor(private host: ElementRef<HTMLElement>) {}

  @HostBinding('class.is-hidden') get isHidden(): boolean {
    return !this.rows.length && !this.isAdding;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['filePath'] && !changes['filePath'].isFirstChange()) {
      this.typeOverrides.clear();
      this.isAdding = false;
      this.cancelRename();
      this.focusedKey = null;
      this.itemDrafts = {};
      this.suggest = null;
    }
    if (changes['content'] || changes['typeHints'] || changes['indexVersion'] || changes['filePath']) {
      this.rows = this.buildRows();
    }
    if (this.pendingFocusKey && this.rows.some(row => row.key === this.pendingFocusKey)) {
      const key = this.pendingFocusKey;
      this.pendingFocusKey = null;
      setTimeout(() => this.focusValue(key));
    }
  }

  get isEditable(): boolean {
    return !this.readonly;
  }

  toggleOpen(): void {
    this.isOpen = !this.isOpen;
    writeOpenFlag(this.isOpen);
  }

  /** Opens the "new property" input (called from the note's ⋯ menu too). */
  startAdding(): void {
    if (this.readonly) return;
    if (!this.isOpen) this.toggleOpen();
    this.isAdding = true;
    this.newKey = '';
    this.newKeyError = '';
    setTimeout(() => this.inputById('prop-new-key')?.focus());
  }

  cancelAdding(): void {
    this.isAdding = false;
    this.newKey = '';
    this.newKeyError = '';
    this.closeSuggest();
  }

  addProperty(raw: string = this.newKey): void {
    const key = raw.trim().replace(/:+$/, '').trim();
    if (!key) {
      this.cancelAdding();
      return;
    }
    if (/^tags?$/i.test(key)) {
      this.newKeyError = 'Edit tags in the tag row under the title';
      return;
    }

    const existing = this.rows.find(row => row.key.toLowerCase() === key.toLowerCase());
    this.cancelAdding();
    if (existing) {
      setTimeout(() => this.focusValue(existing.key));
      return;
    }

    const type = this.assignedType(key) ?? 'text';
    this.typeOverrides.set(key.toLowerCase(), type);
    this.pendingFocusKey = key;
    this.emit(setProperty(this.content, key, type === 'checkbox' ? { type, value: 'false' } : { type, value: '', items: [] }));
  }

  // ---- Renaming keys ----

  startRename(row: PropertyRow): void {
    if (this.readonly) return;
    this.renamingKey = row.key;
    this.renameDraft = row.key;
    this.renameError = '';
    setTimeout(() => {
      const input = this.inputById('prop-rename');
      input?.focus();
      input?.select();
    });
  }

  commitRename(): void {
    const oldKey = this.renamingKey;
    if (oldKey === null) return;
    const newKey = this.renameDraft.trim().replace(/:+$/, '').trim();

    if (!newKey || newKey === oldKey) {
      this.cancelRename();
      return;
    }
    const clash = this.rows.some(row => row.key !== oldKey && row.key.toLowerCase() === newKey.toLowerCase())
      || /^tags?$/i.test(newKey);
    if (clash) {
      this.renameError = `This note already has “${newKey}”`;
      return;
    }

    const override = this.typeOverrides.get(oldKey.toLowerCase());
    if (override) this.typeOverrides.set(newKey.toLowerCase(), override);
    this.cancelRename();
    this.emit(renameProperty(this.content, oldKey, newKey));
  }

  cancelRename(): void {
    this.renamingKey = null;
    this.renameDraft = '';
    this.renameError = '';
  }

  onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelRename();
    }
  }

  // ---- Type and removal ----

  changeType(row: PropertyRow, type: EditableType): void {
    if (this.readonly || row.shownType === type || row.type === 'complex') return;
    this.typeOverrides.set(row.key.toLowerCase(), type);
    this.emit(setProperty(this.content, row.key, convertProperty({ ...row, type: row.empty ? 'text' : row.type }, type)));
  }

  remove(row: PropertyRow): void {
    if (this.readonly) return;
    this.typeOverrides.delete(row.key.toLowerCase());
    this.emit(removeProperty(this.content, row.key));
  }

  iconFor(type: PropertyType): string {
    return type === 'complex' ? 'data_object' : PROPERTY_TYPES.find(item => item.type === type)?.icon ?? 'notes';
  }

  labelFor(type: PropertyType): string {
    return type === 'complex' ? 'Complex value' : PROPERTY_TYPES.find(item => item.type === type)?.label ?? 'Text';
  }

  // ---- Text and number values ----

  /** Switches a text value from its read view (with clickable links) to its input. */
  focusValue(key: string): void {
    if (this.readonly) return;
    const row = this.rows.find(item => item.key === key);
    if (!row) return;
    if (row.shownType === 'list') {
      this.inputById(this.itemInputId(row))?.focus();
      return;
    }
    if (row.shownType === 'text' || row.shownType === 'number') {
      this.focusedKey = key;
      this.draft = row.value;
    }
    setTimeout(() => this.inputById(this.valueInputId(row))?.focus());
  }

  onValueFocus(row: PropertyRow): void {
    if (this.focusedKey !== row.key) {
      this.focusedKey = row.key;
      this.draft = row.value;
    }
  }

  onDraftChange(row: PropertyRow, value: string): void {
    this.focusedKey = row.key;
    this.draft = value;
  }

  onValueBlur(row: PropertyRow): void {
    this.closeSuggest();
    this.commitValue(row);
    this.focusedKey = null;
  }

  commitValue(row: PropertyRow, value: string = this.draft): void {
    if (this.readonly || this.focusedKey !== row.key) return;
    const next = value.trim();
    if (next === row.value) return;
    if (row.shownType === 'number' && next && !Number.isFinite(Number(next))) return;
    this.keepTypeWhenEmpty(row, next);
    this.emit(setProperty(this.content, row.key, { type: row.shownType as EditableType, value: next }));
  }

  setScalar(row: PropertyRow, value: string): void {
    if (this.readonly) return;
    const type = row.shownType as EditableType;
    const next = type === 'datetime' ? value : value.trim();
    if (next === row.value) return;
    this.keepTypeWhenEmpty(row, next);
    this.emit(setProperty(this.content, row.key, { type, value: next }));
  }

  /** An empty value has no type in YAML, so remember the shown one for this session. */
  private keepTypeWhenEmpty(row: PropertyRow, value: string): void {
    if (!value && row.shownType !== 'complex') this.typeOverrides.set(row.key.toLowerCase(), row.shownType);
  }

  /** `datetime-local` inputs want `YYYY-MM-DDTHH:mm`. */
  datetimeInputValue(value: string): string {
    return value.replace(' ', 'T').slice(0, 16);
  }

  onValueKeydown(event: KeyboardEvent, row: PropertyRow): void {
    if (this.handleSuggestKeys(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.draft = row.value;
      (event.target as HTMLInputElement).blur();
    }
  }

  // ---- List values ----

  addItem(row: PropertyRow, raw: string = this.itemDrafts[row.key] ?? '', refocus = true): void {
    const item = raw.trim();
    this.itemDrafts[row.key] = '';
    this.closeSuggest();
    if (this.readonly || !item) return;
    if (row.items.some(existing => existing.toLowerCase() === item.toLowerCase())) return;
    if (refocus) this.pendingFocusKey = row.key;
    this.emit(setProperty(this.content, row.key, { type: 'list', items: [...row.items, item] }));
  }

  removeItem(row: PropertyRow, index: number): void {
    if (this.readonly) return;
    this.emit(setProperty(this.content, row.key, { type: 'list', items: row.items.filter((_, i) => i !== index) }));
  }

  onItemKeydown(event: KeyboardEvent, row: PropertyRow): void {
    if (this.handleSuggestKeys(event)) return;
    const input = event.target as HTMLInputElement;
    if (event.key === 'Enter' || (event.key === ',' && !input.value.includes('[['))) {
      event.preventDefault();
      this.addItem(row);
    } else if (event.key === 'Backspace' && !input.value && row.items.length) {
      this.removeItem(row, row.items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.itemDrafts[row.key] = '';
      input.blur();
    }
  }

  onItemBlur(row: PropertyRow): void {
    this.closeSuggest();
    if ((this.itemDrafts[row.key] ?? '').trim()) this.addItem(row, undefined, false);
  }

  itemSegments(item: string): ValueSegment[] {
    return toSegments(item);
  }

  // ---- Suggestions ----

  /** Refreshes the suggestion list for the input that just changed. */
  updateSuggest(event: Event, row: PropertyRow | null, field: SuggestState['field']): void {
    const input = event.target as HTMLInputElement;
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    const key = row?.key ?? '';

    if (field === 'newKey') {
      this.newKeyError = '';
      const existing = new Set(this.rows.map(item => item.key.toLowerCase()));
      const query = text.trim().toLowerCase();
      const items = (this.index?.getPropertyKeys() ?? [])
        .filter(item => !existing.has(item.key.toLowerCase()) && !/^tags?$/i.test(item.key))
        .filter(item => !query || item.key.toLowerCase().includes(query))
        .slice(0, MAX_SUGGESTIONS)
        .map(item => ({ label: item.key, detail: item.type ? this.labelFor(item.type) : '', insert: item.key, kind: 'key' as const }));
      this.setSuggest({ key, field, items, active: -1, linkStart: -1 });
      return;
    }

    // Inside an unfinished [[link: suggest notes.
    const before = text.slice(0, caret);
    const linkStart = before.lastIndexOf('[[');
    if (linkStart >= 0 && !before.slice(linkStart).includes(']]')) {
      const query = before.slice(linkStart + 2).split('|')[0];
      this.setSuggest({ key, field, items: this.linkSuggestions(query), active: 0, linkStart });
      return;
    }

    if (!row) return;
    const query = text.trim().toLowerCase();
    const taken = new Set(row.shownType === 'list' ? row.items.map(item => item.toLowerCase()) : [row.value.toLowerCase()]);
    const items = (this.index?.getPropertyValues(row.key) ?? [])
      .filter(item => !taken.has(item.value.toLowerCase()) && item.value.toLowerCase() !== query)
      .filter(item => !query || item.value.toLowerCase().includes(query))
      .slice(0, MAX_SUGGESTIONS)
      .map(item => ({ label: item.value, detail: `${item.count}`, insert: item.value, kind: 'value' as const }));
    this.setSuggest({ key, field, items, active: -1, linkStart: -1 });
  }

  pickSuggestion(suggestion: Suggestion, row: PropertyRow | null): void {
    const state = this.suggest;
    if (!state) return;
    this.closeSuggest();

    if (state.field === 'newKey') {
      this.addProperty(suggestion.insert);
      return;
    }
    if (!row) return;

    const current = state.field === 'item' ? this.itemDrafts[row.key] ?? '' : this.draft;
    let next = suggestion.insert;
    if (suggestion.kind === 'link' && state.linkStart >= 0) {
      const input = this.inputById(state.field === 'item' ? this.itemInputId(row) : this.valueInputId(row));
      const caret = input?.selectionStart ?? current.length;
      const after = current.slice(caret).replace(/^[^\]]*\]\]/, '');
      next = current.slice(0, state.linkStart) + suggestion.insert + after;
    }

    if (state.field === 'item') {
      this.addItem(row, next);
    } else {
      this.draft = next;
      this.commitValue(row, next);
    }
  }

  isSuggestFor(row: PropertyRow | null, field: SuggestState['field']): boolean {
    return !!this.suggest && this.suggest.field === field && this.suggest.key === (row?.key ?? '');
  }

  onNewKeyKeydown(event: KeyboardEvent): void {
    if (this.handleSuggestKeys(event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addProperty();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelAdding();
    }
  }

  onNewKeyBlur(): void {
    this.closeSuggest();
    if (this.newKey.trim() && !this.newKeyError) {
      this.addProperty();
    } else if (!this.newKey.trim()) {
      this.cancelAdding();
    }
  }

  closeSuggest(): void {
    this.suggest = null;
  }

  onLinkClick(event: MouseEvent, target: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.openLink.emit(target);
  }

  valueInputId(row: PropertyRow): string {
    return `prop-value-${this.rows.indexOf(row)}`;
  }

  itemInputId(row: PropertyRow): string {
    return `prop-item-${this.rows.indexOf(row)}`;
  }

  trackRow(_: number, row: PropertyRow): string {
    return row.key;
  }

  /** Handles arrow keys / Enter / Tab / Esc for an open suggestion list. Returns true if handled. */
  private handleSuggestKeys(event: KeyboardEvent): boolean {
    const state = this.suggest;
    if (!state || !state.items.length) return false;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      state.active = (state.active + step + state.items.length + 1) % (state.items.length + 1);
      if (state.active === state.items.length) state.active = -1;
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && state.active >= 0) {
      event.preventDefault();
      const row = this.rows.find(item => item.key === state.key) ?? null;
      this.pickSuggestion(state.items[state.active], row);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeSuggest();
      return true;
    }
    return false;
  }

  private setSuggest(state: SuggestState): void {
    this.suggest = state.items.length ? state : null;
  }

  private linkSuggestions(query: string): Suggestion[] {
    const index = this.index;
    if (!index) return [];
    const byPath = query.includes('/');
    return index.files
      .map(entry => {
        const name = getVaultDisplayName(entry.name);
        const match = fuzzyMatch(query, byPath ? entry.relativePath : name);
        return match ? { entry, name, score: match.score } : null;
      })
      .filter((item): item is NonNullable<typeof item> => !!item)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
      .map(({ entry, name }) => ({
        label: name,
        detail: entry.parentPath,
        insert: `[[${index.linkTextFor(entry)}]]`,
        kind: 'link' as const,
      }));
  }

  private buildRows(): PropertyRow[] {
    this.usualTypes = null;
    return readProperties(this.content)
      .filter(property => !/^tags?$/i.test(property.key))
      .map(property => {
        const shownType = property.empty ? this.assignedType(property.key) ?? 'text' : property.type;
        const segments = toSegments(property.value);
        return { ...property, shownType, segments, hasLinks: segments.some(segment => segment.link) };
      });
  }

  /** The type a key should have: chosen in this session, set in Obsidian, or most used in the vault. */
  private assignedType(key: string): EditableType | null {
    const id = key.toLowerCase();
    if (!this.usualTypes) {
      this.usualTypes = new Map();
      for (const item of this.index?.getPropertyKeys() ?? []) {
        if (item.type && item.type !== 'complex') this.usualTypes.set(item.key.toLowerCase(), item.type);
      }
    }
    return this.typeOverrides.get(id) ?? this.typeHints[id] ?? this.usualTypes.get(id) ?? null;
  }

  private emit(content: string): void {
    if (content !== this.content) this.contentChange.emit(content);
  }

  private inputById(id: string): HTMLInputElement | null {
    return this.host.nativeElement.querySelector<HTMLInputElement>(`#${id}`);
  }
}

function toSegments(text: string): ValueSegment[] {
  const segments: ValueSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ text: text.slice(last, at), link: null });
    const [target, alias] = match[1].split('|');
    segments.push({ text: (alias ?? target).trim(), link: target.trim() });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), link: null });
  return segments;
}

function readOpenFlag(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpenFlag(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Storage unavailable: the panel just won't remember.
  }
}

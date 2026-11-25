import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CdkDragDrop, DragDropModule, transferArrayItem } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  BaseConfig,
  BaseResult,
  BaseRow,
  BaseSort,
  BaseValue,
  BaseView,
  ConditionOp,
  FilterCondition,
  addBaseView,
  conditionsToFilter,
  defaultColumnName,
  filterToConditions,
  isEmptyValue,
  newNoteDefaults,
  notePropertyKey,
  parseBase,
  removeBaseView,
  runBaseView,
  setBaseFilters,
  setDisplayName,
  setViewField,
  valueToText,
} from '../../../../shared/services/ObsidianVault/bases';
import type { PropertyType, PropertyValue } from '../../../../shared/services/ObsidianVault/frontmatter';
import { ObsidianVaultService } from '../../../../shared/services/ObsidianVault/obsidian-vault-service';
import type { VaultIndex } from '../../../../shared/services/ObsidianVault/vault-index.service';
import { getVaultDisplayName, getVaultFileType } from '../../../../shared/services/ObsidianVault/vault-file-types';

/** One piece of a cell: plain text, or a link to open. */
interface Segment {
  text: string;
  /** Link target (a `[[link]]` target or a vault path) when clickable. */
  link: string | null;
}

type Cell =
  | { kind: 'empty' }
  | { kind: 'text'; segments: Segment[] }
  | { kind: 'list'; items: Segment[][] }
  | { kind: 'bool'; value: boolean };

/** A database view changing one property of a note (board move or table cell edit). */
export interface DatabasePropertyChange {
  path: string;
  key: string;
  /** null removes the property. */
  value: PropertyValue | null;
  /** When set, a message with Undo is shown after the change. */
  undoLabel?: string;
}

/** A database view asking for a new note that matches it. */
export interface DatabaseNewNote {
  title: string;
  folder: string;
  tags: string[];
  properties: { key: string; value: PropertyValue | null }[];
}

interface RowView {
  path: string;
  title: string;
  icon: string;
  cells: Cell[];
  /** Each column's value as plain text (what an edit starts from). */
  raw: string[];
  /** Cards: the cover image's vault path or URL. */
  image: string | null;
}

interface GroupView {
  label: string;
  /** null for "no value". */
  value: string | null;
  rows: RowView[];
}

interface ColumnOption {
  property: string;
  label: string;
}

type Panel = 'filter' | 'columns' | 'settings' | null;

const LINK = /\[\[([^\]]+)\]\]/g;
const FILE_COLUMNS: ColumnOption[] = [
  { property: 'file.name', label: 'Name' },
  { property: 'file.folder', label: 'Folder' },
  { property: 'file.tags', label: 'Tags' },
  { property: 'file.links', label: 'Links' },
  { property: 'file.backlinks', label: 'Backlinks' },
  { property: 'file.mtime', label: 'Modified' },
  { property: 'file.ext', label: 'Extension' },
];

export const CONDITION_OPS: { op: ConditionOp; label: string; needsValue: boolean }[] = [
  { op: 'is', label: 'is', needsValue: true },
  { op: 'is-not', label: 'is not', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'not-contains', label: 'does not contain', needsValue: true },
  { op: 'not-empty', label: 'is set', needsValue: false },
  { op: 'empty', label: 'is empty', needsValue: false },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'gte', label: '≥', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'lte', label: '≤', needsValue: true },
];

/**
 * Shows an Obsidian Bases file (`.base`) as a table or cards, and edits its views, filters, columns
 * and sorting. Every change rewrites the file through `bases.ts`, which keeps what it doesn't touch.
 */
@Component({
  selector: 'app-database-view',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, DragDropModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './database-view.component.html',
  styleUrl: './database-view.component.scss',
})
export class DatabaseViewComponent implements OnChanges, OnDestroy {
  @Input() content = '';
  @Input() filePath = '';
  @Input() serverId = '';
  @Input() readonly = false;
  @Input() index: VaultIndex | null = null;
  @Input() indexVersion = 0;
  /** True while the vault's notes are still being read (results may be incomplete). */
  @Input() indexing = false;
  @Output() contentChange = new EventEmitter<string>();
  @Output() openFile = new EventEmitter<string>();
  @Output() propertyChange = new EventEmitter<DatabasePropertyChange>();
  @Output() createNote = new EventEmitter<DatabaseNewNote>();

  readonly conditionOps = CONDITION_OPS;

  config: BaseConfig = parseBase('');
  activeView = 0;
  result: BaseResult | null = null;
  columns: string[] = [];
  rows: RowView[] = [];
  groups: GroupView[] | null = null;
  panel: Panel = null;
  showWarnings = false;
  editError = '';

  filterScope: 'view' | 'all' = 'view';
  conditions: FilterCondition[] = [];
  /** False when the filter in scope uses or/not groups, which the builder can't show. */
  filterEditable = true;

  /** Usual type of each note property in the vault (lower-cased key). */
  private keyTypes = new Map<string, PropertyType>();

  /** The table cell being edited. */
  editing: { path: string; column: number } | null = null;
  editDraft = '';

  /** Where a new note is being typed: a board column, or the toolbar (`group: null`). */
  newNote: { group: GroupView | null } | null = null;
  newNoteTitle = '';
  newColumnName = '';

  /** Cover images: vault path → object URL ('' while loading or if it failed). */
  imageUrls: Record<string, string> = {};
  private loadingImages = new Set<string>();

  /** When the last card drag ended: the click that ends a drag shouldn't open the note. */
  private lastDragEnd = 0;

  constructor(private vaultService: ObsidianVaultService, private host: ElementRef<HTMLElement>) {}

  markDragEnd(): void {
    this.lastDragEnd = Date.now();
  }

  openCard(row: RowView): void {
    if (Date.now() - this.lastDragEnd < 300) return;
    this.open(row.path);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['filePath'] && !changes['filePath'].isFirstChange()) {
      this.activeView = 0;
      this.panel = null;
      this.revokeImages();
    }
    if (changes['content'] || changes['filePath']) {
      this.config = parseBase(this.content);
      this.activeView = Math.min(this.activeView, Math.max(0, this.config.views.length - 1));
      // Re-read the builder rows only if the file's filters changed from elsewhere, so rows
      // still being filled in aren't dropped by our own saves.
      if (this.panel === 'filter' && JSON.stringify(conditionsToFilter(this.conditions)) !== JSON.stringify(normalizeFlat(this.scopeFilter))) {
        this.loadConditions();
      }
    }
    this.refresh();
  }

  ngOnDestroy(): void {
    this.revokeImages();
  }

  get view(): BaseView | null {
    return this.config.views[this.activeView] ?? null;
  }

  get layout(): 'table' | 'cards' | 'board' {
    const type = this.view?.type;
    return type === 'cards' ? 'cards' : type === 'kanban' ? 'board' : 'table';
  }

  /** Obsidian layouts this app doesn't draw (list, map, plugin views) are shown as a table. */
  get unsupportedLayout(): string | null {
    const type = this.view?.type;
    return type && !['table', 'cards', 'kanban'].includes(type) ? type : null;
  }

  get filterCount(): number {
    const count = (filter: unknown): number =>
      !filter ? 0 : typeof filter === 'string' ? 1 : Object.values(filter as Record<string, unknown[]>)[0].reduce((n: number, f) => n + count(f), 0);
    return count(this.config.filters) + count(this.view?.filters ?? null);
  }

  /** Quick starts for an empty database: the vault's most used tags. */
  get tagPresets(): string[] {
    return (this.index?.getAllTags() ?? []).slice(0, 8).map(item => item.tag);
  }

  /** A new, unfiltered database: offer the vault's tags as one-click starting points. */
  get showPresets(): boolean {
    const unfiltered = !this.config.filters && !this.config.views.some(view => view.filters);
    return !this.readonly && unfiltered && this.tagPresets.length > 0 && (this.view?.order.length ?? 0) <= 1;
  }

  columnName(property: string): string {
    return this.config.displayNames[property] ?? defaultColumnName(property);
  }

  sortOf(property: string): 'ASC' | 'DESC' | null {
    return this.view?.sort.find(sort => sort.property === property)?.direction ?? null;
  }

  // ---- Views ----

  selectView(index: number): void {
    this.activeView = index;
    if (this.panel === 'filter') this.loadConditions();
    this.refresh();
  }

  addView(): void {
    const name = uniqueName('View', this.config.views.map(view => view.name));
    const order = this.view?.order.length ? this.view.order : ['file.name'];
    this.apply(text => addBaseView(text, { name, type: 'table', order }));
    this.activeView = this.config.views.length;
    this.panel = 'settings';
  }

  deleteView(): void {
    if (!this.view || this.config.views.length <= 1) return;
    if (!confirm(`Delete the view “${this.view.name}”? Its filters, columns and sorting are removed from the file.`)) return;
    const index = this.activeView;
    this.activeView = Math.max(0, index - 1);
    this.panel = null;
    this.apply(text => removeBaseView(text, index));
  }

  setViewName(name: string): void {
    const clean = name.trim();
    if (!this.view || !clean || clean === this.view.name) return;
    this.apply(text => setViewField(text, this.activeView, 'name', clean));
  }

  setLayout(type: 'table' | 'cards' | 'kanban'): void {
    if (!this.view || this.view.type === type) return;
    const view = this.activeView;
    // A board needs columns: group by `status` if the vault uses it.
    const groupBy = type === 'kanban' && !this.view.groupBy && this.keyTypes.has('status')
      ? { property: 'status', direction: 'ASC' }
      : null;
    this.apply(text => {
      const next = setViewField(text, view, 'type', type);
      return groupBy ? setViewField(next, view, 'groupBy', groupBy) : next;
    });
  }

  setGroupBy(property: string, direction: 'ASC' | 'DESC' = this.view?.groupBy?.direction ?? 'ASC'): void {
    const value = property ? { property, direction } : null;
    const changed = property !== (this.view?.groupBy?.property ?? '');
    const view = this.activeView;
    this.apply(text => {
      const next = setViewField(text, view, 'groupBy', value);
      // A column order for another property means nothing for this one.
      return changed ? setViewField(next, view, 'groupOrder', null) : next;
    });
  }

  // ---- Board ----

  /** Why cards can't be dragged, or null when they can. */
  get boardLockedReason(): string | null {
    if (this.readonly) return 'Read only';
    const groupBy = this.view?.groupBy;
    if (!groupBy) return null;
    const key = notePropertyKey(groupBy.property);
    if (!key) return `Columns come from ${this.columnName(groupBy.property)}, which can't be changed from here.`;
    const type = this.keyTypes.get(key.toLowerCase());
    if (type === 'list' || type === 'complex') return `“${key}” holds a list, so cards can't be moved between columns.`;
    return null;
  }

  onCardDrop(event: CdkDragDrop<GroupView>): void {
    if (event.previousContainer === event.container || this.boardLockedReason) return;
    const row = event.item.data as RowView;
    const target = event.container.data;
    // Move it straight away; the board refreshes once the note is saved.
    transferArrayItem(event.previousContainer.data.rows, target.rows, event.previousIndex, event.currentIndex);
    this.moveCard(row, target);
  }

  moveCard(row: RowView, target: GroupView): void {
    const groupBy = this.view?.groupBy;
    const key = groupBy ? notePropertyKey(groupBy.property) : null;
    if (!key || this.boardLockedReason) return;
    this.propertyChange.emit({
      path: row.path,
      key,
      value: target.value === null ? null : this.valueFor(key, target.value),
      undoLabel: `Moved “${row.title}” to ${target.label}.`,
    });
  }

  /** The visible columns' values, in order. */
  private get columnValues(): (string | null)[] {
    return this.view?.groupOrder ?? (this.groups ?? []).map(group => group.value);
  }

  addBoardColumn(raw: string = this.newColumnName): void {
    const name = raw.trim();
    this.newColumnName = '';
    if (!name || this.columnValues.includes(name)) return;
    this.setGroupOrder([...this.columnValues, name]);
  }

  hideBoardColumn(value: string | null): void {
    this.setGroupOrder(this.columnValues.filter(item => item !== value));
  }

  showBoardColumn(value: string | null): void {
    this.setGroupOrder([...this.columnValues, value]);
  }

  moveBoardColumn(value: string | null, step: -1 | 1): void {
    const order = [...this.columnValues];
    const index = order.indexOf(value);
    const target = index + step;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    this.setGroupOrder(order);
  }

  private setGroupOrder(order: (string | null)[]): void {
    this.apply(text => setViewField(text, this.activeView, 'groupOrder', order));
  }

  // ---- New notes ----

  startNewNote(group: GroupView | null): void {
    if (this.readonly) return;
    this.newNote = { group };
    this.newNoteTitle = '';
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('.board-new-input, .new-note .field')?.focus());
  }

  cancelNewNote(): void {
    this.newNote = null;
    this.newNoteTitle = '';
  }

  /** Creates a note that shows up here: tags, folder and `is` values from the filters, plus the column's value. */
  submitNewNote(): void {
    const title = this.newNoteTitle.trim();
    const target = this.newNote;
    if (!title || !target) {
      this.cancelNewNote();
      return;
    }
    const defaults = newNoteDefaults(this.config, this.activeView);
    const properties: DatabaseNewNote['properties'] = defaults.properties.map(item => ({
      key: item.key,
      value: this.valueFor(item.key, item.value),
    }));

    const groupKey = target.group && this.view?.groupBy ? notePropertyKey(this.view.groupBy.property) : null;
    if (groupKey && target.group) {
      const index = properties.findIndex(item => item.key.toLowerCase() === groupKey.toLowerCase());
      if (index >= 0) properties.splice(index, 1);
      properties.push({ key: groupKey, value: target.group.value === null ? null : this.valueFor(groupKey, target.group.value) });
    }

    const baseFolder = this.filePath.includes('/') ? this.filePath.slice(0, this.filePath.lastIndexOf('/')) : '';
    this.createNote.emit({ title, folder: defaults.folder ?? baseFolder, tags: defaults.tags, properties });
    this.newNoteTitle = '';
  }

  onNewNoteKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submitNewNote();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelNewNote();
    }
  }

  // ---- Editing cells ----

  /** The type a column's cells are edited as, or null if they can't be edited here. */
  editableType(property: string): PropertyValue['type'] | null {
    if (this.readonly) return null;
    const key = notePropertyKey(property);
    if (!key) return null;
    const type = this.keyTypes.get(key.toLowerCase()) ?? 'text';
    return type === 'list' || type === 'complex' ? null : type;
  }

  startEdit(row: RowView, column: number): void {
    const type = this.editableType(this.columns[column]);
    if (!type || this.isEditing(row, column)) return;
    if (type === 'checkbox') {
      this.commitCell(row, column, row.raw[column] === 'true' ? 'false' : 'true');
      return;
    }
    this.editing = { path: row.path, column };
    this.editDraft = type === 'date' ? row.raw[column].slice(0, 10) : row.raw[column];
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('.cell-input')?.focus());
  }

  isEditing(row: RowView, column: number): boolean {
    return this.editing?.path === row.path && this.editing.column === column;
  }

  commitEdit(row: RowView, column: number): void {
    if (!this.isEditing(row, column)) return;
    this.editing = null;
    if (this.editDraft.trim() !== row.raw[column]) this.commitCell(row, column, this.editDraft.trim());
  }

  onEditKeydown(event: KeyboardEvent, row: RowView, column: number): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(row, column);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.editing = null;
    }
  }

  editInputType(column: number): string {
    const type = this.editableType(this.columns[column]);
    return type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';
  }

  private commitCell(row: RowView, column: number, value: string): void {
    const key = notePropertyKey(this.columns[column]);
    const type = this.editableType(this.columns[column]);
    if (!key || !type) return;
    if (type === 'number' && value && !Number.isFinite(Number(value))) return;
    this.propertyChange.emit({ path: row.path, key, value: { type, value } });
  }

  /** How a value is written to `key`, using the type that property usually has in the vault. */
  private valueFor(key: string, value: string): PropertyValue {
    const type = this.keyTypes.get(key.toLowerCase());
    if (type === 'number' && Number.isFinite(Number(value))) return { type, value };
    if (type === 'checkbox') return { type, value: /^true$/i.test(value) ? 'true' : 'false' };
    if ((type === 'date' || type === 'datetime') && /^\d{4}-\d{2}-\d{2}/.test(value)) return { type, value };
    if (type === 'list') return { type, items: [value] };
    return { type: 'text', value };
  }

  setImage(property: string): void {
    this.apply(text => setViewField(text, this.activeView, 'image', property || null));
  }

  setLimit(raw: string | number | null): void {
    const limit = Number(raw);
    this.apply(text => setViewField(text, this.activeView, 'limit', Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null));
  }

  // ---- Sorting ----

  /** Header click: ascending → descending → off. */
  toggleSort(property: string): void {
    if (this.readonly || !this.view) return;
    const current = this.sortOf(property);
    const next: BaseSort[] = current === null
      ? [{ property, direction: 'ASC' }]
      : current === 'ASC' ? [{ property, direction: 'DESC' }] : [];
    this.apply(text => setViewField(text, this.activeView, 'sort', next.length ? next : null));
  }

  // ---- Columns ----

  get columnOptions(): ColumnOption[] {
    const used = new Set(this.columns);
    const noteKeys = (this.index?.getPropertyKeys() ?? []).map(item => ({ property: item.key, label: item.key }));
    const formulas = Object.keys(this.config.formulas).map(name => ({ property: `formula.${name}`, label: `${name} (formula)` }));
    return [...FILE_COLUMNS, ...noteKeys, ...formulas].filter(option => !used.has(option.property));
  }

  addColumn(property: string): void {
    if (!property || !this.view) return;
    this.setColumns([...this.columns, property]);
  }

  removeColumn(index: number): void {
    this.setColumns(this.columns.filter((_, i) => i !== index));
  }

  moveColumn(index: number, step: -1 | 1): void {
    const target = index + step;
    if (target < 0 || target >= this.columns.length) return;
    const next = [...this.columns];
    [next[index], next[target]] = [next[target], next[index]];
    this.setColumns(next);
  }

  renameColumn(property: string, name: string): void {
    const clean = name.trim() === defaultColumnName(property) ? '' : name;
    if ((this.config.displayNames[property] ?? '') === clean.trim()) return;
    this.apply(text => setDisplayName(text, property, clean));
  }

  private setColumns(order: string[]): void {
    this.apply(text => setViewField(text, this.activeView, 'order', order));
  }

  // ---- Filters ----

  togglePanel(panel: Exclude<Panel, null>): void {
    this.panel = this.panel === panel ? null : panel;
    if (this.panel === 'filter') this.loadConditions();
  }

  setFilterScope(scope: 'view' | 'all'): void {
    this.filterScope = scope;
    this.loadConditions();
  }

  addCondition(kind: FilterCondition['kind']): void {
    const condition: FilterCondition =
      kind === 'tag' ? { kind, value: '' }
      : kind === 'folder' ? { kind, value: '' }
      : kind === 'raw' ? { kind, expression: '' }
      : { kind: 'property', property: '', op: 'is', value: '' };
    this.conditions = [...this.conditions, condition];
  }

  removeCondition(index: number): void {
    this.conditions = this.conditions.filter((_, i) => i !== index);
    this.saveConditions();
  }

  /** Writes the builder rows to the file (incomplete rows are left out until filled in). */
  saveConditions(): void {
    if (!this.filterEditable) return;
    const filter = conditionsToFilter(this.conditions);
    const scope = this.filterScope === 'all' ? 'all' : this.activeView;
    if (JSON.stringify(filter) === JSON.stringify(normalizeFlat(this.scopeFilter))) return;
    this.apply(text => setBaseFilters(text, scope, filter));
  }

  opNeedsValue(op: ConditionOp): boolean {
    return CONDITION_OPS.find(item => item.op === op)?.needsValue ?? true;
  }

  get tagOptions(): string[] {
    return (this.index?.getAllTags() ?? []).map(item => item.tag);
  }

  get folderOptions(): string[] {
    return (this.index?.folders ?? []).map(folder => folder.relativePath).sort((a, b) => a.localeCompare(b));
  }

  get propertyOptions(): string[] {
    return (this.index?.getPropertyKeys() ?? []).map(item => item.key);
  }

  valueOptions(property: string): string[] {
    return property ? (this.index?.getPropertyValues(property) ?? []).slice(0, 50).map(item => item.value) : [];
  }

  /** Empty database: show notes with this tag, with the columns those notes use most. */
  applyTagPreset(tag: string): void {
    const index = this.index;
    if (!index) return;
    const counts = new Map<string, number>();
    for (const entry of index.getNotesWithTag(tag)) {
      for (const property of index.getProperties(entry.relativePath)) {
        if (!property.empty) counts.set(property.key, (counts.get(property.key) ?? 0) + 1);
      }
    }
    const keys = Array.from(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key]) => key);
    this.apply(text => {
      let next = setBaseFilters(text, 'all', { and: [`file.hasTag(${JSON.stringify(tag)})`] });
      if (!parseBase(next).views.length) next = addBaseView(next, { name: 'Table', type: 'table' });
      next = setViewField(next, this.activeView, 'order', ['file.name', ...keys]);
      return next;
    });
  }

  // ---- Rows ----

  open(path: string): void {
    this.openFile.emit(path);
  }

  onLinkClick(event: MouseEvent, target: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.openFile.emit(target);
  }

  trackRow(_: number, row: RowView): string {
    return row.path;
  }

  private get scopeFilter() {
    return this.filterScope === 'all' ? this.config.filters : this.view?.filters ?? null;
  }

  private loadConditions(): void {
    const conditions = filterToConditions(this.scopeFilter);
    this.filterEditable = conditions !== null;
    this.conditions = conditions ?? [];
  }

  private refresh(): void {
    const index = this.index;
    if (!index || this.config.error) {
      this.result = null;
      this.rows = [];
      this.groups = null;
      this.columns = [];
      return;
    }

    this.keyTypes = new Map(
      index.getPropertyKeys().filter(item => item.type).map(item => [item.key.toLowerCase(), item.type as PropertyType]),
    );
    const result = runBaseView(this.config, this.activeView, index, this.filePath || null);
    const view = this.view;
    this.result = result;
    this.columns = view?.order.length ? view.order : ['file.name'];

    const toRow = (row: BaseRow): RowView => this.toRowView(row, view);
    this.rows = result.rows.map(toRow);
    this.groups = result.groups?.map(group => ({ label: group.label, value: group.value, rows: group.rows.map(toRow) })) ?? null;

    if (this.layout !== 'table') {
      this.rows.forEach(row => row.image && this.loadImage(row.image));
    }
    // A cell being edited may have gone (row filtered out after a change elsewhere).
    if (this.editing && !this.rows.some(row => row.path === this.editing!.path)) this.editing = null;
    if (this.newNote?.group) {
      const value = this.newNote.group.value;
      this.newNote = { group: this.groups?.find(group => group.value === value) ?? null };
    }
  }

  private toRowView(row: BaseRow, view: BaseView | null): RowView {
    const value = (property: string): BaseValue => {
      try {
        return row.context.property(property);
      } catch {
        return null;
      }
    };

    let image: string | null = null;
    if (view?.image) {
      const raw = valueToText(firstValue(value(view.image)));
      image = this.resolveImage(raw, row.entry.relativePath);
    }

    const values = this.columns.map(property => value(property));
    return {
      path: row.entry.relativePath,
      title: getVaultDisplayName(row.entry.name),
      icon: getVaultFileType(row.entry.name).icon,
      cells: values.map((item, i) => toCell(item, this.columns[i])),
      raw: values.map(item => valueToText(item)),
      image,
    };
  }

  private resolveImage(raw: string, fromPath: string): string | null {
    const text = raw.trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    const target = text.replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1');
    const entry = this.index?.resolveFile(target, fromPath);
    return entry && getVaultFileType(entry.name).viewer === 'image' ? entry.relativePath : null;
  }

  private loadImage(path: string): void {
    if (/^https?:\/\//i.test(path)) {
      this.imageUrls[path] = path;
      return;
    }
    if (path in this.imageUrls || this.loadingImages.has(path) || !this.serverId) return;
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

  private revokeImages(): void {
    Object.values(this.imageUrls).forEach(url => url.startsWith('blob:') && URL.revokeObjectURL(url));
    this.imageUrls = {};
  }

  /** Applies an edit to the file text and emits it. */
  private apply(edit: (text: string) => string): void {
    if (this.readonly || this.config.error) return;
    try {
      const next = edit(this.content);
      this.editError = '';
      if (next !== this.content) this.contentChange.emit(next);
    } catch (error) {
      this.editError = error instanceof Error ? error.message : String(error);
    }
  }
}

function toCell(value: BaseValue, property: string): Cell {
  if (isEmptyValue(value)) return { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (Array.isArray(value)) {
    const items = value.filter(item => !isEmptyValue(item)).map(item => toSegments(item, property));
    return items.length ? { kind: 'list', items } : { kind: 'empty' };
  }
  return { kind: 'text', segments: toSegments(value, property) };
}

function toSegments(value: BaseValue, property: string): Segment[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    if (value.kind === 'file') return [{ text: getVaultDisplayName(value.entry.name), link: value.entry.relativePath }];
    return [{ text: value.display ?? value.target, link: value.target }];
  }
  const text = valueToText(value);
  if (property === 'file.tags') return [{ text, link: null }];

  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ text: text.slice(last, at), link: null });
    const [target, alias] = match[1].split('|');
    segments.push({ text: (alias ?? target.split('#')[0]).trim(), link: target.trim() });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), link: null });
  return segments;
}

function firstValue(value: BaseValue): BaseValue {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map(name => name.toLowerCase()));
  for (let i = taken.length + 1; ; i++) {
    const name = `${base} ${i}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** A single-statement filter compares equal to the builder's `{and: [statement]}`. */
function normalizeFlat(filter: unknown): unknown {
  return typeof filter === 'string' ? { and: [filter] } : filter ?? null;
}

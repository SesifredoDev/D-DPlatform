/**
 * Obsidian Bases (`.base` files): database views over the vault's notes and their properties.
 *
 * - Reading/writing: edits go through yaml's Document API, so keys and comments this app doesn't
 *   understand are kept exactly as Obsidian wrote them.
 * - Expressions: a subset of the Bases language (operators, `file.*`, note properties, formulas and
 *   the common functions). Statements using anything else are reported and skipped, never guessed.
 *
 * Pure functions, no Angular.
 */
import { Document, isMap, parse, parseDocument } from 'yaml';
import type { VaultEntry } from './obsidian-vault-service';
import type { IndexedProperty, VaultIndex } from './vault-index.service';
import { getFileExtension } from './vault-file-types';

// ---------------------------------------------------------------- model

export type BaseFilter = string | { and: BaseFilter[] } | { or: BaseFilter[] } | { not: BaseFilter[] };

export interface BaseSort {
  property: string;
  direction: 'ASC' | 'DESC';
}

export interface BaseView {
  /**
   * `table`, `cards` and `kanban` (shown as a board) are drawn; other types (Obsidian's list, map,
   * plugin views) fall back to a table.
   */
  type: string;
  name: string;
  filters: BaseFilter | null;
  /** Columns (properties) in order. */
  order: string[];
  sort: BaseSort[];
  limit: number | null;
  groupBy: BaseSort | null;
  /**
   * Order and visibility of groups (board columns); `null` in the list is "no value". Groups not
   * listed are hidden. `null` here means "show every group, sorted by value".
   */
  groupOrder: (string | null)[] | null;
  /** Cards: property holding the cover image. */
  image: string | null;
}

export interface BaseConfig {
  filters: BaseFilter | null;
  formulas: Record<string, string>;
  displayNames: Record<string, string>;
  views: BaseView[];
  /** Set when the file isn't valid YAML (the view then refuses to edit it). */
  error: string | null;
}

export const NEW_BASE_CONTENT = 'views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n';

export function parseBase(text: string): BaseConfig {
  const empty: BaseConfig = { filters: null, formulas: {}, displayNames: {}, views: [], error: null };
  let raw: unknown;
  try {
    raw = text.trim() ? parse(text) : {};
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isRecord(raw)) return { ...empty, error: 'The file should contain YAML keys such as filters and views.' };

  const formulas: Record<string, string> = {};
  if (isRecord(raw['formulas'])) {
    for (const [name, value] of Object.entries(raw['formulas'])) {
      if (value !== null && value !== undefined) formulas[name] = String(value);
    }
  }

  const displayNames: Record<string, string> = {};
  if (isRecord(raw['properties'])) {
    for (const [property, settings] of Object.entries(raw['properties'])) {
      if (isRecord(settings) && settings['displayName'] !== undefined && settings['displayName'] !== null) {
        displayNames[property] = String(settings['displayName']);
      }
    }
  }

  const views = Array.isArray(raw['views'])
    ? raw['views'].filter(isRecord).map((view, i) => readView(view, i))
    : [];

  return { filters: readFilter(raw['filters']), formulas, displayNames, views, error: null };
}

function readView(view: Record<string, unknown>, index: number): BaseView {
  const sort = Array.isArray(view['sort']) ? view['sort'].map(readSort).filter((s): s is BaseSort => !!s) : [];
  const limit = Number(view['limit']);
  return {
    type: typeof view['type'] === 'string' ? view['type'] : 'table',
    name: view['name'] !== undefined && view['name'] !== null ? String(view['name']) : `View ${index + 1}`,
    filters: readFilter(view['filters']),
    order: Array.isArray(view['order']) ? view['order'].filter(item => item !== null).map(String) : [],
    sort,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    groupBy: readSort(view['groupBy']),
    groupOrder: Array.isArray(view['groupOrder'])
      ? view['groupOrder'].map(value => (value === null || value === undefined ? null : String(value)))
      : null,
    image: typeof view['image'] === 'string' ? view['image'] : null,
  };
}

function readSort(raw: unknown): BaseSort | null {
  if (!isRecord(raw) || typeof raw['property'] !== 'string') return null;
  return { property: raw['property'], direction: String(raw['direction']).toUpperCase() === 'DESC' ? 'DESC' : 'ASC' };
}

function readFilter(raw: unknown): BaseFilter | null {
  if (typeof raw === 'string') return raw.trim() ? raw : null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (!isRecord(raw)) return null;
  for (const op of ['and', 'or', 'not'] as const) {
    if (op in raw) {
      const items = Array.isArray(raw[op]) ? raw[op] : [raw[op]];
      const children = items.map(readFilter).filter((f): f is BaseFilter => f !== null);
      return { [op]: children } as BaseFilter;
    }
  }
  return null;
}

// ---------------------------------------------------------------- edits (text in, text out)

/** Sets (or with `null`, removes) a key of view `viewIndex`. */
export function setViewField(text: string, viewIndex: number, key: string, value: unknown): string {
  return editBase(text, doc => {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length && key !== 'order')) {
      doc.deleteIn(['views', viewIndex, key]);
    } else {
      doc.setIn(['views', viewIndex, key], doc.createNode(value));
    }
  });
}

/** Sets the filters of every view (`scope: 'all'`) or of one view. `null` removes them. */
export function setBaseFilters(text: string, scope: 'all' | number, filter: BaseFilter | null): string {
  const path = scope === 'all' ? ['filters'] : ['views', scope, 'filters'];
  return editBase(text, doc => {
    if (filter === null) doc.deleteIn(path);
    else doc.setIn(path, doc.createNode(filter));
  });
}

export function addBaseView(text: string, view: Partial<BaseView> & { name: string }): string {
  const node: Record<string, unknown> = { type: view.type ?? 'table', name: view.name };
  if (view.order?.length) node['order'] = view.order;
  if (view.sort?.length) node['sort'] = view.sort;
  if (view.filters) node['filters'] = view.filters;
  if (view.image) node['image'] = view.image;
  return editBase(text, doc => {
    if (!doc.hasIn(['views'])) doc.set('views', doc.createNode([]));
    doc.addIn(['views'], doc.createNode(node));
  });
}

export function removeBaseView(text: string, viewIndex: number): string {
  return editBase(text, doc => {
    doc.deleteIn(['views', viewIndex]);
  });
}

/** Sets a column's display name (`properties.<property>.displayName`); empty removes it. */
export function setDisplayName(text: string, property: string, name: string): string {
  return editBase(text, doc => {
    if (name.trim()) {
      doc.setIn(['properties', property, 'displayName'], name.trim());
    } else {
      doc.deleteIn(['properties', property, 'displayName']);
      const settings = doc.getIn(['properties', property]);
      if (isMap(settings) && !settings.items.length) doc.deleteIn(['properties', property]);
      const properties = doc.get('properties');
      if (isMap(properties) && !properties.items.length) doc.delete('properties');
    }
  });
}

function editBase(text: string, edit: (doc: Document) => void): string {
  const doc = text.trim() ? parseDocument(text) : new Document({});
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
  edit(doc);
  return doc.toString({ lineWidth: 0 });
}

// ---------------------------------------------------------------- filter builder

export type ConditionOp = 'is' | 'is-not' | 'contains' | 'not-contains' | 'empty' | 'not-empty' | 'gt' | 'lt' | 'gte' | 'lte';

/** One row of the filter builder. Statements it can't represent are kept as `raw` expressions. */
export type FilterCondition =
  | { kind: 'tag'; value: string }
  | { kind: 'folder'; value: string }
  | { kind: 'property'; property: string; op: ConditionOp; value: string }
  | { kind: 'raw'; expression: string };

const COMPARE_OPS: Record<string, ConditionOp> = { '==': 'is', '!=': 'is-not', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
const PROPERTY_REF = String.raw`(note\["(?:[^"\\]|\\.)*"\]|[A-Za-z_][\w.]*)`;
const STRING_LIT = String.raw`("(?:[^"\\]|\\.)*")`;

/**
 * The filter as builder rows if it's a flat list of statements joined by AND (or a single
 * statement); null for nested or/not groups, which the builder can't show.
 */
export function filterToConditions(filter: BaseFilter | null): FilterCondition[] | null {
  if (filter === null) return [];
  if (typeof filter === 'string') return [statementToCondition(filter)];
  if ('and' in filter && filter.and.every(item => typeof item === 'string')) {
    return (filter.and as string[]).map(statementToCondition);
  }
  return null;
}

export function conditionsToFilter(conditions: FilterCondition[]): BaseFilter | null {
  const statements = conditions.map(conditionToStatement).filter((s): s is string => !!s);
  return statements.length ? { and: statements } : null;
}

export function statementToCondition(statement: string): FilterCondition {
  const s = statement.trim();
  let m = s.match(new RegExp(`^file\\.hasTag\\(${STRING_LIT}\\)$`));
  if (m) return { kind: 'tag', value: unquote(m[1]).replace(/^#/, '') };
  m = s.match(new RegExp(`^file\\.inFolder\\(${STRING_LIT}\\)$`));
  if (m) return { kind: 'folder', value: unquote(m[1]) };
  m = s.match(new RegExp(`^(!)?${PROPERTY_REF}\\.isEmpty\\(\\)$`));
  if (m) return { kind: 'property', property: refToKey(m[2]), op: m[1] ? 'not-empty' : 'empty', value: '' };
  m = s.match(new RegExp(`^(!)?${PROPERTY_REF}\\.contains\\(${STRING_LIT}\\)$`));
  if (m) return { kind: 'property', property: refToKey(m[2]), op: m[1] ? 'not-contains' : 'contains', value: unquote(m[3]) };
  m = s.match(new RegExp(`^${PROPERTY_REF}\\s*(==|!=|>=|<=|>|<)\\s*(${STRING_LIT.slice(1, -1)}|-?\\d+(?:\\.\\d+)?|true|false)$`));
  if (m && !m[1].startsWith('formula.')) {
    return { kind: 'property', property: refToKey(m[1]), op: COMPARE_OPS[m[2]], value: m[3].startsWith('"') ? unquote(m[3]) : m[3] };
  }
  return { kind: 'raw', expression: s };
}

export function conditionToStatement(condition: FilterCondition): string | null {
  switch (condition.kind) {
    case 'tag':
      return condition.value.trim() ? `file.hasTag(${JSON.stringify(condition.value.trim().replace(/^#/, ''))})` : null;
    case 'folder':
      return condition.value.trim() ? `file.inFolder(${JSON.stringify(condition.value.trim().replace(/^\/|\/$/g, ''))})` : null;
    case 'raw':
      return condition.expression.trim() || null;
    case 'property': {
      if (!condition.property.trim()) return null;
      const ref = keyToRef(condition.property.trim());
      const value = condition.value.trim();
      // Not filled in yet ("is empty" covers empty values).
      if (!value && !['empty', 'not-empty'].includes(condition.op)) return null;
      const literal = /^-?\d+(?:\.\d+)?$/.test(value) || /^(?:true|false)$/.test(value) ? value : JSON.stringify(value);
      switch (condition.op) {
        case 'empty': return `${ref}.isEmpty()`;
        case 'not-empty': return `!${ref}.isEmpty()`;
        case 'contains': return `${ref}.contains(${JSON.stringify(value)})`;
        case 'not-contains': return `!${ref}.contains(${JSON.stringify(value)})`;
        case 'is': return `${ref} == ${literal}`;
        case 'is-not': return `${ref} != ${literal}`;
        case 'gt': return `${ref} > ${literal}`;
        case 'lt': return `${ref} < ${literal}`;
        case 'gte': return `${ref} >= ${literal}`;
        case 'lte': return `${ref} <= ${literal}`;
      }
    }
  }
  return null;
}

/** How a note property key is written in an expression: bare when possible, else `note["…"]`. */
export function keyToRef(key: string): string {
  if (key.startsWith('file.') || key.startsWith('formula.') || key.startsWith('note.')) return key;
  return /^[A-Za-z_][\w]*$/.test(key) ? key : `note[${JSON.stringify(key)}]`;
}

function refToKey(ref: string): string {
  const bracket = ref.match(/^note\[("(?:[^"\\]|\\.)*")\]$/);
  if (bracket) return unquote(bracket[1]);
  return ref.startsWith('note.') ? ref.slice(5) : ref;
}

function unquote(literal: string): string {
  try {
    return JSON.parse(literal);
  } catch {
    return literal.slice(1, -1);
  }
}

// ---------------------------------------------------------------- values

export interface FileValue {
  kind: 'file';
  entry: VaultEntry;
}

export interface LinkValue {
  kind: 'link';
  target: string;
  display: string | null;
}

export type BaseValue = string | number | boolean | null | Date | FileValue | LinkValue | BaseValue[];

export class UnsupportedExpression extends Error {}

function isFileValue(value: BaseValue): value is FileValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && value.kind === 'file';
}

function isLinkValue(value: BaseValue): value is LinkValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && value.kind === 'link';
}

export function isEmptyValue(value: BaseValue): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function truthy(value: BaseValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return !!value;
}

/** Plain text for a value (used for display fallbacks, grouping and `toString()`). */
export function valueToText(value: BaseValue): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map(valueToText).join(', ');
  if (value instanceof Date) return formatDate(value);
  if (isFileValue(value)) return value.entry.name.replace(/\.md$/i, '');
  if (isLinkValue(value)) return value.display ?? value.target;
  return String(value);
}

function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getHours() || date.getMinutes() ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

function propertyToValue(property: IndexedProperty): BaseValue {
  if (property.empty || property.type === 'complex') return null;
  const scalar = property.values[0] ?? '';
  switch (property.type) {
    case 'list': return [...property.values];
    case 'number': return Number(scalar);
    case 'checkbox': return scalar === 'true';
    case 'date':
    case 'datetime': return parseDate(scalar);
    default: return scalar;
  }
}

function parseDate(text: string): Date | null {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

// ---------------------------------------------------------------- expressions

type Ast =
  | { k: 'lit'; v: BaseValue }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Ast; name: string }
  | { k: 'index'; obj: Ast; index: Ast }
  | { k: 'call'; callee: Ast; args: Ast[] }
  | { k: 'unary'; op: string; arg: Ast }
  | { k: 'binary'; op: string; a: Ast; b: Ast }
  | { k: 'list'; items: Ast[] };

interface Token {
  t: 'num' | 'str' | 'id' | 'op';
  v: string;
}

const astCache = new Map<string, Ast | Error>();

export function parseExpression(source: string): Ast {
  const cached = astCache.get(source);
  if (cached instanceof Error) throw cached;
  if (cached) return cached;
  try {
    const parser = new Parser(tokenize(source));
    const ast = parser.parseAll();
    astCache.set(source, ast);
    return ast;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    astCache.set(source, err);
    throw err;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          text += source[j++];
        }
      }
      if (j >= source.length) throw new Error('Unclosed string');
      tokens.push({ t: 'str', v: text });
      i = j + 1;
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(source[i + 1] ?? ''))) {
      const m = source.slice(i).match(/^\d*\.?\d+(?:[eE][-+]?\d+)?/)!;
      tokens.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = source.slice(i).match(/^[A-Za-z_$][\w$]*/)!;
      tokens.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const two = source.slice(i, i + 2);
      if (['&&', '||', '==', '!=', '>=', '<='].includes(two)) {
        tokens.push({ t: 'op', v: two });
        i += 2;
      } else if ('()[],.!<>+-*/%'.includes(c)) {
        tokens.push({ t: 'op', v: c });
        i++;
      } else {
        throw new UnsupportedExpression(`“${c}”`);
      }
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parseAll(): Ast {
    const ast = this.or();
    if (this.pos < this.tokens.length) throw new Error(`Unexpected “${this.tokens[this.pos].v}”`);
    return ast;
  }

  private peek(v?: string): Token | undefined {
    const token = this.tokens[this.pos];
    return token && (v === undefined || (token.t === 'op' && token.v === v)) ? token : undefined;
  }

  private take(v: string): boolean {
    if (this.peek(v)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(v: string): void {
    if (!this.take(v)) throw new Error(`Expected “${v}”`);
  }

  private binary(next: () => Ast, ops: string[]): Ast {
    let left = next();
    for (;;) {
      const op = ops.find(o => this.peek(o));
      if (!op) return left;
      this.pos++;
      left = { k: 'binary', op, a: left, b: next() };
    }
  }

  private or = (): Ast => this.binary(this.and, ['||']);
  private and = (): Ast => this.binary(this.equality, ['&&']);
  private equality = (): Ast => this.binary(this.comparison, ['==', '!=']);
  private comparison = (): Ast => this.binary(this.additive, ['>=', '<=', '>', '<']);
  private additive = (): Ast => this.binary(this.multiplicative, ['+', '-']);
  private multiplicative = (): Ast => this.binary(this.unary, ['*', '/', '%']);

  private unary = (): Ast => {
    if (this.take('!')) return { k: 'unary', op: '!', arg: this.unary() };
    if (this.take('-')) return { k: 'unary', op: '-', arg: this.unary() };
    return this.postfix();
  };

  private postfix(): Ast {
    let node = this.primary();
    for (;;) {
      if (this.take('.')) {
        const token = this.tokens[this.pos++];
        if (!token || token.t !== 'id') throw new Error('Expected a name after “.”');
        node = { k: 'member', obj: node, name: token.v };
      } else if (this.take('(')) {
        const args: Ast[] = [];
        if (!this.take(')')) {
          do args.push(this.or()); while (this.take(','));
          this.expect(')');
        }
        node = { k: 'call', callee: node, args };
      } else if (this.take('[')) {
        const index = this.or();
        this.expect(']');
        node = { k: 'index', obj: node, index };
      } else {
        return node;
      }
    }
  }

  private primary(): Ast {
    const token = this.tokens[this.pos++];
    if (!token) throw new Error('Unexpected end of expression');
    if (token.t === 'num') return { k: 'lit', v: Number(token.v) };
    if (token.t === 'str') return { k: 'lit', v: token.v };
    if (token.t === 'id') {
      if (token.v === 'true' || token.v === 'false') return { k: 'lit', v: token.v === 'true' };
      if (token.v === 'null') return { k: 'lit', v: null };
      return { k: 'id', name: token.v };
    }
    if (token.v === '(') {
      const inner = this.or();
      this.expect(')');
      return inner;
    }
    if (token.v === '[') {
      const items: Ast[] = [];
      if (!this.take(']')) {
        do items.push(this.or()); while (this.take(','));
        this.expect(']');
      }
      return { k: 'list', items };
    }
    throw new Error(`Unexpected “${token.v}”`);
  }
}

/** What an expression is evaluated against: one file of the vault. */
export class BaseContext {
  private readonly properties: Map<string, IndexedProperty>;
  private readonly formulaStack = new Set<string>();

  constructor(
    readonly entry: VaultEntry,
    private readonly index: VaultIndex,
    private readonly formulas: Record<string, string>,
    /** The `.base` file itself (for `this.file`). */
    private readonly thisEntry: VaultEntry | null,
  ) {
    this.properties = new Map(index.getProperties(entry.relativePath).map(p => [p.key.toLowerCase(), p]));
  }

  /** Value of a column/sort reference: `file.name`, `note.x`, `formula.x` or a bare property name. */
  property(ref: string): BaseValue {
    if (ref.startsWith('formula.')) return this.formula(ref.slice(8));
    if (ref.startsWith('file.')) return this.fileMember({ kind: 'file', entry: this.entry }, ref.slice(5));
    return this.note(ref.startsWith('note.') ? ref.slice(5) : ref);
  }

  evaluate(source: string): BaseValue {
    return this.eval(parseExpression(source));
  }

  note(key: string): BaseValue {
    const property = this.properties.get(key.toLowerCase());
    return property ? propertyToValue(property) : null;
  }

  private formula(name: string): BaseValue {
    const source = this.formulas[name];
    if (source === undefined) return null;
    if (this.formulaStack.has(name)) throw new UnsupportedExpression(`formula.${name} refers to itself`);
    this.formulaStack.add(name);
    try {
      return this.evaluate(source);
    } finally {
      this.formulaStack.delete(name);
    }
  }

  private eval(node: Ast): BaseValue {
    switch (node.k) {
      case 'lit':
        return node.v;
      case 'list':
        return node.items.map(item => this.eval(item));
      case 'id':
        if (node.name === 'file') return { kind: 'file', entry: this.entry };
        if (['note', 'formula', 'this'].includes(node.name)) throw new UnsupportedExpression(`“${node.name}” on its own`);
        return this.note(node.name);
      case 'member':
        return this.member(node);
      case 'index': {
        if (node.obj.k === 'id' && node.obj.name === 'note') return this.note(valueToText(this.eval(node.index)));
        if (node.obj.k === 'id' && node.obj.name === 'formula') return this.formula(valueToText(this.eval(node.index)));
        const obj = this.eval(node.obj);
        const index = this.eval(node.index);
        if (Array.isArray(obj) && typeof index === 'number') return obj[index < 0 ? obj.length + index : index] ?? null;
        throw new UnsupportedExpression('indexing');
      }
      case 'call':
        return this.call(node);
      case 'unary': {
        const value = this.eval(node.arg);
        if (node.op === '!') return !truthy(value);
        return -Number(value);
      }
      case 'binary':
        return this.binary(node.op, node.a, node.b);
    }
  }

  private member(node: Extract<Ast, { k: 'member' }>): BaseValue {
    const obj = node.obj;
    if (obj.k === 'id' && obj.name === 'note') return this.note(node.name);
    if (obj.k === 'id' && obj.name === 'formula') return this.formula(node.name);
    if (obj.k === 'id' && obj.name === 'this') {
      if (node.name === 'file' && this.thisEntry) return { kind: 'file', entry: this.thisEntry };
      throw new UnsupportedExpression(`this.${node.name}`);
    }
    if (obj.k === 'member' && obj.obj.k === 'id' && obj.obj.name === 'this' && obj.name === 'file' && this.thisEntry) {
      return this.fileMember({ kind: 'file', entry: this.thisEntry }, node.name);
    }

    const value = this.eval(obj);
    if (isFileValue(value)) return this.fileMember(value, node.name);
    if (node.name === 'length' && (typeof value === 'string' || Array.isArray(value))) return value.length;
    if (value instanceof Date) {
      const fields: Record<string, () => number> = {
        year: () => value.getFullYear(), month: () => value.getMonth() + 1, day: () => value.getDate(),
        hour: () => value.getHours(), minute: () => value.getMinutes(), second: () => value.getSeconds(),
        millisecond: () => value.getMilliseconds(),
      };
      if (fields[node.name]) return fields[node.name]();
    }
    if (value === null) return null;
    throw new UnsupportedExpression(`.${node.name}`);
  }

  private fileMember(file: FileValue, name: string): BaseValue {
    const entry = file.entry;
    const extension = getFileExtension(entry.name);
    switch (name) {
      case 'name': return entry.name;
      case 'basename': return extension ? entry.name.slice(0, -(extension.length + 1)) : entry.name;
      case 'path': return entry.relativePath;
      case 'folder': return entry.parentPath;
      case 'ext': return extension;
      case 'tags': return this.index.getTags(entry.relativePath).map(tag => `#${tag}`);
      case 'links': return this.index.getOutgoingLinks(entry.relativePath).map(target => ({ kind: 'file', entry: target }) as FileValue);
      case 'backlinks': return this.index.getBacklinks(entry.relativePath).map(source => ({ kind: 'file', entry: source }) as FileValue);
      case 'mtime': {
        const modified = this.index.getModified(entry.relativePath);
        return modified ? new Date(modified) : null;
      }
      case 'file': return file;
      default: throw new UnsupportedExpression(`file.${name}`);
    }
  }

  private call(node: Extract<Ast, { k: 'call' }>): BaseValue {
    const args = () => node.args.map(arg => this.eval(arg));
    if (node.callee.k === 'id') return this.globalFunction(node.callee.name, node.args);
    if (node.callee.k !== 'member') throw new UnsupportedExpression('call');

    const name = node.callee.name;
    const receiver = this.eval(node.callee.obj);
    const values = args();

    if (isFileValue(receiver)) {
      const path = receiver.entry.relativePath;
      switch (name) {
        case 'hasTag': {
          const tags = this.index.getTags(path);
          return values.some(value => {
            const wanted = valueToText(value).replace(/^#/, '').toLowerCase();
            return tags.some(tag => tag === wanted || tag.startsWith(`${wanted}/`));
          });
        }
        case 'inFolder': {
          const folder = valueToText(values[0] ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
          const parent = receiver.entry.parentPath.toLowerCase();
          return !folder || parent === folder || parent.startsWith(`${folder}/`);
        }
        case 'hasLink': {
          const target = this.resolveTarget(values[0] ?? null);
          return !!target && this.index.getOutgoingLinks(path).some(entry => entry.relativePath === target.relativePath);
        }
        case 'hasProperty':
          return this.index.getProperties(path).some(p => p.key.toLowerCase() === valueToText(values[0] ?? '').toLowerCase());
        case 'asLink':
          return { kind: 'link', target: receiver.entry.relativePath, display: values[0] !== undefined ? valueToText(values[0]) : null };
      }
    }

    switch (name) {
      case 'isEmpty': return isEmptyValue(receiver);
      case 'isTruthy': return truthy(receiver);
      case 'toString': return valueToText(receiver);
      case 'contains':
        if (Array.isArray(receiver)) return receiver.some(item => this.equals(item, values[0] ?? null));
        if (receiver === null) return false;
        return valueToText(receiver).includes(valueToText(values[0] ?? ''));
      case 'containsAll':
      case 'containsAny': {
        const has = (wanted: BaseValue) => Array.isArray(receiver)
          ? receiver.some(item => this.equals(item, wanted))
          : receiver !== null && valueToText(receiver).includes(valueToText(wanted));
        return name === 'containsAll' ? values.every(has) : values.some(has);
      }
    }

    if (receiver === null) return null;

    if (typeof receiver === 'string') {
      const arg = (i: number) => valueToText(values[i] ?? '');
      switch (name) {
        case 'startsWith': return receiver.startsWith(arg(0));
        case 'endsWith': return receiver.endsWith(arg(0));
        case 'lower': return receiver.toLowerCase();
        case 'upper': return receiver.toUpperCase();
        case 'title': return receiver.replace(/\b\p{L}/gu, c => c.toUpperCase());
        case 'trim': return receiver.trim();
        case 'slice': return receiver.slice(Number(values[0] ?? 0), values[1] === undefined ? undefined : Number(values[1]));
        case 'split': return receiver.split(arg(0)).slice(0, values[1] === undefined ? undefined : Number(values[1]));
        case 'replace': return receiver.split(arg(0)).join(arg(1));
        case 'repeat': return receiver.repeat(Math.max(0, Number(values[0] ?? 0)));
        case 'reverse': return [...receiver].reverse().join('');
      }
    }

    if (Array.isArray(receiver)) {
      switch (name) {
        case 'join': return receiver.map(valueToText).join(values[0] === undefined ? ', ' : valueToText(values[0]));
        case 'unique': return receiver.filter((item, i) => receiver.findIndex(other => this.equals(other, item)) === i);
        case 'sort': return [...receiver].sort(compareValues);
        case 'reverse': return [...receiver].reverse();
        case 'flat': return receiver.flat() as BaseValue[];
        case 'slice': return receiver.slice(Number(values[0] ?? 0), values[1] === undefined ? undefined : Number(values[1]));
      }
    }

    if (typeof receiver === 'number') {
      switch (name) {
        case 'abs': return Math.abs(receiver);
        case 'ceil': return Math.ceil(receiver);
        case 'floor': return Math.floor(receiver);
        case 'round': {
          const factor = 10 ** Number(values[0] ?? 0);
          return Math.round(receiver * factor) / factor;
        }
        case 'toFixed': return receiver.toFixed(Number(values[0] ?? 0));
      }
    }

    if (receiver instanceof Date) {
      switch (name) {
        case 'date': return new Date(receiver.getFullYear(), receiver.getMonth(), receiver.getDate());
        case 'format': return formatMoment(receiver, valueToText(values[0] ?? 'YYYY-MM-DD'));
        case 'time': return formatMoment(receiver, 'HH:mm:ss');
      }
    }

    throw new UnsupportedExpression(`${name}()`);
  }

  private globalFunction(name: string, argNodes: Ast[]): BaseValue {
    if (name === 'if') {
      const condition = this.eval(argNodes[0] ?? { k: 'lit', v: null });
      const branch = truthy(condition) ? argNodes[1] : argNodes[2];
      return branch ? this.eval(branch) : null;
    }
    const values = argNodes.map(arg => this.eval(arg));
    switch (name) {
      case 'now': return new Date();
      case 'today': {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }
      case 'date': return values[0] instanceof Date ? values[0] : parseDate(valueToText(values[0] ?? ''));
      case 'number': {
        const value = values[0] ?? null;
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'boolean') return value ? 1 : 0;
        const n = Number(valueToText(value));
        return Number.isFinite(n) ? n : null;
      }
      case 'list': return Array.isArray(values[0]) ? values[0] : values[0] === undefined || values[0] === null ? [] : [values[0]];
      case 'link': return { kind: 'link', target: valueToText(values[0] ?? ''), display: values[1] !== undefined ? valueToText(values[1]) : null };
      case 'file': {
        const entry = this.resolveTarget(values[0] ?? null);
        return entry ? { kind: 'file', entry } : null;
      }
      case 'min':
      case 'max': {
        const numbers = values.map(Number).filter(Number.isFinite);
        return numbers.length ? (name === 'min' ? Math.min(...numbers) : Math.max(...numbers)) : null;
      }
    }
    throw new UnsupportedExpression(`${name}()`);
  }

  private binary(op: string, aNode: Ast, bNode: Ast): BaseValue {
    if (op === '&&') return truthy(this.eval(aNode)) && truthy(this.eval(bNode));
    if (op === '||') return truthy(this.eval(aNode)) || truthy(this.eval(bNode));

    const a = this.eval(aNode);
    const b = this.eval(bNode);
    switch (op) {
      case '==': return this.equals(a, b);
      case '!=': return !this.equals(a, b);
      case '>': case '<': case '>=': case '<=': {
        if (a === null || b === null) return false;
        const cmp = compareValues(a, coerceLike(b, a));
        return op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : op === '>=' ? cmp >= 0 : cmp <= 0;
      }
      case '+':
      case '-': {
        if (a instanceof Date) {
          const ms = durationMs(b);
          if (ms !== null) return new Date(a.getTime() + (op === '+' ? ms : -ms));
          if (op === '-' && b instanceof Date) return a.getTime() - b.getTime();
        }
        if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return valueToText(a) + valueToText(b);
        return op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
      }
      case '*': return Number(a) * Number(b);
      case '/': return Number(a) / Number(b);
      case '%': return Number(a) % Number(b);
    }
    throw new UnsupportedExpression(op);
  }

  /** Equality that treats numbers/numeric text, dates/date text and links/files to the same note as equal. */
  equals(a: BaseValue, b: BaseValue): boolean {
    if (a === null || b === null) return isEmptyValue(a) && isEmptyValue(b);
    if (isLinkish(a) || isLinkish(b)) {
      const left = this.resolveTarget(a);
      const right = this.resolveTarget(b);
      if (left && right) return left.relativePath === right.relativePath;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => this.equals(item, b[i]));
    }
    const right = coerceLike(b, a);
    const left = coerceLike(a, right);
    return typeof left === typeof right && compareValues(left, right) === 0;
  }

  /** The vault file a link, file, `[[link]]` text or path refers to. */
  private resolveTarget(value: BaseValue): VaultEntry | null {
    if (value === null || Array.isArray(value) || typeof value === 'boolean' || typeof value === 'number' || value instanceof Date) return null;
    if (isFileValue(value)) return value.entry;
    const raw = isLinkValue(value) ? value.target : value;
    const wiki = raw.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
    return this.index.resolveLink(wiki ? wiki[1] : raw, this.entry.relativePath);
  }
}

function isLinkish(value: BaseValue): boolean {
  return isFileValue(value) || isLinkValue(value) || (typeof value === 'string' && /^\[\[[^\]]+\]\]$/.test(value));
}

/** Converts `value` to the type of `like` when that's the obvious reading (e.g. "3" next to a number). */
function coerceLike(value: BaseValue, like: BaseValue): BaseValue {
  if (typeof like === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (like instanceof Date && typeof value === 'string') return parseDate(value) ?? value;
  return value;
}

/** Orders values: numbers, dates, booleans and text (case-insensitive, natural); empty values last. */
export function compareValues(a: BaseValue, b: BaseValue): number {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return valueToText(a).localeCompare(valueToText(b), undefined, { numeric: true, sensitivity: 'base' });
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000, second: 1000, seconds: 1000,
  m: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  M: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
  y: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

function durationMs(value: BaseValue): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const unit = DURATION_UNITS[m[2]] ?? DURATION_UNITS[m[2].toLowerCase()];
  return unit ? Number(m[1]) * unit : null;
}

function formatMoment(date: Date, format: string): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()), YY: pad(date.getFullYear() % 100), MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1), DD: pad(date.getDate()), D: String(date.getDate()), HH: pad(date.getHours()),
    H: String(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()),
  };
  return format.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, token => tokens[token]);
}

// ---------------------------------------------------------------- running a view

export interface BaseResultGroup {
  label: string;
  /** The group's value as text; null for "no value". */
  value: string | null;
  rows: BaseRow[];
}

export interface BaseRow {
  entry: VaultEntry;
  context: BaseContext;
}

export interface BaseResult {
  rows: BaseRow[];
  /** Set when the view groups its rows. */
  groups: BaseResultGroup[] | null;
  /** Groups left out by the view's `groupOrder`, with how many rows they hold. */
  hiddenGroups: { label: string; value: string | null; count: number }[];
  /** Matching files before the view's limit. */
  total: number;
  /** Filter statements or columns that use things this app can't evaluate (they're skipped). */
  warnings: string[];
}

/** Runs view `viewIndex` of `config` over every file in the vault. */
export function runBaseView(config: BaseConfig, viewIndex: number, index: VaultIndex, basePath: string | null): BaseResult {
  const view = config.views[viewIndex] ?? null;
  const warnings = new Set<string>();
  const thisEntry = basePath ? index.getByPath(basePath) : null;

  const rows: BaseRow[] = [];
  for (const entry of index.files) {
    const context = new BaseContext(entry, index, config.formulas, thisEntry);
    if (evalFilter(config.filters, context, warnings) === false) continue;
    if (view && evalFilter(view.filters, context, warnings) === false) continue;
    rows.push({ entry, context });
  }

  const value = (row: BaseRow, property: string): BaseValue => {
    try {
      return row.context.property(property);
    } catch (error) {
      warnings.add(describeUnsupported(property, error));
      return null;
    }
  };

  const sorts = view?.sort.length ? view.sort : [{ property: 'file.name', direction: 'ASC' as const }];
  rows.sort((a, b) => {
    for (const sort of sorts) {
      const left = value(a, sort.property);
      const right = value(b, sort.property);
      const emptyOrder = compareValues(isEmptyValue(left) ? null : 0, isEmptyValue(right) ? null : 0);
      if (emptyOrder) return emptyOrder;
      const cmp = compareValues(left, right);
      if (cmp) return sort.direction === 'DESC' ? -cmp : cmp;
    }
    return a.entry.relativePath.localeCompare(b.entry.relativePath);
  });

  const total = rows.length;
  const limited = view?.limit ? rows.slice(0, view.limit) : rows;

  let groups: BaseResultGroup[] | null = null;
  let hiddenGroups: BaseResult['hiddenGroups'] = [];
  const groupBy = view?.groupBy;
  if (groupBy) {
    const byKey = new Map<string, { value: BaseValue; rows: BaseRow[] }>();
    for (const row of limited) {
      const groupValue = value(row, groupBy.property);
      const key = valueToText(groupValue);
      const group = byKey.get(key) ?? { value: groupValue, rows: [] };
      group.rows.push(row);
      byKey.set(key, group);
    }
    const toGroup = (key: string, rows: BaseRow[]): BaseResultGroup =>
      ({ label: key || 'No value', value: key || null, rows });

    if (view.groupOrder) {
      // Listed groups in that order (even when empty: they're board columns); the rest are hidden.
      const listed = new Set(view.groupOrder.map(item => item ?? ''));
      groups = view.groupOrder.map(item => toGroup(item ?? '', byKey.get(item ?? '')?.rows ?? []));
      hiddenGroups = Array.from(byKey.entries())
        .filter(([key]) => !listed.has(key))
        .map(([key, group]) => ({ label: key || 'No value', value: key || null, count: group.rows.length }));
    } else {
      groups = Array.from(byKey.entries())
        .sort(([, a], [, b]) => {
          const cmp = compareValues(a.value, b.value);
          return groupBy.direction === 'DESC' && !isEmptyValue(a.value) && !isEmptyValue(b.value) ? -cmp : cmp;
        })
        .map(([key, group]) => toGroup(key, group.rows));
    }
  }

  // Columns that can't be evaluated: check against one row so the warning shows even if empty.
  if (limited[0] && view) view.order.forEach(property => value(limited[0], property));

  return { rows: limited, groups, hiddenGroups, total, warnings: Array.from(warnings) };
}

/** What a new note needs to show up in a view: taken from the view's simple (AND-ed) filters. */
export interface NewNoteDefaults {
  /** Folder from an `inFolder` filter, or null to use the database's folder. */
  folder: string | null;
  tags: string[];
  /** Properties from `property is value` filters. */
  properties: { key: string; value: string }[];
}

export function newNoteDefaults(config: BaseConfig, viewIndex: number): NewNoteDefaults {
  const defaults: NewNoteDefaults = { folder: null, tags: [], properties: [] };
  for (const filter of [config.filters, config.views[viewIndex]?.filters ?? null]) {
    for (const condition of filterToConditions(filter) ?? []) {
      if (condition.kind === 'tag' && condition.value && !defaults.tags.includes(condition.value)) {
        defaults.tags.push(condition.value);
      } else if (condition.kind === 'folder' && condition.value && defaults.folder === null) {
        defaults.folder = condition.value.replace(/^\/+|\/+$/g, '');
      } else if (condition.kind === 'property' && condition.op === 'is' && notePropertyKey(condition.property)) {
        defaults.properties.push({ key: condition.property, value: condition.value });
      }
    }
  }
  return defaults;
}

/** The note property a reference points at, or null for `file.*` / `formula.*` (not writable). */
export function notePropertyKey(ref: string): string | null {
  if (ref.startsWith('file.') || ref.startsWith('formula.')) return null;
  return ref.startsWith('note.') ? ref.slice(5) : ref;
}

/** A ready-made quest board: #quest notes grouped by status, plus a table of all quests. */
export const QUEST_TRACKER_CONTENT = [
  'filters:',
  '  and:',
  '    - file.hasTag("quest")',
  'views:',
  '  - type: kanban',
  '    name: Board',
  '    groupBy:',
  '      property: status',
  '      direction: ASC',
  '    groupOrder:',
  '      - open',
  '      - active',
  '      - done',
  '    order:',
  '      - file.name',
  '      - giver',
  '      - location',
  '      - reward',
  '  - type: table',
  '    name: All quests',
  '    order:',
  '      - file.name',
  '      - status',
  '      - giver',
  '      - location',
  '      - reward',
  '    sort:',
  '      - property: status',
  '        direction: ASC',
  '',
].join('\n');

/** true/false, or null when the filter couldn't be evaluated (unknown parts are skipped). */
function evalFilter(filter: BaseFilter | null, context: BaseContext, warnings: Set<string>): boolean | null {
  if (filter === null) return null;
  if (typeof filter === 'string') {
    try {
      return truthy(context.evaluate(filter));
    } catch (error) {
      warnings.add(describeUnsupported(filter, error));
      return null;
    }
  }
  const op = 'and' in filter ? 'and' : 'or' in filter ? 'or' : 'not';
  const results = (filter as Record<string, BaseFilter[]>)[op]
    .map(child => evalFilter(child, context, warnings))
    .filter((result): result is boolean => result !== null);
  if (!results.length) return null;
  if (op === 'and') return results.every(Boolean);
  if (op === 'or') return results.some(Boolean);
  return !results.some(Boolean);
}

function describeUnsupported(source: string, error: unknown): string {
  const detail = error instanceof UnsupportedExpression ? `uses ${error.message}` : error instanceof Error ? error.message : String(error);
  return `${source} — ${detail}`;
}

/** Default column header for a property reference. */
export function defaultColumnName(property: string): string {
  const fileNames: Record<string, string> = {
    'file.name': 'Name', 'file.basename': 'Name', 'file.path': 'Path', 'file.folder': 'Folder', 'file.ext': 'Extension',
    'file.tags': 'Tags', 'file.links': 'Links', 'file.backlinks': 'Backlinks', 'file.mtime': 'Modified',
    'file.ctime': 'Created', 'file.size': 'Size',
  };
  if (fileNames[property]) return fileNames[property];
  if (property.startsWith('formula.')) return property.slice(8);
  if (property.startsWith('note.')) return property.slice(5);
  return property;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

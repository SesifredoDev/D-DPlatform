/**
 * YAML frontmatter helpers (the `---` block at the top of a note, used by Obsidian for Properties).
 *
 * These only touch the parts they need and leave every other line of the frontmatter exactly as written.
 */

export interface FrontmatterSplit {
  /** The raw frontmatter block, including delimiters and any blank lines after it; '' if none. */
  block: string;
  /** The YAML between the delimiters, or null if the note has no frontmatter. */
  yaml: string | null;
  /** Blank lines between the closing `---` and the body (kept so saving doesn't reflow the note). */
  gap: string;
  /** Everything after the frontmatter. */
  body: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)((?:[ \t]*\r?\n)*)/;

export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = content.match(FRONTMATTER);
  if (!match) return { block: '', yaml: null, gap: '', body: content };

  return {
    block: match[0],
    yaml: match[1].replace(/\r?\n$/, ''),
    gap: match[2],
    body: content.slice(match[0].length),
  };
}

/** Tags from the frontmatter `tags:` (or `tag:`) property, without '#', in the order written. */
export function readFrontmatterTags(content: string): string[] {
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return [];

  const lines = yaml.split(/\r?\n/);
  const found = findTagsProperty(lines);
  if (!found) return [];

  const values = found.inlineValue !== ''
    ? parseInlineList(found.inlineValue)
    : lines.slice(found.start + 1, found.end).map(line => line.replace(/^\s*-\s*/, ''));

  return unique(values.map(cleanTag).filter(Boolean));
}

/**
 * Returns `content` with the frontmatter `tags` property set to `tags`.
 * - Keeps the property's existing style (`tags: [a, b]` or a `- a` list); new properties use a list,
 *   like Obsidian's Properties editor.
 * - Adds frontmatter if the note has none; removes the property (and an emptied frontmatter) when
 *   `tags` is empty.
 */
export function setFrontmatterTags(content: string, tags: string[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const split = splitFrontmatter(content);
  const lines = split.yaml === null || split.yaml === '' ? [] : split.yaml.split(/\r?\n/);
  const cleanTags = unique(tags.map(cleanTag).filter(Boolean));

  const found = findTagsProperty(lines);
  const insertAt = found ? found.start : lines.length;
  const flowStyle = !!found && found.inlineValue.startsWith('[');
  if (found) {
    lines.splice(found.start, found.end - found.start);
  }

  if (cleanTags.length) {
    const property = flowStyle
      ? [`tags: [${cleanTags.join(', ')}]`]
      : ['tags:', ...cleanTags.map(tag => `  - ${tag}`)];
    lines.splice(insertAt, 0, ...property);
  }

  if (!lines.length) {
    return split.body;
  }
  return `---${eol}${lines.join(eol)}${eol}---${eol}${split.gap}${split.body}`;
}

/**
 * Normalises what someone types into a tag: strips '#', turns spaces into '-', drops characters
 * Obsidian doesn't allow. Returns null if nothing valid is left (tags can't be all digits).
 */
export function normalizeTagInput(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '');

  return tag && /[^\d/]/.test(tag) ? tag : null;
}

/** Finds the `tags:`/`tag:` property: its line, the end of its list items, and any same-line value. */
function findTagsProperty(lines: string[]): { start: number; end: number; inlineValue: string } | null {
  const start = lines.findIndex(line => /^tags?\s*:/i.test(line));
  if (start < 0) return null;

  const inlineValue = lines[start].replace(/^tags?\s*:\s*/i, '').trim();
  let end = start + 1;
  if (inlineValue === '') {
    // Block list items (or other indented continuation lines) belong to the property.
    while (end < lines.length && /^(\s+\S|\s*-\s)/.test(lines[end])) end++;
  }
  return { start, end, inlineValue };
}

function parseInlineList(value: string): string[] {
  const inner = value.startsWith('[') ? value.replace(/^\[|\]$/g, '') : value;
  return inner.split(/[,\s]+/);
}

function cleanTag(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- properties

/**
 * Property types, matching Obsidian's Properties view. `complex` is anything this editor doesn't
 * edit (nested maps, multi-line text, lists of lists): it's shown read-only and kept as written.
 */
export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'complex';

export interface NoteProperty {
  /** The key as written, without quotes. */
  key: string;
  type: PropertyType;
  /** Scalar value without quotes ('' when empty, `'true'`/`'false'` for checkboxes). '' for lists. */
  value: string;
  /** List items without quotes. Empty for scalars. */
  items: string[];
  /** True when nothing is written after the key. */
  empty: boolean;
  /** The property's YAML lines as written. */
  raw: string;
}

/** What to write for a property. `value` is used by scalars, `items` by lists. */
export interface PropertyValue {
  type: Exclude<PropertyType, 'complex'>;
  value?: string;
  items?: string[];
}

interface PropertyRange {
  key: string;
  /** The key exactly as written on the line, quotes included. */
  keyText: string;
  start: number;
  end: number;
  /** What follows `key:` on the first line, trimmed. */
  inlineValue: string;
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'\-:][^:]*?|-[^\s:][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const BOOLEAN = /^(?:true|false)$/i;
const NULL = /^(?:null|~)$/i;
const CONTINUATION = /^(?:\s+\S|-(?:\s|$))/;

/** The note's top-level frontmatter properties, in the order written. */
export function readProperties(content: string): NoteProperty[] {
  const { yaml } = splitFrontmatter(content);
  if (!yaml) return [];
  const lines = yaml.split(/\r?\n/);
  return findPropertyRanges(lines).map(range => parseProperty(range, lines));
}

/**
 * Returns `content` with property `key` set. Only that property's lines change: its key is kept as
 * written, and a list keeps its `[a, b]` or `- a` style. Adds the property (and frontmatter) if missing.
 */
export function setProperty(content: string, key: string, next: PropertyValue): string {
  return editProperties(content, (lines, ranges) => {
    const range = findRange(ranges, key);
    const keyText = range?.keyText ?? formatYamlKey(key);
    const existing = range ? lines.slice(range.start, range.end) : [];
    const written = writeProperty(keyText, next, range?.inlineValue ?? '', existing);
    if (range) {
      lines.splice(range.start, range.end - range.start, ...written);
    } else {
      lines.push(...written);
    }
  });
}

/** Returns `content` without property `key` (and without frontmatter if nothing is left). */
export function removeProperty(content: string, key: string): string {
  return editProperties(content, (lines, ranges) => {
    const range = findRange(ranges, key);
    if (range) lines.splice(range.start, range.end - range.start);
  });
}

/** Returns `content` with property `oldKey` renamed to `newKey`; its value is left untouched. */
export function renameProperty(content: string, oldKey: string, newKey: string): string {
  return editProperties(content, (lines, ranges) => {
    const range = findRange(ranges, oldKey);
    if (!range) return;
    lines[range.start] = formatYamlKey(newKey) + lines[range.start].slice(range.keyText.length);
  });
}

/** True if the note already has a property called `key` (case-insensitive, like Obsidian). */
export function hasProperty(content: string, key: string): boolean {
  const wanted = key.trim().toLowerCase();
  return readProperties(content).some(property => property.key.toLowerCase() === wanted);
}

/** Converts a property's value to another type, keeping what still makes sense. */
export function convertProperty(property: NoteProperty, type: PropertyValue['type']): PropertyValue {
  const scalar = property.type === 'list' ? property.items.join(', ') : property.type === 'complex' ? '' : property.value;
  switch (type) {
    case 'list':
      return { type, items: property.type === 'list' ? property.items : scalar ? [scalar] : [] };
    case 'number':
      return { type, value: NUMBER.test(scalar) ? scalar : '' };
    case 'checkbox':
      return { type, value: /^(?:true|yes|on|1)$/i.test(scalar) ? 'true' : 'false' };
    case 'date':
      return { type, value: DATE.test(scalar.slice(0, 10)) ? scalar.slice(0, 10) : '' };
    case 'datetime':
      return { type, value: DATETIME.test(scalar) ? scalar : DATE.test(scalar) ? `${scalar}T00:00` : '' };
    default:
      return { type, value: scalar };
  }
}

/**
 * The value to write to restore a property as it was (for undo). null when the note didn't have
 * it; `complex` values can't be restored this way, so they also give null.
 */
export function propertyValueOf(content: string, key: string): PropertyValue | null {
  const wanted = key.trim().toLowerCase();
  const property = readProperties(content).find(item => item.key.toLowerCase() === wanted);
  if (!property || property.type === 'complex') return null;
  if (property.type === 'list') return { type: 'list', items: property.items };
  return { type: property.empty ? 'text' : property.type, value: property.value };
}

/** Maps a type name from Obsidian's `.obsidian/types.json` to a property type. */
export function propertyTypeFromObsidian(name: unknown): PropertyValue['type'] | null {
  switch (name) {
    case 'text':
    case 'number':
    case 'checkbox':
    case 'date':
    case 'datetime':
      return name;
    case 'multitext':
    case 'aliases':
    case 'tags':
      return 'list';
    default:
      return null;
  }
}

/** Formats a value as a YAML scalar, quoting it only when needed (links, `true` as text, `: `…). */
export function formatYamlScalar(value: string, options: { keepTyped?: boolean; inFlowList?: boolean } = {}): string {
  const looksTyped =
    BOOLEAN.test(value) || NULL.test(value) || NUMBER.test(value) || DATE.test(value) || DATETIME.test(value) ||
    /^(?:yes|no|on|off)$/i.test(value);
  const needsQuotes =
    value === '' ||
    /^\s|\s$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:(?:\s|$)|\s#/.test(value) ||
    /[\r\n\t]/.test(value) ||
    (!!options.inFlowList && /[,[\]{}]/.test(value)) ||
    (!options.keepTyped && looksTyped);
  return needsQuotes ? JSON.stringify(value) : value;
}

function formatYamlKey(key: string): string {
  const clean = key.trim();
  return /^[^\s#"'\-:?,[\]{}&*!|>%@`][^:#]*$/.test(clean) && !/\s$/.test(clean) ? clean : JSON.stringify(clean);
}

function writeProperty(keyText: string, next: PropertyValue, oldInline: string, oldLines: string[]): string[] {
  if (next.type !== 'list') {
    const value = (next.value ?? '').trim();
    if (!value) return [`${keyText}:`];
    return [`${keyText}: ${next.type === 'text' ? formatYamlScalar(value) : value}`];
  }

  const items = (next.items ?? []).map(item => item.trim()).filter(Boolean);
  if (!items.length) return [`${keyText}: []`];
  if (oldInline.startsWith('[')) {
    const formatted = items.map(item => formatYamlScalar(item, { keepTyped: true, inFlowList: true }));
    return [`${keyText}: [${formatted.join(', ')}]`];
  }
  const indent = oldLines.slice(1).find(line => /^\s*-/.test(line))?.match(/^\s*/)?.[0] ?? '  ';
  return [`${keyText}:`, ...items.map(item => `${indent}- ${formatYamlScalar(item, { keepTyped: true })}`)];
}

function editProperties(content: string, edit: (lines: string[], ranges: PropertyRange[]) => void): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const split = splitFrontmatter(content);
  const lines = split.yaml === null || split.yaml === '' ? [] : split.yaml.split(/\r?\n/);
  edit(lines, findPropertyRanges(lines));

  if (!lines.some(line => line.trim())) {
    return split.body;
  }
  return `---${eol}${lines.join(eol)}${eol}---${eol}${split.gap}${split.body}`;
}

function findRange(ranges: PropertyRange[], key: string): PropertyRange | undefined {
  const wanted = key.trim();
  return ranges.find(range => range.key === wanted)
    ?? ranges.find(range => range.key.toLowerCase() === wanted.toLowerCase());
}

/** Top-level `key: value` properties with the lines that belong to each (list items, indented lines). */
function findPropertyRanges(lines: string[]): PropertyRange[] {
  const ranges: PropertyRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(KEY_LINE);
    if (!match) continue;

    let end = i + 1;
    let next = end;
    // Lines that belong to the property may be separated by blank lines (e.g. inside a `|` block).
    while (next < lines.length) {
      if (!lines[next].trim()) {
        next++;
        continue;
      }
      if (!CONTINUATION.test(lines[next])) break;
      end = ++next;
    }

    ranges.push({ key: unquoteKey(match[1]), keyText: match[1], start: i, end, inlineValue: (match[2] ?? '').trim() });
    i = end - 1;
  }
  return ranges;
}

function parseProperty(range: PropertyRange, lines: string[]): NoteProperty {
  const raw = lines.slice(range.start, range.end).join('\n');
  const rest = lines.slice(range.start + 1, range.end).filter(line => line.trim());
  const inline = range.inlineValue;
  const base = { key: range.key, value: '', items: [] as string[], empty: false, raw };
  const complex = (): NoteProperty => ({ ...base, type: 'complex' });

  if (inline === '' || inline.startsWith('#')) {
    if (!rest.length) return { ...base, type: 'text', empty: true };
    if (!rest.every(line => /^\s*-(?:\s|$)/.test(line))) return complex();
    const items: string[] = [];
    for (const line of rest) {
      const text = line.replace(/^\s*-\s?/, '').trim();
      if (!text) continue;
      const nested = /^[[{]/.test(text) || /^-(?:\s|$)/.test(text) || (KEY_LINE.test(text) && !/^["']/.test(text));
      if (nested) return complex();
      items.push(parseScalar(text).value);
    }
    return { ...base, type: 'list', items };
  }

  if (rest.length || /^[|>{&*!]/.test(inline)) return complex();

  if (inline.startsWith('[')) {
    const body = inline.replace(/\s+#.*$/, '');
    if (!body.endsWith(']')) return complex();
    const parts = splitFlowList(body.slice(1, -1));
    if (parts.some(part => /^[[{]/.test(part))) return complex();
    return { ...base, type: 'list', items: parts.map(part => parseScalar(part).value).filter(Boolean) };
  }

  const { value, quoted } = parseScalar(inline);
  if (quoted) return { ...base, type: 'text', value };
  if (NULL.test(value)) return { ...base, type: 'text', empty: true };
  if (BOOLEAN.test(value)) return { ...base, type: 'checkbox', value: value.toLowerCase() };
  if (NUMBER.test(value)) return { ...base, type: 'number', value };
  if (DATE.test(value)) return { ...base, type: 'date', value };
  if (DATETIME.test(value)) return { ...base, type: 'datetime', value };
  return { ...base, type: 'text', value };
}

function parseScalar(text: string): { value: string; quoted: boolean } {
  const double = text.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
  if (double) {
    try {
      return { value: JSON.parse(`"${double[1]}"`), quoted: true };
    } catch {
      return { value: double[1].replace(/\\(["\\])/g, '$1'), quoted: true };
    }
  }
  const single = text.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (single) return { value: single[1].replace(/''/g, "'"), quoted: true };
  return { value: text.replace(/\s+#.*$/, '').trim(), quoted: false };
}

function unquoteKey(keyText: string): string {
  return parseScalar(keyText).value.trim();
}

/** Splits the inside of a `[a, "b, c"]` flow list on top-level commas. */
function splitFlowList(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote) {
      if (char === '\\' && quote === '"') {
        current += char + (inner[++i] ?? '');
        continue;
      }
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[' || char === '{') {
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

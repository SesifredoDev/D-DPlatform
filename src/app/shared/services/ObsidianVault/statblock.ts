/**
 * Statblocks: YAML in a ```statblock fenced block, in the layout the Fantasy Statblocks plugin for
 * Obsidian uses, so the same note renders there too:
 *
 *   ```statblock
 *   name: Goblin
 *   system: dnd5e
 *   image: "[[goblin.png]]"
 *   size: Small
 *   ac: 15
 *   hp: 7
 *   hit_dice: 2d6
 *   stats: [8, 14, 10, 10, 8, 8]
 *   actions:
 *     - name: Scimitar
 *       desc: "Melee Weapon Attack: +4 to hit…"
 *   ```
 *
 * Items (```item) and spells (```spell) work the same way, with their own layouts per game (see
 * statblock-systems.ts). "Statblock" below means any of the three kinds.
 *
 * `system` picks the layout (see statblock-systems.ts); without it a block is D&D 5e. `image` is the
 * token picture: a vault image (link or path) or a web URL. Keys the app doesn't know are kept.
 * Creature blocks in the app's older format, or plain text pasted from a book, are read too and
 * are rewritten as YAML when edited.
 *
 * Pure functions, no Angular.
 */
import { Document, isMap, parseDocument } from 'yaml';
import { LegacyStatsheet, normalizeKey, parseLegacyStatsheet } from './statblock-legacy';
import { BlockKind, DEFAULT_STATBLOCK_SYSTEM, StatblockSystem, getStatblockSystem, systemKeys } from './statblock-systems';

export type { BlockKind } from './statblock-systems';

export const STATBLOCK_LANGUAGE = 'statblock';
export const ITEM_LANGUAGE = 'item';
export const SPELL_LANGUAGE = 'spell';

/** Fence languages per kind; the first is the one the app writes. */
const LANGUAGES: Record<BlockKind, readonly string[]> = {
  creature: [
    STATBLOCK_LANGUAGE,
    'statsheet',
    '5e',
    '5e-statblock',
    '5e-statsheet',
    'dnd',
    'dnd-statblock',
    'dnd-statsheet',
  ],
  item: [ITEM_LANGUAGE, '5e-item', 'dnd-item'],
  spell: [SPELL_LANGUAGE, '5e-spell', 'dnd-spell'],
};

/** What a fenced block holds, by its language; null for ordinary code. */
export function blockKindOf(language: string | null | undefined): BlockKind | null {
  const wanted = (language ?? '').trim().toLowerCase();
  if (LANGUAGES.creature.includes(wanted)) return 'creature';
  if (LANGUAGES.item.includes(wanted)) return 'item';
  if (LANGUAGES.spell.includes(wanted)) return 'spell';
  return null;
}

/** The fence language the app writes for a kind. */
export function blockLanguage(kind: BlockKind): string {
  return LANGUAGES[kind][0];
}

/** "statblock" / "item" / "spell", for messages and tags. */
export function blockNoun(kind: BlockKind): string {
  return kind === 'creature' ? 'statblock' : kind;
}

/** Material icon for a kind of block (file list, card avatar). */
export function blockIcon(kind: BlockKind): string {
  return { creature: 'shield', item: 'diamond', spell: 'auto_fix_high' }[kind];
}

/** Spells are reference cards; only creatures and items can become map tokens. */
export function canAddToMap(kind: BlockKind): boolean {
  return kind !== 'spell';
}

export type StatblockData = Record<string, unknown>;

export interface StatblockEntry {
  name: string;
  desc: string;
}

export interface ParsedStatblock {
  kind: BlockKind;
  data: StatblockData;
  /** The YAML as read, kept so a save only rewrites the keys that changed. */
  doc: Document | null;
  /** Read from an older or plain-text format: saving writes it out fresh as YAML. */
  converted: boolean;
  /** Set when the YAML can't be read. Such a block is never rewritten from the form. */
  error: string | null;
}

/** True for creature and item blocks. */
export function isStatblockLanguage(language: string | null | undefined): boolean {
  return blockKindOf(language) !== null;
}

// ---- Reading ----

export function parseStatblock(source: string, kind: BlockKind = 'creature'): ParsedStatblock {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.trim()) return { kind, data: {}, doc: null, converted: false, error: null };

  const doc = parseDocument(text);
  if (!doc.errors.length && isMap(doc.contents)) {
    const data = (doc.toJS() ?? {}) as StatblockData;
    if (kind !== 'creature' || !looksLegacy(data)) return { kind, data, doc, converted: false, error: null };
  }

  // YAML-shaped text that just doesn't parse (e.g. a bad indent) is an error, not old-format text:
  // reading it as old-format would drop most of it on the next save. Only creatures have an old format.
  if (kind !== 'creature' || (doc.errors.length && /^\s*(stats|traits|actions|desc|system)\s*:|^\s*-\s+name\s*:/m.test(text))) {
    const message = doc.errors[0]?.message.split('\n')[0] ?? 'Expected "key: value" lines.';
    return { kind, data: {}, doc: null, converted: false, error: message };
  }

  const legacy = parseLegacyStatsheet(text);
  if (!legacy) return { kind, data: {}, doc: null, converted: false, error: 'This statblock is empty.' };
  return { kind, data: fromLegacy(legacy), doc: null, converted: true, error: null };
}

/**
 * True when pasted plain text looks like a creature statblock copied from a book, PDF or website:
 * a few lines with Armor Class and Hit Points, plus ability scores, a challenge rating or a speed.
 */
export function looksLikePastedStatblock(text: string): boolean {
  if (!text || text.length > 20000 || /^\s*(```|~~~)/.test(text)) return false;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 4) return false;
  const hasArmor = /^\s*(armor class|AC)\b/im.test(text);
  const hasHealth = /^\s*(hit points|HP)\b/im.test(text);
  const hasMore = /\bSTR\b[\s\S]{0,40}\bDEX\b/i.test(text) || /^\s*(challenge|CR)\b/im.test(text) || /^\s*speed\b/im.test(text);
  return hasArmor && hasHealth && hasMore;
}

/** A pasted statblock as ```statblock YAML, or null when it can't be read as one. */
export function pastedStatblockSource(text: string): string | null {
  if (!looksLikePastedStatblock(text)) return null;
  const parsed = parseStatblock(text, 'creature');
  if (parsed.error || !parsed.converted) return null;
  return serializeStatblock(parsed, parsed.data);
}

/** Keys only the old format used. */
function looksLegacy(data: StatblockData): boolean {
  return ['meta', 'armor_class', 'hit_points', 'str', 'dex', 'con', 'int', 'wis', 'cha', 'saving_throws']
    .some(key => key in data);
}

const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];

function fromLegacy(sheet: LegacyStatsheet): StatblockData {
  const data: StatblockData = { name: sheet.name, system: 'dnd5e' };

  // "Small humanoid (goblinoid), neutral evil"
  const [kind, ...alignment] = sheet.meta.split(',');
  const words = kind.trim().split(/\s+/).filter(Boolean);
  if (words.length && SIZES.includes(words[0].toLowerCase())) data['size'] = words.shift();
  const typeText = words.join(' ');
  const subtype = typeText.match(/\(([^)]*)\)/);
  if (typeText) data['type'] = typeText.replace(/\s*\([^)]*\)/, '').trim();
  if (subtype) data['subtype'] = subtype[1].trim();
  if (alignment.length) data['alignment'] = alignment.join(',').trim();

  if (sheet.armorClass) data['ac'] = scalar(sheet.armorClass);
  const hp = sheet.hitPoints.match(/^\s*(\d+)\s*(?:\(([^)]*)\))?\s*$/);
  if (hp) {
    data['hp'] = Number(hp[1]);
    if (hp[2]) data['hit_dice'] = hp[2].trim();
  } else if (sheet.hitPoints) {
    data['hp'] = sheet.hitPoints;
  }
  if (sheet.speed) data['speed'] = sheet.speed;

  const scores = (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map(key => sheet.abilities[key]);
  if (scores.some(Boolean)) data['stats'] = scores.map(score => scalar(score || '10'));

  const attributeKeys: Record<string, string> = {
    saving_throws: 'saves',
    skills: 'skillsaves',
    challenge: 'cr',
  };
  for (const attribute of sheet.attributes) {
    const key = normalizeKey(attribute.name);
    data[attributeKeys[key] ?? key] = attribute.text;
  }

  for (const section of sheet.sections) {
    const key = normalizeKey(section.title) === 'features' ? 'traits' : normalizeKey(section.title);
    data[key] = section.entries.map(entry => ({ name: entry.name, desc: entry.text }));
  }
  return data;
}

// ---- Values ----

/** A value as display text: lists are joined, `{dexterity: 5}` maps become "Dexterity +5". */
export function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        const text = typeof inner === 'number' && inner >= 0 ? `+${inner}` : textValue(inner);
        return `${label} ${text}`.trim();
      })
      .join(', ');
  }
  return '';
}

/** Named entries (traits, actions…) from `[{name, desc}]`, or from "Name. Text" strings. */
export function entriesValue(value: unknown): StatblockEntry[] {
  if (value === null || value === undefined || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return { name: textValue(record['name']), desc: textValue(record['desc'] ?? record['description'] ?? record['text']) };
    }
    const text = textValue(item);
    const named = text.match(/^([^.:]{1,60})[.:]\s+([\s\S]+)$/);
    return named ? { name: named[1].trim(), desc: named[2].trim() } : { name: '', desc: text };
  });
}

/** A row of scores as text, padded to `count`. */
export function scoresValue(value: unknown, count: number): string[] {
  const items = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, i) => textValue(items[i]));
}

/** D&D ability modifier for a score, e.g. 14 → 2. */
export function dndModifier(score: unknown): number | null {
  const value = leadingNumber(textValue(score));
  return value === null ? null : Math.floor((value - 10) / 2);
}

export function formatSigned(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

/** The first number in a text, sign included ("45 (6d10+12)" → 45, "+5; darkvision" → 5). */
export function leadingNumber(text: string): number | null {
  const match = text.trim().match(/^[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Text typed into a field, as the value to store: whole numbers become numbers. */
export function scalar(text: string): string | number {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) && trimmed.length < 12 ? Number(trimmed) : trimmed;
}

/** The line under the name, e.g. "Small humanoid (goblinoid), neutral evil". */
export function formatSubtitle(system: StatblockSystem, data: StatblockData): string {
  const parts = system.subtitle.split(/(\s*[,·]\s*)/);
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i];
    const keys = Array.from(segment.matchAll(/\{(\w+)\}/g), match => match[1]);
    if (keys.length && keys.every(key => !textValue(data[key]).trim())) continue;

    const text = segment
      .replace(/\{(\w+)\}/g, (_, key: string) => textValue(data[key]).trim())
      .replace(/\(\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (out) out += parts[i - 1];
    out += text;
  }
  return out;
}

/** Keys with a value that the system doesn't lay out (shown as extra fields / sections). */
export function extraKeys(system: StatblockSystem, data: StatblockData): { fields: string[]; entries: string[] } {
  const shown = systemKeys(system);
  const hidden = new Set(['name', 'system', 'image', 'token', 'layout', 'statblock', 'source', 'columns', 'forceColumns']);
  const fields: string[] = [];
  const entries: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (shown.has(key) || hidden.has(key) || value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length && value.every(item => item && typeof item === 'object' && 'name' in item)) {
      entries.push(key);
    } else if (!Array.isArray(value) || value.length) {
      fields.push(key);
    }
  }
  return { fields, entries };
}

export function keyLabel(key: string): string {
  const text = key.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---- Writing ----

/**
 * The block's new text. Read YAML is edited in place (only changed keys are rewritten, so comments,
 * key order and unknown keys survive); converted or new blocks are written out fresh.
 */
export function serializeStatblock(parsed: ParsedStatblock, data: StatblockData): string {
  const clean = cleanData(data);

  if (parsed.doc && !parsed.converted && isMap(parsed.doc.contents)) {
    const doc = parsed.doc.clone();
    for (const key of Object.keys(parsed.data)) {
      if (!(key in clean)) doc.delete(key);
    }
    for (const [key, value] of Object.entries(clean)) {
      if (!sameValue(parsed.data[key], value)) doc.set(key, createNode(doc, value));
    }
    return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  }

  const system = getStatblockSystem(clean['system'], parsed.kind);
  const order = ['name', 'system', 'image', ...systemKeys(system)];
  const keys = [
    ...order.filter(key => key in clean),
    ...Object.keys(clean).filter(key => !order.includes(key)),
  ];
  const doc = new Document({});
  for (const key of keys) doc.set(key, createNode(doc, clean[key]));
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
}

function cleanData(data: StatblockData): StatblockData {
  const clean: StatblockData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue;
    clean[key] = value;
  }
  return clean;
}

/** Lists of plain values (ability scores) are written inline: `stats: [8, 14, 10, 10, 8, 8]`. */
function createNode(doc: Document, value: unknown) {
  const node = doc.createNode(value);
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) {
    (node as { flow?: boolean }).flow = true;
  }
  return node;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- New statblocks ----

export function newStatblockData(name: string, system: StatblockSystem = DEFAULT_STATBLOCK_SYSTEM): StatblockData {
  const fallback = { creature: 'New creature', item: 'New item', spell: 'New spell' }[system.kind];
  return { name: name.trim() || fallback, system: system.id, ...structuredClone(system.template) };
}

export function newStatblockSource(name: string, system: StatblockSystem = DEFAULT_STATBLOCK_SYSTEM): string {
  return serializeStatblock({ kind: system.kind, data: {}, doc: null, converted: true, error: null }, newStatblockData(name, system));
}

/** A fenced statblock (or item) block, ready to put into a note. */
export function statblockFence(source: string, kind: BlockKind = 'creature'): string {
  return '```' + blockLanguage(kind) + '\n' + source.trimEnd() + '\n```';
}

/** A whole statblock, item or spell note: tagged #statblock / #item / #spell, the block, then room for notes. */
export function newStatblockNote(name: string, system: StatblockSystem = DEFAULT_STATBLOCK_SYSTEM): string {
  return [
    '---',
    'tags:',
    `  - ${blockNoun(system.kind)}`,
    '---',
    '',
    statblockFence(newStatblockSource(name, system), system.kind),
    '',
    '## Notes',
    '',
    '',
  ].join('\n');
}

// ---- Finding statblocks in notes ----

export interface StatblockBlock {
  kind: BlockKind;
  language: string;
  source: string;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w-]+)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

/** Every statblock and item block in a note, in order. */
export function findStatblocks(markdown: string): StatblockBlock[] {
  const blocks: StatblockBlock[] = [];
  for (const match of markdown.replace(/\r\n/g, '\n').matchAll(FENCE)) {
    const kind = blockKindOf(match[2]);
    if (kind) blocks.push({ kind, language: match[2], source: match[3].replace(/\n$/, '') });
  }
  return blocks;
}

export function hasStatblock(markdown: string): boolean {
  return /^(`{3,}|~{3,})[ \t]*([\w-]+)/m.test(markdown) && findStatblocks(markdown).length > 0;
}

// ---- Token picture and VTT stats ----

/** The token picture as written (`[[goblin.png]]` → `goblin.png`), or '' for none. */
export function statblockImage(data: StatblockData): string {
  return textValue(data['image'] ?? data['token'])
    .trim()
    .replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1')
    .replace(/^<(.+)>$/, '$1')
    .trim();
}

export interface StatblockTokenStats {
  name: string;
  maxHealth: number | null;
  /** Token size in grid squares (Medium = 1, Large = 2…). */
  size: number;
  initiativeBonus: number | null;
}

const TOKEN_SIZES: Record<string, number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
};

export function tokenStats(data: StatblockData, kind: BlockKind = 'creature'): StatblockTokenStats {
  const { vtt } = getStatblockSystem(data['system'], kind);
  const sizeWord = vtt.size ? textValue(data[vtt.size]).trim().split(/\s+/)[0]?.toLowerCase() ?? '' : '';

  let initiativeBonus: number | null = null;
  if (vtt.initiative) {
    const raw = data[vtt.initiative.key];
    const value = vtt.initiative.index !== undefined ? (Array.isArray(raw) ? raw[vtt.initiative.index] : undefined) : raw;
    initiativeBonus = vtt.initiative.modifier === 'dnd' ? dndModifier(value) : leadingNumber(textValue(value));
  }

  const hp = vtt.hp ? leadingNumber(textValue(data[vtt.hp])) : null;
  return {
    name: textValue(data['name']).trim() || { creature: 'Creature', item: 'Item', spell: 'Spell' }[kind],
    maxHealth: hp !== null && hp > 0 ? Math.round(hp) : null,
    size: TOKEN_SIZES[sizeWord] ?? 1,
    initiativeBonus,
  };
}

/** d20 + bonus. */
export function rollInitiative(bonus: number | null, random = Math.random): number {
  return 1 + Math.floor(random() * 20) + (bonus ?? 0);
}

/** "Goblin", or "Goblin 1", "Goblin 2"… when adding several. */
export function tokenNames(name: string, count: number): string[] {
  return count <= 1 ? [name] : Array.from({ length: count }, (_, i) => `${name} ${i + 1}`);
}


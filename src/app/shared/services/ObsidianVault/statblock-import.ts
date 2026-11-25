/**
 * Turns search results (Open5e v2 entries, homebrew pack items) into statblock, item or spell block
 * data (see statblock.ts), so they can be saved as notes or inserted into one.
 *
 * Open5e v2 entries are structured, so they map field by field. Homebrew items are free-form
 * (`{name, description, properties}`), so their kind is guessed from their property keys.
 *
 * Every import carries a `source` key (`open5e/srd_goblin`), kept in the block, so a vault that
 * already has the entry can be found instead of saving it twice, and an attribution line for the
 * note (SRD/OGL content must credit its source).
 *
 * Pure functions, no Angular.
 */
import { BlockKind, StatblockData, serializeStatblock, statblockFence } from './statblock';

export interface ImportedBlock {
  kind: BlockKind;
  name: string;
  /** Block data, including `system` and `source`. */
  data: StatblockData;
  /** Identifies where it came from, e.g. `open5e/srd_goblin`. Also stored as the block's `source`. */
  sourceKey: string;
  /** Markdown credit line for the note, e.g. "*Source: System Reference Document 5.1, via Open5e.*" */
  attribution: string;
  /** Extra Markdown for the note below the block (e.g. a homebrew creature's description). */
  body?: string;
}

/** The parts of an Open5e v2 search result the importer needs. */
export interface Open5eResultRef {
  object_model?: string;
  object_pk: string;
  route?: string;
}

type Json = Record<string, unknown>;

// ---- Open5e ----

/** Which block an Open5e result becomes, or null for rules, conditions, classes… */
export function open5eBlockKind(result: Open5eResultRef): BlockKind | null {
  const route = (result.route ?? '').toLowerCase();
  const model = (result.object_model ?? '').toLowerCase();
  if (route.includes('/creatures') || model === 'creature') return 'creature';
  if (route.includes('/magicitems') || route.includes('/items') || model === 'item' || model === 'magicitem') return 'item';
  if (route.includes('/spells') || model === 'spell') return 'spell';
  return null;
}

export function importOpen5e(result: Open5eResultRef, detail: Json): ImportedBlock | null {
  const kind = open5eBlockKind(result);
  if (!kind) return null;

  const key = str(detail['key']) || result.object_pk;
  const data =
    kind === 'creature' ? open5eCreature(detail) : kind === 'item' ? open5eItem(detail) : open5eSpell(detail);
  const name = str(detail['name']) || result.object_pk;
  return {
    kind,
    name,
    data: { name, system: 'dnd5e', ...data, source: `open5e/${key}` },
    sourceKey: `open5e/${key}`,
    attribution: open5eAttribution(detail),
  };
}

function open5eAttribution(detail: Json): string {
  const document = obj(detail['document']);
  const name = str(document['name']);
  const display = str(document['display_name']);
  const publisher = str(obj(document['publisher'])['name']);
  const title = [name, display && display !== name ? `(${display})` : ''].filter(Boolean).join(' ');
  const credit = [title, publisher ? `by ${publisher}` : ''].filter(Boolean).join(' ');
  return `*Source: ${credit || 'Open5e'}, via [Open5e](https://open5e.com).*`;
}

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

function open5eCreature(detail: Json): StatblockData {
  const data: StatblockData = {};
  set(data, 'size', str(obj(detail['size'])['name']));
  set(data, 'type', str(obj(detail['type'])['name']).toLowerCase());
  set(data, 'subtype', str(detail['subcategory']));
  set(data, 'alignment', str(detail['alignment']));

  const ac = num(detail['armor_class']);
  const acDetail = str(detail['armor_detail']);
  if (ac !== null) data['ac'] = acDetail ? `${ac} (${acDetail})` : ac;
  set(data, 'hp', num(detail['hit_points']));
  set(data, 'hit_dice', str(detail['hit_dice']));
  set(data, 'speed', speedText(obj(detail['speed'])));

  const scores = obj(detail['ability_scores']);
  if (ABILITIES.some(ability => num(scores[ability]) !== null)) {
    data['stats'] = ABILITIES.map(ability => num(scores[ability]) ?? 10);
  }

  set(data, 'saves', bonusList(obj(detail['saving_throws']), key => abbreviate(key)));
  set(data, 'skillsaves', bonusList(obj(detail['skill_bonuses']), key => titleCase(key.replace(/_/g, ' '))));

  const defenses = obj(detail['resistances_and_immunities']);
  set(data, 'damage_vulnerabilities', str(defenses['damage_vulnerabilities_display']));
  set(data, 'damage_resistances', str(defenses['damage_resistances_display']));
  set(data, 'damage_immunities', str(defenses['damage_immunities_display']));
  set(data, 'condition_immunities', str(defenses['condition_immunities_display']));

  set(data, 'senses', sensesText(detail));
  set(data, 'languages', str(obj(detail['languages'])['as_string']) || '—');
  set(data, 'cr', challengeText(detail['challenge_rating']));

  set(data, 'traits', namedEntries(detail['traits']));
  const groups: Record<string, StatblockData[]> = {};
  const actions = arr(detail['actions'])
    .map(obj)
    .sort((a, b) => (num(a['order_in_statblock']) ?? 0) - (num(b['order_in_statblock']) ?? 0));
  for (const action of actions) {
    const group = ACTION_GROUPS[str(action['action_type']).toUpperCase()] ?? 'actions';
    const name = str(action['name']) + actionSuffix(action, group);
    (groups[group] ??= []).push({ name, desc: str(action['desc']) });
  }
  for (const group of ['actions', 'bonus_actions', 'reactions', 'legendary_actions', 'lair_actions']) {
    if (groups[group]?.length) data[group] = groups[group];
  }

  const illustration = obj(detail['illustration']);
  set(data, 'image', str(illustration['file_url']) || str(illustration['url']));
  return data;
}

const ACTION_GROUPS: Record<string, string> = {
  ACTION: 'actions',
  BONUS_ACTION: 'bonus_actions',
  REACTION: 'reactions',
  LEGENDARY_ACTION: 'legendary_actions',
  LAIR_ACTION: 'lair_actions',
};

/** "(Recharge 5–6)", "(2/Day)", "(Costs 2 Actions)". */
function actionSuffix(action: Json, group: string): string {
  const parts: string[] = [];
  const limits = obj(action['usage_limits']);
  const type = str(limits['type']).toUpperCase();
  const param = num(limits['param']);
  if (type === 'RECHARGE_ON_ROLL' && param !== null) parts.push(param >= 6 ? 'Recharge 6' : `Recharge ${param}–6`);
  else if (type === 'RECHARGE_AFTER_REST') parts.push('Recharges after a Short or Long Rest');
  else if (type === 'PER_DAY' && param !== null) parts.push(`${param}/Day`);

  const cost = num(action['legendary_action_cost']);
  if (group === 'legendary_actions' && cost !== null && cost > 1) parts.push(`Costs ${cost} Actions`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function speedText(speed: Json): string {
  const unit = str(speed['unit']) === 'feet' || !str(speed['unit']) ? 'ft.' : str(speed['unit']);
  const parts: string[] = [];
  const walk = num(speed['walk']);
  if (walk !== null) parts.push(`${walk} ${unit}`);
  // The books' order; any other mode Open5e adds goes last.
  const order = ['burrow', 'climb', 'fly', 'swim'];
  const modes = Object.keys(speed)
    .filter(mode => !['walk', 'unit', 'hover'].includes(mode))
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  for (const mode of modes) {
    const distance = num(speed[mode]);
    if (!distance) continue;
    const hover = mode === 'fly' && speed['hover'] === true ? ' (hover)' : '';
    parts.push(`${mode} ${distance} ${unit}${hover}`);
  }
  return parts.join(', ');
}

function sensesText(detail: Json): string {
  const parts: string[] = [];
  for (const sense of ['blindsight', 'darkvision', 'tremorsense', 'truesight']) {
    const range = num(detail[`${sense}_range`]);
    if (range) parts.push(`${sense} ${range} ft.`);
  }
  const passive = num(detail['passive_perception']);
  if (passive !== null) parts.push(`passive Perception ${passive}`);
  return parts.join(', ');
}

function challengeText(value: unknown): string | number | null {
  const cr = num(value);
  if (cr === null) return null;
  const fractions: Record<string, string> = { '0.125': '1/8', '0.25': '1/4', '0.5': '1/2' };
  return fractions[String(cr)] ?? (Number.isInteger(cr) ? cr : String(cr));
}

function open5eItem(detail: Json): StatblockData {
  const data: StatblockData = {};
  const name = str(detail['name']);
  const category = str(obj(detail['category'])['name']);
  const weapon = obj(detail['weapon']);
  const armor = obj(detail['armor']);
  const base = str(weapon['name']) || str(armor['name']);
  set(data, 'type', base && category && !name.toLowerCase().startsWith(base.toLowerCase()) && base.toLowerCase() !== name.toLowerCase()
    ? `${category} (${base.toLowerCase()})`
    : category);
  set(data, 'rarity', str(obj(detail['rarity'])['name']).toLowerCase());
  if (detail['requires_attunement'] === true) {
    const how = str(detail['attunement_detail']);
    data['attunement'] = how ? `requires attunement ${how}` : 'requires attunement';
  }
  set(data, 'cost', costText(detail['cost']));
  set(data, 'weight', weightText(detail['weight'], str(detail['weight_unit'])));

  const dice = str(weapon['damage_dice']);
  const damageType = str(obj(weapon['damage_type'])['name']).toLowerCase();
  set(data, 'damage', [dice, damageType].filter(Boolean).join(' '));
  const properties = arr(weapon['properties']).map(obj).map(entry => {
    const property = str(obj(entry['property'])['name']);
    const extra = str(entry['detail']);
    return extra ? `${property} (${extra})` : property;
  }).filter(Boolean);

  const acDisplay = str(armor['ac_display']) || (num(armor['ac_base']) !== null ? String(num(armor['ac_base'])) : '');
  if (acDisplay) {
    const cap = num(armor['ac_cap_dexmod']);
    const dex = armor['ac_add_dexmod'] === true && !/dex/i.test(acDisplay)
      ? ` + Dex modifier${cap !== null ? ` (max ${cap})` : ''}`
      : '';
    data['ac'] = `${acDisplay}${dex}`;
    const strength = num(armor['strength_score_required']);
    if (strength) properties.push(`Strength ${strength}`);
    if (armor['grants_stealth_disadvantage'] === true) properties.push('Stealth disadvantage');
  }
  set(data, 'properties', properties.join(', '));
  set(data, 'description', str(detail['desc']));
  return data;
}

function costText(value: unknown): string {
  const cost = num(value);
  if (!cost) return '';
  if (cost >= 1) return `${trimNumber(cost)} gp`;
  const silver = cost * 10;
  if (Math.abs(silver - Math.round(silver)) < 1e-9) return `${Math.round(silver)} sp`;
  return `${Math.round(cost * 100)} cp`;
}

function weightText(value: unknown, unit: string): string {
  const weight = num(value);
  if (!weight) return '';
  const label = !unit || unit === 'lb' ? 'lb.' : unit;
  return `${trimNumber(weight)} ${label}`;
}

function open5eSpell(detail: Json): StatblockData {
  const data: StatblockData = {};
  set(data, 'level', num(detail['level']));
  set(data, 'school', str(obj(detail['school'])['name']).toLowerCase());
  if (detail['ritual'] === true) data['ritual'] = 'ritual';

  let castingTime = str(detail['casting_time']).replace(/_/g, ' ');
  if (/^(action|bonus action|reaction)$/i.test(castingTime)) castingTime = `1 ${castingTime}`;
  const trigger = str(detail['reaction_condition']);
  set(data, 'casting_time', trigger ? `${castingTime}, ${trigger}` : castingTime);
  set(data, 'range', str(detail['range_text']));

  const components = [detail['verbal'] === true ? 'V' : '', detail['somatic'] === true ? 'S' : ''];
  if (detail['material'] === true) {
    const material = str(detail['material_specified']).replace(/\.$/, '');
    components.push(material ? `M (${lowerFirst(material)})` : 'M');
  }
  set(data, 'components', components.filter(Boolean).join(', '));

  const duration = str(detail['duration']);
  const concentration = detail['concentration'] === true && !/concentration/i.test(duration);
  set(data, 'duration', upperFirst(concentration ? `concentration, ${duration}` : duration));
  set(data, 'classes', arr(detail['classes']).map(entry => str(obj(entry)['name'])).filter(Boolean).join(', '));
  set(data, 'description', str(detail['desc']));
  set(data, 'higher_levels', str(detail['higher_level']));
  return data;
}

// ---- Homebrew ----

export interface HomebrewItemRef {
  id: string;
  name: string;
  description: string;
  properties: Record<string, string>;
  packName?: string;
}

const CREATURE_KEYS = ['ac', 'armor_class', 'hp', 'hit_points', 'cr', 'challenge', 'challenge_rating', 'str', 'dex', 'con', 'int', 'wis', 'cha'];
const ITEM_KEYS = ['rarity', 'cost', 'price', 'weight', 'attunement', 'requires_attunement', 'damage'];
const SPELL_KEYS = ['school', 'casting_time', 'components', 'spell_level'];
const CREATURE_TYPES = ['monster', 'creature', 'npc', 'beast', 'statblock'];
const ITEM_TYPES = ['item', 'magic item', 'magic-item', 'weapon', 'armor', 'armour', 'gear', 'equipment', 'potion', 'wondrous item'];

/** Which block a homebrew item becomes, from its `type` or its property keys; null for plain text. */
export function homebrewBlockKind(item: HomebrewItemRef): BlockKind | null {
  const props = normalizeProps(item.properties);
  const type = (props['type'] ?? '').toLowerCase();
  if (type === 'spell' || type === 'cantrip') return 'spell';
  if (CREATURE_TYPES.includes(type)) return 'creature';
  if (ITEM_TYPES.includes(type)) return 'item';
  const keys = Object.keys(props);
  if (keys.some(key => SPELL_KEYS.includes(key))) return 'spell';
  if (keys.filter(key => CREATURE_KEYS.includes(key)).length >= 2) return 'creature';
  if (keys.some(key => ITEM_KEYS.includes(key))) return 'item';
  return null;
}

export function importHomebrew(item: HomebrewItemRef): ImportedBlock | null {
  const kind = homebrewBlockKind(item);
  if (!kind) return null;

  const props = normalizeProps(item.properties);
  const aliases: Record<string, string> = {
    armor_class: 'ac',
    hit_points: 'hp',
    challenge: 'cr',
    challenge_rating: 'cr',
    saving_throws: 'saves',
    skills: 'skillsaves',
    price: 'cost',
    spell_level: 'level',
  };
  const data: StatblockData = {};
  const scores: (number | null)[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key => num(props[key]));
  for (const [key, value] of Object.entries(props)) {
    if (!value.trim()) continue;
    if (kind === 'creature' && ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(key)) continue;
    // A creature's "type: monster" is the homebrew category, not its creature type.
    if (key === 'type' && kind === 'creature' && CREATURE_TYPES.includes(value.toLowerCase())) continue;
    if (key === 'type' && kind === 'spell' && ['spell', 'cantrip'].includes(value.toLowerCase())) continue;
    const target = aliases[key] ?? key;
    data[target] = /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  }
  if (kind === 'creature' && scores.some(score => score !== null)) data['stats'] = scores.map(score => score ?? 10);

  const description = (item.description ?? '').trim();
  let body: string | undefined;
  if (description) {
    if (kind === 'creature') body = description;
    else data['description'] = description;
  }

  const pack = item.packName?.trim();
  return {
    kind,
    name: item.name,
    data: { name: item.name, system: 'dnd5e', ...data, source: `homebrew/${item.id}` },
    sourceKey: `homebrew/${item.id}`,
    attribution: `*Source: ${pack ? `${pack} (homebrew pack)` : 'homebrew pack'}.*`,
    body,
  };
}

function normalizeProps(properties: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    out[key.trim().toLowerCase().replace(/[\s-]+/g, '_')] = String(value ?? '');
  }
  return out;
}

// ---- Notes ----

/** The imported block as a fenced block (for inserting into a note). */
export function importedFence(block: ImportedBlock): string {
  const source = serializeStatblock({ kind: block.kind, data: {}, doc: null, converted: true, error: null }, block.data);
  return statblockFence(source, block.kind);
}

/** A whole note for an imported block: tag, block, credit line, then any extra text. */
export function importedNote(block: ImportedBlock): string {
  const tag = block.kind === 'creature' ? 'statblock' : block.kind;
  return [
    '---',
    'tags:',
    `  - ${tag}`,
    '---',
    '',
    importedFence(block),
    '',
    block.attribution,
    '',
    ...(block.body ? [block.body.trim(), ''] : []),
    '## Notes',
    '',
    '',
  ].join('\n');
}

// ---- Helpers ----

function set(data: StatblockData, key: string, value: unknown): void {
  if (value === null || value === undefined || value === '') return;
  if (Array.isArray(value) && !value.length) return;
  data[key] = value;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function namedEntries(value: unknown): StatblockData[] {
  return arr(value).map(obj).map(entry => ({ name: str(entry['name']), desc: str(entry['desc']) })).filter(entry => entry.name || entry.desc);
}

function bonusList(values: Json, label: (key: string) => string): string {
  return Object.entries(values)
    .filter(([, value]) => num(value) !== null)
    .map(([key, value]) => `${label(key)} ${num(value)! >= 0 ? '+' : ''}${num(value)}`)
    .join(', ');
}

function abbreviate(ability: string): string {
  return titleCase(ability.slice(0, 3));
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, char => char.toUpperCase());
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

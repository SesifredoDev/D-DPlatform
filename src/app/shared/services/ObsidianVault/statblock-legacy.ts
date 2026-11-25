/**
 * Reads statblocks written before statblocks became YAML: the app's old `name:` / `armor_class:` /
 * `actions: - Name. Text` blocks, and plain text pasted from a book ("Armor Class 15", "STR DEX …").
 * They're converted to the YAML layout (see statblock.ts) the first time they're edited.
 */

type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export interface LegacyStatsheetEntry {
  name: string;
  text: string;
}

export interface LegacyStatsheet {
  name: string;
  meta: string;
  armorClass: string;
  hitPoints: string;
  speed: string;
  abilities: Record<AbilityKey, string>;
  attributes: LegacyStatsheetEntry[];
  sections: { title: string; entries: LegacyStatsheetEntry[] }[];
}

type MetaParts = { size: string; type: string; alignment: string };

const ABILITY_KEYS: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * "Nimble Escape. The goblin…" / "- ***Bite.*** …" / "Detect.The dragon…" (websites often drop the
 * space): a line that starts a named entry. Names are short and start with a capital.
 */
const NAMED_ENTRY = /^(?:[-*]\s+)?\**[A-Z][^.:\n]{0,58}[.:]\**(?:\s|(?=[A-Z]))/;

const SECTION_TITLES: Record<string, string> = {
  traits: 'Traits',
  features: 'Traits',
  actions: 'Actions',
  bonus_actions: 'Bonus Actions',
  reactions: 'Reactions',
  legendary_actions: 'Legendary Actions',
  lair_actions: 'Lair Actions',
};

export function parseLegacyStatsheet(content: string): LegacyStatsheet | null {
  const cleanContent = content
    .replace(/^\s*```[\w-]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  if (!cleanContent) return null;

  const sheet: LegacyStatsheet = {
    name: '',
    meta: '',
    armorClass: '',
    hitPoints: '',
    speed: '',
    abilities: { str: '', dex: '', con: '', int: '', wis: '', cha: '' },
    attributes: [],
    sections: [],
  };
  const metaParts: MetaParts = { size: '', type: '', alignment: '' };

  let currentSection: LegacyStatsheet['sections'][number] | null = null;
  let lastEntry: LegacyStatsheetEntry | null = null;
  let expectsAbilityScoreRow = false;
  /** Pasted from websites, scores often come one per line: "STR" then "8 (-1)". */
  let pendingAbility: AbilityKey | null = null;

  for (const rawLine of cleanContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^-{3,}$/.test(line)) {
      lastEntry = null;
      expectsAbilityScoreRow = false;
      continue;
    }

    if (/^str\s+dex\s+con\s+int\s+wis\s+cha$/i.test(line.replace(/\s+/g, ' '))) {
      expectsAbilityScoreRow = true;
      lastEntry = null;
      continue;
    }

    if (expectsAbilityScoreRow && parseAbilityScoreRow(sheet, line)) {
      expectsAbilityScoreRow = false;
      lastEntry = null;
      continue;
    }
    expectsAbilityScoreRow = false;

    const lonelyAbility = line.match(/^(str|dex|con|int|wis|cha)$/i);
    if (lonelyAbility) {
      pendingAbility = lonelyAbility[1].toLowerCase() as AbilityKey;
      lastEntry = null;
      continue;
    }
    if (pendingAbility) {
      const score = line.match(/^(\d{1,2})\b/);
      const ability = pendingAbility;
      pendingAbility = null;
      if (score) {
        sheet.abilities[ability] = score[1];
        continue;
      }
    }

    const heading = normalizeKey(line.replace(/^#+\s*/, '').replace(/:$/, ''));
    if (SECTION_TITLES[heading]) {
      currentSection = ensureSection(sheet, SECTION_TITLES[heading]);
      lastEntry = null;
      continue;
    }

    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/);
    if (keyValue) {
      const key = normalizeKey(keyValue[1]);
      const value = keyValue[2].trim();

      if (assignValue(sheet, metaParts, key, value)) {
        lastEntry = null;
        continue;
      }

      if (SECTION_TITLES[key]) {
        currentSection = ensureSection(sheet, SECTION_TITLES[key]);
        lastEntry = value ? parseEntry(value) : null;
        if (lastEntry) currentSection.entries.push(lastEntry);
        continue;
      }

      if (!value && line.endsWith(':')) {
        currentSection = ensureSection(sheet, toDisplayTitle(keyValue[1]));
        lastEntry = null;
        continue;
      }

      if (currentSection) {
        lastEntry = { name: keyValue[1].trim(), text: value };
        currentSection.entries.push(lastEntry);
        continue;
      }

      if (value) {
        addAttribute(sheet, toDisplayTitle(keyValue[1]), value);
        lastEntry = null;
        continue;
      }
    }

    if (parseAbilityLine(sheet, line) || parseBareStatLine(sheet, metaParts, line)) {
      lastEntry = null;
      continue;
    }

    if (currentSection) {
      // Text copied from a PDF wraps mid-sentence: a line that doesn't start a new named entry, or
      // follows an entry that hasn't finished its sentence, carries on the previous one. (Websites
      // indent every entry, so indentation alone says nothing.)
      const continues = !!lastEntry && !/^[-*]\s/.test(line) && (
        !NAMED_ENTRY.test(line) ||
        !/[.!?)"”]$/.test(lastEntry.text.trim())
      );
      if (continues && lastEntry) {
        lastEntry.text = `${lastEntry.text} ${line}`.trim();
      } else {
        lastEntry = parseEntry(line);
        currentSection.entries.push(lastEntry);
      }
      continue;
    }

    // Traits come straight after the stats, with no heading of their own.
    if (sheet.name && sheet.meta && NAMED_ENTRY.test(line)) {
      currentSection = ensureSection(sheet, 'Traits');
      lastEntry = parseEntry(line);
      currentSection.entries.push(lastEntry);
      continue;
    }

    if (!sheet.name) {
      sheet.name = line.replace(/^#+\s*/, '');
    } else if (!sheet.meta) {
      sheet.meta = line.replace(/^\*+|\*+$/g, '');
    }
  }

  const kind = [metaParts.size, metaParts.type].filter(Boolean).join(' ');
  sheet.meta = sheet.meta || [kind, metaParts.alignment].filter(Boolean).join(', ');
  sheet.name = sheet.name || 'Unnamed Creature';
  return sheet;
}

function assignValue(sheet: LegacyStatsheet, metaParts: MetaParts, key: string, value: string): boolean {
  const attributes: Record<string, string> = {
    saving_throws: 'Saving Throws',
    skills: 'Skills',
    damage_vulnerabilities: 'Damage Vulnerabilities',
    damage_resistances: 'Damage Resistances',
    damage_immunities: 'Damage Immunities',
    condition_immunities: 'Condition Immunities',
    senses: 'Senses',
    languages: 'Languages',
    challenge: 'Challenge',
    cr: 'Challenge',
    proficiency_bonus: 'Proficiency Bonus',
    pb: 'Proficiency Bonus',
  };

  if (key === 'name') sheet.name = value;
  else if (key === 'meta' || key === 'description') sheet.meta = value;
  else if (key === 'size') metaParts.size = value;
  else if (key === 'type') metaParts.type = value;
  else if (key === 'alignment') metaParts.alignment = value;
  else if (key === 'armor_class' || key === 'ac') sheet.armorClass = value;
  else if (key === 'hit_points' || key === 'hp') sheet.hitPoints = value;
  else if (key === 'speed') sheet.speed = value;
  else if (ABILITY_KEYS.includes(key as AbilityKey)) sheet.abilities[key as AbilityKey] = value;
  else if (attributes[key]) addAttribute(sheet, attributes[key], value);
  else return false;
  return true;
}

function addAttribute(sheet: LegacyStatsheet, name: string, text: string): void {
  if (text) sheet.attributes.push({ name, text });
}

function parseAbilityLine(sheet: LegacyStatsheet, line: string): boolean {
  const matches = Array.from(line.matchAll(/\b(str|dex|con|int|wis|cha)\b\s*:?\s*(\d{1,2})/gi));
  if (matches.length < 2) return false;
  matches.forEach(match => (sheet.abilities[match[1].toLowerCase() as AbilityKey] = match[2]));
  return true;
}

function parseAbilityScoreRow(sheet: LegacyStatsheet, line: string): boolean {
  const matches = Array.from(line.matchAll(/\b(\d{1,2})\s*(?:\([+-]?\d+\))?/g));
  if (matches.length < ABILITY_KEYS.length) return false;
  ABILITY_KEYS.forEach((ability, index) => (sheet.abilities[ability] = matches[index][1]));
  return true;
}

function parseBareStatLine(sheet: LegacyStatsheet, metaParts: MetaParts, line: string): boolean {
  const match = line.match(/^(Armor Class|AC|Hit Points|HP|Speed|Saving Throws|Skills|Damage Vulnerabilities|Damage Resistances|Damage Immunities|Condition Immunities|Senses|Languages|Challenge|CR|Proficiency Bonus|PB)\s+(.+)$/i);
  return !!match && assignValue(sheet, metaParts, normalizeKey(match[1]), match[2].trim());
}

function parseEntry(line: string): LegacyStatsheetEntry {
  const cleanLine = line.replace(/^[-*]\s+/, '').trim();
  // A name is short; a long first sentence (e.g. a legendary actions intro) is plain text.
  const named = cleanLine.match(/^\**([A-Z][^.:]{0,59})[.:]\**(?:\s+|(?=[A-Z]))(.+)$/);
  return named
    ? { name: named[1].replace(/\*+/g, '').trim(), text: named[2].trim() }
    : { name: '', text: cleanLine };
}

function ensureSection(sheet: LegacyStatsheet, title: string): LegacyStatsheet['sections'][number] {
  let section = sheet.sections.find(existing => existing.title === title);
  if (!section) {
    section = { title, entries: [] };
    sheet.sections.push(section);
  }
  return section;
}

function toDisplayTitle(value: string): string {
  const label = (value.trim().replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' ') || 'Section').replace(/[_-]+/g, ' ');
  return /[A-Z]/.test(label) ? label : label.replace(/\b[a-z]/g, char => char.toUpperCase());
}

export function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

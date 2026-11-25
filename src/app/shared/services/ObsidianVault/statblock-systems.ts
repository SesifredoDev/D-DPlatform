/**
 * Statblock systems: how a game's statblock is laid out and which stats a VTT token takes.
 *
 * There are three kinds of block: creatures (```statblock), items (```item) and spells (```spell).
 * Each game has a system per kind under the same id, so `system: dnd5e` means the D&D 5e creature
 * layout in a statblock, the D&D 5e item layout in an item block, and so on.
 *
 * A system is plain data (no functions), so systems for other games can be added here or, later,
 * loaded from files in the vault. The block itself is YAML (see statblock.ts); a system only
 * says which keys to show, in what order and how.
 */

export type BlockKind = 'creature' | 'item' | 'spell';

export interface StatblockField {
  key: string;
  label: string;
  /** Shown in brackets after the value, e.g. `hit_dice` after Hit Points: "7 (2d6)". */
  extraKey?: string;
  extraLabel?: string;
  placeholder?: string;
}

export type StatblockLayoutBlock =
  /** "Label value" rows (Armor Class 15). Empty fields are hidden when reading. */
  | { kind: 'fields'; fields: StatblockField[] }
  /** A row of scores stored as a list, e.g. `stats: [8, 14, 10, 10, 8, 8]`. */
  | { kind: 'scores'; key: string; labels: string[]; /** Show the D&D modifier under each score. */ modifier?: 'dnd'; signed?: boolean }
  /** Named entries stored as `[{name, desc}]` (traits, actions…). */
  | { kind: 'entries'; key: string; title: string; /** Hide the heading when reading (5e traits have none). */ untitled?: boolean }
  /** A free-text paragraph. */
  | { kind: 'text'; key: string; title: string };

export interface StatblockSystem {
  id: string;
  kind: BlockKind;
  label: string;
  /** Fields edited under the name (size, type…). */
  subtitleFields: StatblockField[];
  /**
   * Line under the name, with `{key}` placeholders. Placeholders with no value are dropped together
   * with the brackets and separators around them.
   */
  subtitle: string;
  /** Short stats shown in a collapsed embed's header. */
  summary: { key: string; label: string }[];
  blocks: StatblockLayoutBlock[];
  /** Which stats a VTT token takes (items only use the name and picture). */
  vtt: {
    /** Key holding hit points: a number, or text starting with one ("45 (6d10 + 12)"). */
    hp?: string;
    /** Key holding a size name (Tiny … Gargantuan). */
    size?: string;
    /** Initiative bonus: a number at `key` (or `key[index]`), or the D&D modifier of that score. */
    initiative?: { key: string; index?: number; modifier?: 'dnd' };
  };
  /** Values for a new statblock (besides `name` and `system`). */
  template: Record<string, unknown>;
}

const DND_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

export const DND5E_SYSTEM: StatblockSystem = {
  id: 'dnd5e',
  kind: 'creature',
  label: 'D&D 5e',
  subtitleFields: [
    { key: 'size', label: 'Size', placeholder: 'Medium' },
    { key: 'type', label: 'Type', placeholder: 'humanoid' },
    { key: 'subtype', label: 'Subtype', placeholder: 'goblinoid' },
    { key: 'alignment', label: 'Alignment', placeholder: 'neutral evil' },
  ],
  subtitle: '{size} {type} ({subtype}), {alignment}',
  summary: [
    { key: 'ac', label: 'AC' },
    { key: 'hp', label: 'HP' },
    { key: 'cr', label: 'CR' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'ac', label: 'Armor Class', placeholder: '15 (leather armor)' },
        { key: 'hp', label: 'Hit Points', extraKey: 'hit_dice', extraLabel: 'Hit dice', placeholder: '7' },
        { key: 'speed', label: 'Speed', placeholder: '30 ft.' },
      ],
    },
    { kind: 'scores', key: 'stats', labels: DND_ABILITIES, modifier: 'dnd' },
    {
      kind: 'fields',
      fields: [
        { key: 'saves', label: 'Saving Throws', placeholder: 'Dex +4, Wis +2' },
        { key: 'skillsaves', label: 'Skills', placeholder: 'Stealth +6' },
        { key: 'damage_vulnerabilities', label: 'Damage Vulnerabilities' },
        { key: 'damage_resistances', label: 'Damage Resistances' },
        { key: 'damage_immunities', label: 'Damage Immunities' },
        { key: 'condition_immunities', label: 'Condition Immunities' },
        { key: 'senses', label: 'Senses', placeholder: 'darkvision 60 ft., passive Perception 9' },
        { key: 'languages', label: 'Languages', placeholder: 'Common' },
        { key: 'cr', label: 'Challenge', placeholder: '1/4' },
      ],
    },
    { kind: 'entries', key: 'traits', title: 'Traits', untitled: true },
    { kind: 'entries', key: 'actions', title: 'Actions' },
    { kind: 'entries', key: 'bonus_actions', title: 'Bonus Actions' },
    { kind: 'entries', key: 'reactions', title: 'Reactions' },
    { kind: 'entries', key: 'legendary_actions', title: 'Legendary Actions' },
    { kind: 'entries', key: 'lair_actions', title: 'Lair Actions' },
  ],
  vtt: { hp: 'hp', size: 'size', initiative: { key: 'stats', index: 1, modifier: 'dnd' } },
  template: {
    size: 'Medium',
    type: 'humanoid',
    alignment: 'unaligned',
    ac: 10,
    hp: 9,
    hit_dice: '2d8',
    speed: '30 ft.',
    stats: [10, 10, 10, 10, 10, 10],
    senses: 'passive Perception 10',
    languages: 'Common',
    cr: '1/8',
    traits: [],
    actions: [
      {
        name: 'Club',
        desc: 'Melee Weapon Attack: +2 to hit, reach 5 ft., one target. Hit: 2 (1d4) bludgeoning damage.',
      },
    ],
  },
};

export const PF2E_SYSTEM: StatblockSystem = {
  id: 'pf2e',
  kind: 'creature',
  label: 'Pathfinder 2e',
  subtitleFields: [
    { key: 'level', label: 'Level', placeholder: '1' },
    { key: 'size', label: 'Size', placeholder: 'Medium' },
    { key: 'traits', label: 'Traits', placeholder: 'humanoid, orc' },
  ],
  subtitle: 'Creature {level} · {size} {traits}',
  summary: [
    { key: 'level', label: 'Lvl' },
    { key: 'ac', label: 'AC' },
    { key: 'hp', label: 'HP' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'perception', label: 'Perception', placeholder: '+5; darkvision' },
        { key: 'languages', label: 'Languages', placeholder: 'Common, Orcish' },
        { key: 'skills', label: 'Skills', placeholder: 'Athletics +7, Intimidation +5' },
      ],
    },
    { kind: 'scores', key: 'mods', labels: DND_ABILITIES, signed: true },
    {
      kind: 'fields',
      fields: [
        { key: 'items', label: 'Items', placeholder: 'greataxe, leather armor' },
        { key: 'ac', label: 'AC', placeholder: '18' },
        { key: 'fort', label: 'Fort', placeholder: '+9' },
        { key: 'ref', label: 'Ref', placeholder: '+6' },
        { key: 'will', label: 'Will', placeholder: '+5' },
        { key: 'hp', label: 'HP', placeholder: '23' },
        { key: 'immunities', label: 'Immunities' },
        { key: 'weaknesses', label: 'Weaknesses' },
        { key: 'resistances', label: 'Resistances' },
        { key: 'speed', label: 'Speed', placeholder: '25 feet' },
      ],
    },
    { kind: 'entries', key: 'abilities', title: 'Abilities' },
    { kind: 'entries', key: 'reactions', title: 'Reactions' },
    { kind: 'entries', key: 'actions', title: 'Actions & Strikes' },
    { kind: 'entries', key: 'spells', title: 'Spells' },
  ],
  // PF2e rolls initiative with Perception.
  vtt: { hp: 'hp', size: 'size', initiative: { key: 'perception' } },
  template: {
    level: 1,
    size: 'Medium',
    traits: 'humanoid',
    perception: '+5',
    languages: 'Common',
    mods: [0, 0, 0, 0, 0, 0],
    ac: 15,
    fort: '+5',
    ref: '+5',
    will: '+5',
    hp: 20,
    speed: '25 feet',
    abilities: [],
    actions: [{ name: 'Melee ◆ fist', desc: '+7 (agile, nonlethal), Damage 1d4+2 bludgeoning' }],
  },
};

/** A system-neutral statblock for any other game. */
export const GENERIC_SYSTEM: StatblockSystem = {
  id: 'generic',
  kind: 'creature',
  label: 'Generic',
  subtitleFields: [{ key: 'kind', label: 'Kind', placeholder: 'Bandit captain' }],
  subtitle: '{kind}',
  summary: [
    { key: 'hp', label: 'HP' },
    { key: 'defense', label: 'Def' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'hp', label: 'Health', placeholder: '12' },
        { key: 'defense', label: 'Defense', placeholder: '12' },
        { key: 'speed', label: 'Movement', placeholder: 'Normal' },
        { key: 'initiative', label: 'Initiative', placeholder: '+2' },
      ],
    },
    { kind: 'entries', key: 'attributes', title: 'Attributes' },
    { kind: 'entries', key: 'abilities', title: 'Abilities' },
    { kind: 'entries', key: 'actions', title: 'Attacks & Actions' },
    { kind: 'text', key: 'description', title: 'Description' },
  ],
  vtt: { hp: 'hp', size: 'size', initiative: { key: 'initiative' } },
  template: {
    hp: 10,
    defense: 10,
    attributes: [],
    abilities: [],
    actions: [{ name: 'Attack', desc: 'Describe the attack and its damage.' }],
  },
};

// ---- Items ----

export const DND5E_ITEM_SYSTEM: StatblockSystem = {
  id: 'dnd5e',
  kind: 'item',
  label: 'D&D 5e',
  subtitleFields: [
    { key: 'type', label: 'Type', placeholder: 'Wondrous item' },
    { key: 'rarity', label: 'Rarity', placeholder: 'rare' },
    { key: 'attunement', label: 'Attunement', placeholder: 'requires attunement' },
  ],
  subtitle: '{type}, {rarity} ({attunement})',
  summary: [
    { key: 'rarity', label: 'Rarity' },
    { key: 'cost', label: 'Cost' },
    { key: 'weight', label: 'Weight' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'cost', label: 'Cost', placeholder: '50 gp' },
        { key: 'weight', label: 'Weight', placeholder: '1 lb.' },
        { key: 'damage', label: 'Damage', placeholder: '1d8 slashing' },
        { key: 'properties', label: 'Properties', placeholder: 'Finesse, light' },
        { key: 'ac', label: 'Armor Class', placeholder: '14 + Dex modifier (max 2)' },
        { key: 'charges', label: 'Charges', placeholder: '3, regains 1d3 at dawn' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
    { kind: 'entries', key: 'abilities', title: 'Abilities' },
  ],
  vtt: {},
  template: {
    type: 'Wondrous item',
    rarity: 'uncommon',
    weight: '1 lb.',
    description: 'Describe what it looks like and what it does.',
    abilities: [],
  },
};

export const PF2E_ITEM_SYSTEM: StatblockSystem = {
  id: 'pf2e',
  kind: 'item',
  label: 'Pathfinder 2e',
  subtitleFields: [
    { key: 'level', label: 'Level', placeholder: '3' },
    { key: 'traits', label: 'Traits', placeholder: 'invested, magical' },
  ],
  subtitle: 'Item {level} · {traits}',
  summary: [
    { key: 'level', label: 'Lvl' },
    { key: 'price', label: 'Price' },
    { key: 'bulk', label: 'Bulk' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'price', label: 'Price', placeholder: '60 gp' },
        { key: 'usage', label: 'Usage', placeholder: 'worn cloak' },
        { key: 'bulk', label: 'Bulk', placeholder: 'L' },
        { key: 'activate', label: 'Activate', placeholder: 'Interact (1 action)' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
    { kind: 'entries', key: 'abilities', title: 'Activations & Abilities' },
  ],
  vtt: {},
  template: {
    level: 1,
    price: '20 gp',
    bulk: 'L',
    description: 'Describe what it looks like and what it does.',
    abilities: [],
  },
};

export const GENERIC_ITEM_SYSTEM: StatblockSystem = {
  id: 'generic',
  kind: 'item',
  label: 'Generic',
  subtitleFields: [{ key: 'type', label: 'Type', placeholder: 'Weapon' }],
  subtitle: '{type}',
  summary: [
    { key: 'value', label: 'Value' },
    { key: 'weight', label: 'Weight' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'value', label: 'Value', placeholder: '10 coins' },
        { key: 'weight', label: 'Weight', placeholder: 'Light' },
        { key: 'uses', label: 'Uses', placeholder: '3' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
    { kind: 'entries', key: 'abilities', title: 'Abilities' },
  ],
  vtt: {},
  template: {
    type: 'Gear',
    description: 'Describe what it looks like and what it does.',
    abilities: [],
  },
};

// ---- Spells ----

export const DND5E_SPELL_SYSTEM: StatblockSystem = {
  id: 'dnd5e',
  kind: 'spell',
  label: 'D&D 5e',
  subtitleFields: [
    { key: 'level', label: 'Level', placeholder: '3 (0 for a cantrip)' },
    { key: 'school', label: 'School', placeholder: 'evocation' },
    { key: 'ritual', label: 'Ritual', placeholder: 'ritual' },
  ],
  subtitle: 'Level {level} {school} ({ritual})',
  summary: [
    { key: 'level', label: 'Lvl' },
    { key: 'casting_time', label: 'Cast' },
    { key: 'range', label: 'Range' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'casting_time', label: 'Casting Time', placeholder: '1 action' },
        { key: 'range', label: 'Range', placeholder: '150 feet' },
        { key: 'components', label: 'Components', placeholder: 'V, S, M (a tiny ball of bat guano)' },
        { key: 'duration', label: 'Duration', placeholder: 'Concentration, up to 1 minute' },
        { key: 'classes', label: 'Classes', placeholder: 'Sorcerer, Wizard' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
    { kind: 'text', key: 'higher_levels', title: 'At Higher Levels' },
  ],
  vtt: {},
  template: {
    level: 1,
    school: 'evocation',
    casting_time: '1 action',
    range: '60 feet',
    components: 'V, S',
    duration: 'Instantaneous',
    description: 'Describe what the spell does.',
  },
};

export const PF2E_SPELL_SYSTEM: StatblockSystem = {
  id: 'pf2e',
  kind: 'spell',
  label: 'Pathfinder 2e',
  subtitleFields: [
    { key: 'rank', label: 'Rank', placeholder: '3' },
    { key: 'traits', label: 'Traits', placeholder: 'fire, manipulate' },
  ],
  subtitle: 'Spell {rank} · {traits}',
  summary: [
    { key: 'rank', label: 'Rank' },
    { key: 'cast', label: 'Cast' },
    { key: 'range', label: 'Range' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'traditions', label: 'Traditions', placeholder: 'arcane, primal' },
        { key: 'cast', label: 'Cast', placeholder: '2 actions' },
        { key: 'range', label: 'Range', placeholder: '500 feet' },
        { key: 'area', label: 'Area', placeholder: '10-foot burst' },
        { key: 'targets', label: 'Targets', placeholder: '1 creature' },
        { key: 'defense', label: 'Defense', placeholder: 'basic Reflex' },
        { key: 'duration', label: 'Duration', placeholder: '1 minute' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
    { kind: 'text', key: 'heightened', title: 'Heightened' },
  ],
  vtt: {},
  template: {
    rank: 1,
    traditions: 'arcane',
    cast: '2 actions',
    range: '30 feet',
    description: 'Describe what the spell does.',
  },
};

export const GENERIC_SPELL_SYSTEM: StatblockSystem = {
  id: 'generic',
  kind: 'spell',
  label: 'Generic',
  subtitleFields: [{ key: 'type', label: 'Type', placeholder: 'Fire magic' }],
  subtitle: '{type}',
  summary: [
    { key: 'cost', label: 'Cost' },
    { key: 'range', label: 'Range' },
  ],
  blocks: [
    {
      kind: 'fields',
      fields: [
        { key: 'cost', label: 'Cost', placeholder: '2 mana' },
        { key: 'range', label: 'Range', placeholder: 'Near' },
        { key: 'duration', label: 'Duration', placeholder: 'Instant' },
      ],
    },
    { kind: 'text', key: 'description', title: 'Description' },
  ],
  vtt: {},
  template: {
    type: 'Spell',
    description: 'Describe what the spell does.',
  },
};

export const STATBLOCK_SYSTEMS: readonly StatblockSystem[] = [
  DND5E_SYSTEM,
  PF2E_SYSTEM,
  GENERIC_SYSTEM,
  DND5E_ITEM_SYSTEM,
  PF2E_ITEM_SYSTEM,
  GENERIC_ITEM_SYSTEM,
  DND5E_SPELL_SYSTEM,
  PF2E_SPELL_SYSTEM,
  GENERIC_SPELL_SYSTEM,
];

export const DEFAULT_STATBLOCK_SYSTEM = DND5E_SYSTEM;

/** The systems for one kind of block, in menu order. */
export function systemsFor(kind: BlockKind): StatblockSystem[] {
  return STATBLOCK_SYSTEMS.filter(system => system.kind === kind);
}

/** The system with this id for this kind; blocks without one (or with an unknown one) are D&D 5e. */
export function getStatblockSystem(id: unknown, kind: BlockKind = 'creature'): StatblockSystem {
  const wanted = typeof id === 'string' ? id.trim().toLowerCase() : '';
  const systems = systemsFor(kind);
  return systems.find(system => system.id === wanted) ?? systems[0];
}

/** Every key a system shows somewhere (used to find extra keys worth showing). */
export function systemKeys(system: StatblockSystem): Set<string> {
  const keys = new Set<string>(system.subtitleFields.map(field => field.key));
  for (const block of system.blocks) {
    if (block.kind === 'fields') {
      block.fields.forEach(field => {
        keys.add(field.key);
        if (field.extraKey) keys.add(field.extraKey);
      });
    } else {
      keys.add(block.key);
    }
  }
  return keys;
}

import {
  blockKindOf,
  canAddToMap,
  blockLanguage,
  entriesValue,
  extraKeys,
  findStatblocks,
  formatSubtitle,
  hasStatblock,
  newStatblockNote,
  newStatblockSource,
  parseStatblock,
  serializeStatblock,
  statblockImage,
  textValue,
  tokenNames,
  tokenStats,
  rollInitiative,
} from './statblock';
import { DND5E_ITEM_SYSTEM, DND5E_SYSTEM, GENERIC_ITEM_SYSTEM, GENERIC_SYSTEM, PF2E_SYSTEM, getStatblockSystem, systemsFor } from './statblock-systems';

const GOBLIN = `name: Goblin
# a comment the app must keep
image: "[[goblin.png]]"
size: Small
type: humanoid
subtype: goblinoid
alignment: neutral evil
ac: 15
hp: 7
hit_dice: 2d6
speed: 30 ft.
stats: [8, 14, 10, 10, 8, 8]
custom_key: kept
actions:
  - name: Scimitar
    desc: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target."`;

describe('parseStatblock', () => {
  it('reads Fantasy Statblocks YAML', () => {
    const parsed = parseStatblock(GOBLIN);
    expect(parsed.error).toBeNull();
    expect(parsed.converted).toBe(false);
    expect(parsed.data['name']).toBe('Goblin');
    expect(parsed.data['stats']).toEqual([8, 14, 10, 10, 8, 8]);
    expect(entriesValue(parsed.data['actions'])).toEqual([
      { name: 'Scimitar', desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target.' },
    ]);
  });

  it('converts the old app format', () => {
    const parsed = parseStatblock(`name: Bandit
meta: Medium humanoid (any race), any non-lawful alignment
armor_class: 12 (leather armor)
hit_points: 11 (2d8 + 2)
speed: 30 ft.
str: 11
dex: 12
con: 12
int: 10
wis: 10
cha: 10
challenge: 1/8 (25 XP)

actions:
  - Scimitar. Melee Weapon Attack: +3 to hit, reach 5 ft.`);
    expect(parsed.converted).toBe(true);
    expect(parsed.data).toMatchObject({
      name: 'Bandit',
      size: 'Medium',
      type: 'humanoid',
      subtype: 'any race',
      alignment: 'any non-lawful alignment',
      ac: '12 (leather armor)',
      hp: 11,
      hit_dice: '2d8 + 2',
      stats: [11, 12, 12, 10, 10, 10],
      cr: '1/8 (25 XP)',
    });
    expect(entriesValue(parsed.data['actions'])[0]).toEqual({ name: 'Scimitar', desc: 'Melee Weapon Attack: +3 to hit, reach 5 ft.' });
  });

  it('reads plain text pasted from a book', () => {
    const parsed = parseStatblock(`Wolf
Medium beast, unaligned
Armor Class 13 (natural armor)
Hit Points 11 (2d8 + 2)
STR DEX CON INT WIS CHA
12 (+1) 15 (+2) 12 (+1) 3 (-4) 12 (+1) 6 (-2)`);
    expect(parsed.converted).toBe(true);
    expect(parsed.data).toMatchObject({ name: 'Wolf', size: 'Medium', type: 'beast', hp: 11, stats: [12, 15, 12, 3, 12, 6] });
  });

  it('reports broken YAML instead of reading it as old-format text', () => {
    const parsed = parseStatblock('name: Ogre\nactions:\n  - name: Club\n desc: [unclosed');
    expect(parsed.error).toBeTruthy();
  });

  it('treats an empty block as a new statblock', () => {
    expect(parseStatblock('  ')).toEqual({ kind: 'creature', data: {}, doc: null, converted: false, error: null });
  });
});

describe('serializeStatblock', () => {
  it('rewrites only changed keys, keeping comments, order and unknown keys', () => {
    const parsed = parseStatblock(GOBLIN);
    const out = serializeStatblock(parsed, { ...parsed.data, hp: 9 });
    expect(out).toContain('# a comment the app must keep');
    expect(out).toContain('hp: 9');
    expect(out).toContain('custom_key: kept');
    expect(out).toContain('stats: [8, 14, 10, 10, 8, 8]');
    expect(out.indexOf('name:')).toBeLessThan(out.indexOf('hp:'));
  });

  it('removes cleared keys', () => {
    const parsed = parseStatblock(GOBLIN);
    const out = serializeStatblock(parsed, { ...parsed.data, subtype: '' });
    expect(out).not.toContain('subtype');
  });

  it('writes converted blocks as YAML in layout order', () => {
    const parsed = parseStatblock('name: Bandit\narmor_class: 12\nhit_points: 11 (2d8 + 2)\ndex: 12');
    const out = serializeStatblock(parsed, parsed.data);
    expect(out.split('\n')[0]).toBe('name: Bandit');
    expect(parseStatblock(out).data).toEqual(parsed.data);
    expect(parseStatblock(out).converted).toBe(false);
  });

  it('round-trips a new block and quotes links', () => {
    const source = newStatblockSource('Ogre');
    const parsed = parseStatblock(source);
    expect(parsed.data['name']).toBe('Ogre');
    expect(parsed.data['system']).toBe('dnd5e');
    const withImage = serializeStatblock(parsed, { ...parsed.data, image: '[[ogre.png]]' });
    expect(parseStatblock(withImage).data['image']).toBe('[[ogre.png]]');
  });
});

describe('display helpers', () => {
  it('formats the subtitle and drops empty parts', () => {
    expect(formatSubtitle(DND5E_SYSTEM, parseStatblock(GOBLIN).data)).toBe('Small humanoid (goblinoid), neutral evil');
    expect(formatSubtitle(DND5E_SYSTEM, { size: 'Large', type: 'giant' })).toBe('Large giant');
    expect(formatSubtitle(DND5E_SYSTEM, { alignment: 'chaotic evil' })).toBe('chaotic evil');
    expect(formatSubtitle(PF2E_SYSTEM, { size: 'Medium' })).toBe('Medium');
    expect(formatSubtitle(PF2E_SYSTEM, { level: 3, size: 'Medium', traits: 'orc' })).toBe('Creature 3 · Medium orc');
  });

  it('shows save and skill maps as text', () => {
    expect(textValue([{ dexterity: 5 }, { wisdom: -1 }])).toBe('Dexterity +5, Wisdom -1');
  });

  it('lists keys the system does not lay out', () => {
    const extra = extraKeys(DND5E_SYSTEM, {
      name: 'X',
      image: 'x.png',
      ac: 10,
      proficiency_bonus: '+2',
      mythic_actions: [{ name: 'Roar', desc: '…' }],
    });
    expect(extra).toEqual({ fields: ['proficiency_bonus'], entries: ['mythic_actions'] });
  });

  it('defaults unknown systems to D&D 5e', () => {
    expect(getStatblockSystem(undefined).id).toBe('dnd5e');
    expect(getStatblockSystem('PF2E').id).toBe('pf2e');
    expect(getStatblockSystem('nope').id).toBe('dnd5e');
  });
});

describe('notes', () => {
  it('finds statblock blocks and ignores other code', () => {
    const note = `# Lair\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n\`\`\`statblock\n${GOBLIN}\n\`\`\`\n\n\`\`\`dnd-statsheet\nname: Old\n\`\`\`\n`;
    const blocks = findStatblocks(note);
    expect(blocks.map(block => block.language)).toEqual(['statblock', 'dnd-statsheet']);
    expect(blocks[0].source).toBe(GOBLIN);
    expect(hasStatblock(note)).toBe(true);
    expect(hasStatblock('```js\nx\n```')).toBe(false);
  });

  it('creates a tagged note with a block', () => {
    const note = newStatblockNote('Ogre', GENERIC_SYSTEM);
    expect(note.startsWith('---\ntags:\n  - statblock\n---')).toBe(true);
    const [block] = findStatblocks(note);
    expect(parseStatblock(block.source).data).toMatchObject({ name: 'Ogre', system: 'generic' });
  });
});

describe('tokens', () => {
  it('reads the token picture', () => {
    expect(statblockImage({ image: '[[Tokens/goblin.png|200]]' })).toBe('Tokens/goblin.png');
    expect(statblockImage({ image: 'https://x.test/a.png' })).toBe('https://x.test/a.png');
    expect(statblockImage({})).toBe('');
  });

  it('takes HP, size and the initiative bonus from the system', () => {
    expect(tokenStats(parseStatblock(GOBLIN).data)).toEqual({ name: 'Goblin', maxHealth: 7, size: 1, initiativeBonus: 2 });
    expect(tokenStats({ name: 'Ogre', hp: '59 (7d10 + 21)', size: 'Large', stats: [19, 8] })).toMatchObject({
      maxHealth: 59,
      size: 2,
      initiativeBonus: -1,
    });
    expect(tokenStats({ name: 'Orc', system: 'pf2e', hp: 23, perception: '+5; darkvision' }).initiativeBonus).toBe(5);
    expect(tokenStats({ system: 'generic' })).toEqual({ name: 'Creature', maxHealth: null, size: 1, initiativeBonus: null });
  });

  it('rolls and names copies', () => {
    expect(rollInitiative(2, () => 0)).toBe(3);
    expect(rollInitiative(null, () => 0.999)).toBe(20);
    expect(tokenNames('Goblin', 1)).toEqual(['Goblin']);
    expect(tokenNames('Goblin', 3)).toEqual(['Goblin 1', 'Goblin 2', 'Goblin 3']);
  });
});

describe('items', () => {
  const SWORD = `name: Flame Tongue
system: dnd5e
image: "[[flame tongue.png]]"
type: Weapon (any sword)
rarity: rare
attunement: requires attunement
weight: 3 lb.
description: You can use a bonus action to speak this magic sword's command word.
abilities:
  - name: Flames
    desc: The blade deals an extra 2d6 fire damage.`;

  it('tells item blocks from statblocks by their language', () => {
    expect(blockKindOf('item')).toBe('item');
    expect(blockKindOf('statblock')).toBe('creature');
    expect(blockKindOf('dnd-statsheet')).toBe('creature');
    expect(blockKindOf('js')).toBeNull();
    expect(blockLanguage('item')).toBe('item');
  });

  it('uses the item layout of the named system', () => {
    const parsed = parseStatblock(SWORD, 'item');
    expect(parsed.kind).toBe('item');
    const system = getStatblockSystem(parsed.data['system'], 'item');
    expect(system).toBe(DND5E_ITEM_SYSTEM);
    expect(formatSubtitle(system, parsed.data)).toBe('Weapon (any sword), rare (requires attunement)');
    expect(getStatblockSystem('pf2e', 'item').kind).toBe('item');
    expect(systemsFor('item').map(s => s.id)).toEqual(['dnd5e', 'pf2e', 'generic']);
  });

  it('never reads item text as an old-format statblock', () => {
    const parsed = parseStatblock('Armor Class 15\nHit Points 7', 'item');
    expect(parsed.error).toBeTruthy();
    expect(parsed.converted).toBe(false);
  });

  it('creates tagged item notes with an item block', () => {
    const note = newStatblockNote('Rope', GENERIC_ITEM_SYSTEM);
    expect(note).toContain('  - item\n');
    const [block] = findStatblocks(note);
    expect(block.kind).toBe('item');
    expect(block.language).toBe('item');
    expect(parseStatblock(block.source, 'item').data).toMatchObject({ name: 'Rope', system: 'generic', type: 'Gear' });
    expect(newStatblockSource('', DND5E_ITEM_SYSTEM)).toContain('name: New item');
  });

  it('makes plain tokens without HP or initiative', () => {
    expect(tokenStats(parseStatblock(SWORD, 'item').data, 'item')).toEqual({
      name: 'Flame Tongue',
      maxHealth: null,
      size: 1,
      initiativeBonus: null,
    });
    expect(tokenStats({}, 'item').name).toBe('Item');
  });

  it('finds statblocks and items in one note', () => {
    const note = '```statblock\nname: Ogre\n```\n\n```item\nname: Club\n```\n';
    expect(findStatblocks(note).map(block => block.kind)).toEqual(['creature', 'item']);
  });
});

describe('spells', () => {
  it('are a third kind with their own fence, layouts and no map tokens', () => {
    expect(blockKindOf('spell')).toBe('spell');
    expect(blockLanguage('spell')).toBe('spell');
    expect(systemsFor('spell').map(system => system.id)).toEqual(['dnd5e', 'pf2e', 'generic']);
    expect(canAddToMap('spell')).toBe(false);
    expect(canAddToMap('item')).toBe(true);

    const note = newStatblockNote('Fireball', getStatblockSystem('dnd5e', 'spell'));
    expect(note).toContain('  - spell\n');
    const [block] = findStatblocks(note);
    expect(block.kind).toBe('spell');
    const data = parseStatblock(block.source, 'spell').data;
    expect(formatSubtitle(getStatblockSystem(data['system'], 'spell'), { ...data, level: 3, school: 'evocation' })).toBe('Level 3 evocation');
  });
});

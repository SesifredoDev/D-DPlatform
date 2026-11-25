import { findStatblocks, parseStatblock, tokenStats } from './statblock';
import {
  homebrewBlockKind,
  importHomebrew,
  importOpen5e,
  importedFence,
  importedNote,
  open5eBlockKind,
} from './statblock-import';
import { CHAIN_MAIL, DRAGON, FIREBALL, FLAME_TONGUE, GOBLIN, LONGSWORD } from './statblock-import.fixtures';

const creature = { object_model: 'Creature', object_pk: 'srd_goblin', route: 'v2/creatures/' };
const magicItem = { object_model: 'MagicItem', object_pk: 'srd_flame-tongue-longsword', route: 'v2/magicitems/' };
const item = { object_model: 'Item', object_pk: 'srd_longsword', route: 'v2/items/' };
const spell = { object_model: 'Spell', object_pk: 'srd_fireball', route: 'v2/spells/' };

describe('open5eBlockKind', () => {
  it('maps creatures, items and spells, and nothing else', () => {
    expect(open5eBlockKind(creature)).toBe('creature');
    expect(open5eBlockKind(magicItem)).toBe('item');
    expect(open5eBlockKind(item)).toBe('item');
    expect(open5eBlockKind(spell)).toBe('spell');
    expect(open5eBlockKind({ object_model: 'Rule', object_pk: 'x', route: 'v2/rules/' })).toBeNull();
    expect(open5eBlockKind({ object_model: 'Condition', object_pk: 'x', route: 'v2/conditions/' })).toBeNull();
  });
});

describe('importOpen5e: creatures', () => {
  it('maps the goblin field by field', () => {
    const block = importOpen5e(creature, GOBLIN)!;
    expect(block.kind).toBe('creature');
    expect(block.sourceKey).toBe('open5e/srd_goblin');
    expect(block.data).toEqual({
      name: 'Goblin',
      system: 'dnd5e',
      size: 'Small',
      type: 'humanoid',
      alignment: 'neutral evil',
      ac: '15 (leather armor, shield)',
      hp: 7,
      hit_dice: '2d6',
      speed: '30 ft.',
      stats: [8, 14, 10, 10, 8, 8],
      skillsaves: 'Stealth +6',
      senses: 'darkvision 60 ft., passive Perception 9',
      languages: 'Common, Goblin',
      cr: '1/4',
      traits: [{ name: 'Nimble Escape', desc: 'The goblin can take the Disengage or Hide action as a bonus action on each of its turns.' }],
      actions: [
        { name: 'Scimitar', desc: GOBLIN.actions[0].desc },
        { name: 'Shortbow', desc: GOBLIN.actions[1].desc },
      ],
      source: 'open5e/srd_goblin',
    });
    expect(block.attribution).toBe(
      '*Source: System Reference Document 5.1 (5e 2014 Rules) by Wizards of the Coast, via [Open5e](https://open5e.com).*'
    );
  });

  it('splits legendary actions and labels recharge and cost', () => {
    const block = importOpen5e(creature, DRAGON)!;
    const actions = (block.data['actions'] as { name: string }[]).map(action => action.name);
    const legendary = (block.data['legendary_actions'] as { name: string }[]).map(action => action.name);
    expect(actions).toContain('Fire Breath (Recharge 5–6)');
    expect(actions).not.toContain('Detect');
    expect(legendary).toEqual(['Detect', 'Tail Attack', 'Wing Attack (Costs 2 Actions)']);
    expect(block.data['saves']).toBe('Dex +6, Con +13, Wis +7, Cha +11');
    expect(block.data['damage_immunities']).toBe('fire');
    expect(block.data['cr']).toBe(17);
    expect(block.data['speed']).toBe('40 ft., climb 40 ft., fly 80 ft.');
  });

  it('gives tokens the right HP, size and initiative', () => {
    const block = importOpen5e(creature, GOBLIN)!;
    expect(tokenStats(block.data, 'creature')).toEqual({ name: 'Goblin', maxHealth: 7, size: 1, initiativeBonus: 2 });
  });
});

describe('importOpen5e: items', () => {
  it('maps a magic weapon', () => {
    const block = importOpen5e(magicItem, FLAME_TONGUE)!;
    expect(block.kind).toBe('item');
    expect(block.data).toMatchObject({
      name: 'Flame Tongue (Longsword)',
      type: 'Weapon (longsword)',
      rarity: 'rare',
      attunement: 'requires attunement',
      weight: '3 lb.',
      damage: '1d8 slashing',
      properties: 'Versatile (1d10)',
    });
    expect(String(block.data['description'])).toContain('bonus action');
  });

  it('maps mundane weapons and armor with cost', () => {
    expect(importOpen5e(item, LONGSWORD)!.data).toMatchObject({ type: 'Weapon', cost: '15 gp', damage: '1d8 slashing' });
    expect(importOpen5e({ ...item, object_pk: 'srd_chain-mail' }, CHAIN_MAIL)!.data).toMatchObject({
      type: 'Armor',
      ac: '16',
      cost: '75 gp',
      weight: '55 lb.',
      properties: 'Strength 13, Stealth disadvantage',
    });
  });
});

describe('importOpen5e: spells', () => {
  it('maps fireball', () => {
    const block = importOpen5e(spell, FIREBALL)!;
    expect(block.kind).toBe('spell');
    expect(block.data).toMatchObject({
      name: 'Fireball',
      level: 3,
      school: 'evocation',
      casting_time: '1 action',
      range: '150 feet',
      components: 'V, S, M (a tiny ball of bat guano and sulfur)',
      duration: 'Instantaneous',
      classes: 'Sorcerer, Wizard',
    });
    expect(block.data['ritual']).toBeUndefined();
    expect(String(block.data['higher_levels'])).toContain('4th level or higher');
  });
});

describe('homebrew', () => {
  const base = { id: 'h1', name: 'Bog Hag', description: 'Lurks in fens.', packName: 'Swamp Pack' };

  it('guesses the kind from the type or the keys', () => {
    expect(homebrewBlockKind({ ...base, properties: { type: 'Monster' } })).toBe('creature');
    expect(homebrewBlockKind({ ...base, properties: { AC: '13', HP: '22' } })).toBe('creature');
    expect(homebrewBlockKind({ ...base, properties: { Rarity: 'rare' } })).toBe('item');
    expect(homebrewBlockKind({ ...base, properties: { 'Casting Time': '1 action' } })).toBe('spell');
    expect(homebrewBlockKind({ ...base, properties: { region: 'north' } })).toBeNull();
  });

  it('maps keys, scores and the description', () => {
    const block = importHomebrew({
      ...base,
      properties: { type: 'monster', 'Armor Class': '13', 'Hit Points': '22', STR: '14', DEX: '12', Habitat: 'swamp' },
    })!;
    expect(block.data).toEqual({
      name: 'Bog Hag',
      system: 'dnd5e',
      ac: 13,
      hp: 22,
      stats: [14, 12, 10, 10, 10, 10],
      habitat: 'swamp',
      source: 'homebrew/h1',
    });
    expect(block.body).toBe('Lurks in fens.');
    expect(block.attribution).toBe('*Source: Swamp Pack (homebrew pack).*');

    const potion = importHomebrew({ ...base, name: 'Fen Draught', properties: { type: 'potion', rarity: 'common' } })!;
    expect(potion.data).toMatchObject({ type: 'potion', rarity: 'common', description: 'Lurks in fens.' });
  });
});

describe('notes from imports', () => {
  it('builds a tagged note whose block reads back the same data', () => {
    const block = importOpen5e(creature, GOBLIN)!;
    const note = importedNote(block);
    expect(note).toContain('  - statblock\n');
    expect(note).toContain(block.attribution);
    const [found] = findStatblocks(note);
    expect(found.kind).toBe('creature');
    expect(parseStatblock(found.source).data).toEqual(block.data);
  });

  it('uses the right fence per kind', () => {
    expect(importedFence(importOpen5e(spell, FIREBALL)!).startsWith('```spell\n')).toBe(true);
    expect(importedFence(importOpen5e(magicItem, FLAME_TONGUE)!).startsWith('```item\n')).toBe(true);
  });
});

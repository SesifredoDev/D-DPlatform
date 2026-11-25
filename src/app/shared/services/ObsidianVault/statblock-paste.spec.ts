import { entriesValue, looksLikePastedStatblock, parseStatblock, pastedStatblockSource } from './statblock';

/** As copied from an SRD PDF: one stat per line, traits before "Actions", wrapped sentences. */
const FROM_PDF = `Goblin
Small humanoid (goblinoid), neutral evil
Armor Class 15 (leather armor, shield)
Hit Points 7 (2d6)
Speed 30 ft.
STR DEX CON INT WIS CHA
8 (-1) 14 (+2) 10 (+0) 10 (+0) 8 (-1) 8 (-1)
Skills Stealth +6
Senses darkvision 60 ft., passive Perception 9
Languages Common, Goblin
Challenge 1/4 (50 XP)
Nimble Escape. The goblin can take the Disengage or Hide action as a bonus action on each
of its turns.
Actions
Scimitar. Melee Weapon Attack: +4 to hit, reach 5 ft., one
target. Hit: 5 (1d6 + 2) slashing damage.
Shortbow. Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2)
piercing damage.`;

/** As copied from a website: each ability on its own lines. */
const FROM_WEB = `Wolf
Medium beast, unaligned
Armor Class 13 (natural armor)
Hit Points 11 (2d8 + 2)
Speed 40 ft.
STR
12 (+1)
DEX
15 (+2)
CON
12 (+1)
INT
3 (-4)
WIS
12 (+1)
CHA
6 (-2)
Challenge 1/4 (50 XP)
Keen Hearing and Smell. The wolf has advantage on Wisdom (Perception) checks that rely on hearing or smell.
Actions
Bite. Melee Weapon Attack: +4 to hit, reach 5 ft., one target.`;

describe('pasted statblocks', () => {
  it('recognises statblock text and ignores ordinary notes', () => {
    expect(looksLikePastedStatblock(FROM_PDF)).toBe(true);
    expect(looksLikePastedStatblock(FROM_WEB)).toBe(true);
    expect(looksLikePastedStatblock('The party met a goblin.\nIt had 7 hit points.\nThey fled.\nThe end.')).toBe(false);
    expect(looksLikePastedStatblock('```statblock\nname: Goblin\nArmor Class 15\nHit Points 7\nSpeed 30\n```')).toBe(false);
  });

  it('reads PDF text, joining wrapped lines and keeping traits', () => {
    const source = pastedStatblockSource(FROM_PDF)!;
    const data = parseStatblock(source).data;
    expect(data).toMatchObject({
      name: 'Goblin',
      size: 'Small',
      type: 'humanoid',
      subtype: 'goblinoid',
      alignment: 'neutral evil',
      ac: '15 (leather armor, shield)',
      hp: 7,
      hit_dice: '2d6',
      stats: [8, 14, 10, 10, 8, 8],
      skillsaves: 'Stealth +6',
      cr: '1/4 (50 XP)',
    });
    expect(entriesValue(data['traits'])).toEqual([
      { name: 'Nimble Escape', desc: 'The goblin can take the Disengage or Hide action as a bonus action on each of its turns.' },
    ]);
    expect(entriesValue(data['actions'])).toEqual([
      { name: 'Scimitar', desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.' },
      { name: 'Shortbow', desc: 'Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage.' },
    ]);
  });

  it('reads abilities listed one per line', () => {
    const data = parseStatblock(pastedStatblockSource(FROM_WEB)!).data;
    expect(data['stats']).toEqual([12, 15, 12, 3, 12, 6]);
    expect(entriesValue(data['traits'])[0].name).toBe('Keen Hearing and Smell');
    expect(entriesValue(data['actions'])[0].name).toBe('Bite');
  });
});

/** Pasted from a statblock website: indented lines, abilities one per line, "Detect.The" with no space. */
const DRAGON_FROM_WEB = `Adult Red Dragon
Huge dragon, Chaotic Evil

    Armor Class 19 (Natural Armor)
    Hit Points 256 (19d12+133)
    Speed 40 ft., climb 40 ft., fly 80 ft.

STR
27 (+8)
DEX
10 (+0)
CON
25 (+7)
INT
16 (+3)
WIS
13 (+1)
CHA
21 (+5)

    Saving Throws Dex +6, Con +13, Wis +7, Cha +11
    Skills Perception +13, Stealth +6
    Damage Immunities Fire
    Senses Blindsight 60 Ft., Darkvision 120 Ft., passive Perception 23
    Languages Common, Draconic
    Challenge 17 (18,000 XP)

    Legendary Resistance (3/Day). If the dragon fails a saving throw, it can choose to succeed instead.

Actions

    Multiattack. The dragon can use its Frightful Presence. It then makes three attacks: one with its bite and two with its claws.
    Bite. Melee Weapon Attack: +14 to hit, reach 10 ft., one target. Hit: (2d10 + 8) piercing damage plus (2d6)fire damage.
    Claw. Melee Weapon Attack: +14 to hit, reach 5 ft., one target. Hit: (2d6 + 8) slashing damage.
    Tail. Melee Weapon Attack: +14 to hit, reach 15 ft., one target. Hit: (2d8 + 8) bludgeoning damage.
    Frightful Presence. Each creature of the dragon's choice that is within 120 ft. of the dragon and aware of it must succeed on a DC 19 Wisdom saving throw or become frightened for 1 minute.
    Fire Breath (Recharge 5-6). The dragon exhales fire in a 60-foot cone. Each creature in that area must make a DC 21 Dexterity saving throw, taking 63 (18d6) fire damage on a failed save, or half as much damage on a successful one.

Legendary Actions
Adult Red Dragon can take 3 legendary actions, choosing from the options below. Only one legendary action option can be used at a time and only at the end of another creature’s turn. Adult Red Dragon regains spent legendary actions at the start of their turn.

    Detect.The dragon makes a Wisdom (Perception) check.
    Tail Attack.The dragon makes a tail attack.
    Wing Attack (Costs 2 Actions).The dragon beats its wings. Each creature within 10 ft. of the dragon must succeed on a DC 22 Dexterity saving throw or take 15 (2d6 + 8) bludgeoning damage and be knocked prone. The dragon can then fly up to half its flying speed.
`;

describe('pasted statblocks from websites', () => {
  it('keeps each indented action separate and reads names without a space after the period', () => {
    const data = parseStatblock(pastedStatblockSource(DRAGON_FROM_WEB)!).data;
    expect(data).toMatchObject({
      name: 'Adult Red Dragon',
      size: 'Huge',
      type: 'dragon',
      alignment: 'Chaotic Evil',
      ac: '19 (Natural Armor)',
      hp: 256,
      hit_dice: '19d12+133',
      stats: [27, 10, 25, 16, 13, 21],
      saves: 'Dex +6, Con +13, Wis +7, Cha +11',
      cr: '17 (18,000 XP)',
    });
    expect(entriesValue(data['traits']).map(entry => entry.name)).toEqual(['Legendary Resistance (3/Day)']);
    expect(entriesValue(data['actions']).map(entry => entry.name)).toEqual([
      'Multiattack',
      'Bite',
      'Claw',
      'Tail',
      'Frightful Presence',
      'Fire Breath (Recharge 5-6)',
    ]);
    const legendary = entriesValue(data['legendary_actions']);
    expect(legendary[0].name).toBe('');
    expect(legendary[0].desc).toMatch(/^Adult Red Dragon can take 3 legendary actions/);
    expect(legendary.slice(1)).toEqual([
      { name: 'Detect', desc: 'The dragon makes a Wisdom (Perception) check.' },
      { name: 'Tail Attack', desc: 'The dragon makes a tail attack.' },
      {
        name: 'Wing Attack (Costs 2 Actions)',
        desc: 'The dragon beats its wings. Each creature within 10 ft. of the dragon must succeed on a DC 22 Dexterity saving throw or take 15 (2d6 + 8) bludgeoning damage and be knocked prone. The dragon can then fly up to half its flying speed.',
      },
    ]);
  });
});


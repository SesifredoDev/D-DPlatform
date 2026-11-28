import {
  calendarMarkdown,
  canvasMarkdown,
  isEmbedSize,
  noteBroadcastMarkdown,
  playerFamilyTree,
  statblockMarkdown,
  timelineMarkdown,
  wikilinkText,
} from './broadcast-format';
import { CalendarEngine } from './calendar-engine';
import type { TimelineEntry } from './calendar.service';
import type { FamilyTree } from './family-tree';
import { CALENDAR_PRESETS } from './vault-calendar';

const gregorian = (today: string | null, holidays: unknown[] = []) => {
  const def = CALENDAR_PRESETS.find(item => item.id === 'gregorian')!.build();
  return new CalendarEngine({ ...def, today, holidays: holidays as typeof def.holidays });
};

describe('noteBroadcastMarkdown', () => {
  it('drops the frontmatter', () => {
    expect(noteBroadcastMarkdown('---\ntags: [npc]\nsecret: yes\n---\n\n# Waterdeep\nCity.')).toBe('# Waterdeep\nCity.');
  });

  it('turns links into names and inline dates into dates', () => {
    expect(noteBroadcastMarkdown('Meet [[NPCs/Volo|the author]] in [[Lore/Waterdeep.md#Docks]] on [date:: 15 Mirtul 1492 DR].'))
      .toBe('Meet the author in Waterdeep on 15 Mirtul 1492 DR.');
  });

  it('leaves embeds for the broadcast service', () => {
    expect(noteBroadcastMarkdown('![[Sword Coast.map]] and [[Sword Coast.map]]')).toBe('![[Sword Coast.map]] and Sword Coast');
  });

  it('leaves code alone', () => {
    expect(noteBroadcastMarkdown('`[[raw]]`\n\n```\n[date:: 1 Jan]\n```')).toBe('`[[raw]]`\n\n```\n[date:: 1 Jan]\n```');
  });

  it('writes statblocks out as cards', () => {
    const note = ['Before', '', '```statblock', 'name: Goblin', 'ac: 15', 'hp: 7', 'hit_dice: 2d6', 'stats: [8, 14, 10, 10, 8, 8]', 'actions:', '  - name: Scimitar', '    desc: Hit for 5.', '```', '', 'After'].join('\n');
    const out = noteBroadcastMarkdown(note);
    expect(out).not.toContain('```');
    expect(out).toContain('> ### Goblin');
    expect(out).toContain('**Hit Points** 7 (2d6)');
    expect(out).toContain('| 8 (-1) | 14 (+2) |');
    expect(out).toContain('***Scimitar.*** Hit for 5.');
    expect(out.startsWith('Before')).toBe(true);
    expect(out.endsWith('After')).toBe(true);
  });
});

describe('wikilinkText / isEmbedSize', () => {
  it('prefers the alias, then the file name, then the heading', () => {
    expect(wikilinkText('A/B|Shown')).toBe('Shown');
    expect(wikilinkText('Maps/Coast.map#Waterdeep')).toBe('Coast');
    expect(wikilinkText('#Section')).toBe('Section');
  });

  it('knows sizes from captions', () => {
    expect(isEmbedSize('300')).toBe(true);
    expect(isEmbedSize('x420')).toBe(true);
    expect(isEmbedSize('300x200')).toBe(true);
    expect(isEmbedSize('The docks')).toBe(false);
    expect(isEmbedSize('')).toBe(false);
  });
});

describe('statblockMarkdown', () => {
  it('lays out items and spells by their system', () => {
    const spell = statblockMarkdown('spell', 'name: Fireball\nlevel: 3\nschool: Evocation\ndesc: A bright streak.');
    expect(spell).toContain('> ### Fireball');
    expect(spell).toContain('A bright streak.');
  });

  it('keeps a vault picture as an embed for the broadcast to attach', () => {
    expect(statblockMarkdown('creature', 'name: Goblin\nimage: "[[goblin.png]]"')).toContain('![[goblin.png]]');
  });

  it('gives nothing for unreadable blocks', () => {
    expect(statblockMarkdown('item', 'name: [unclosed')).toBe('');
  });
});

describe('family trees', () => {
  const tree: FamilyTree = {
    people: [
      { id: 'a', name: 'Ned', details: 'Lord %%secretly alive%%', link: null, portrait: null },
      { id: 'b', name: 'Catelyn', details: '', link: null, portrait: null },
      { id: 'c', name: 'Jon', details: '', link: null, portrait: null },
      { id: 'd', name: '%%Hidden heir%%', details: '', link: null, portrait: null },
    ],
    relations: [
      { id: 'r1', kind: 'spouse', from: 'a', to: 'b' },
      { id: 'r2', kind: 'parent', from: 'a', to: 'c' },
      { id: 'r3', kind: 'parent', from: 'b', to: 'c' },
      { id: 'r4', kind: 'parent', from: 'a', to: 'd' },
    ],
  };

  it('leaves out secrets and people whose name is secret', () => {
    const player = playerFamilyTree(tree);
    expect(player.tree.people.map(person => person.name)).toEqual(['Ned', 'Catelyn', 'Jon']);
    expect(player.tree.people[0].details).toBe('Lord');
    expect(player.tree.relations.some(relation => relation.to === 'd')).toBe(false);
    expect(player.removed).toBe(2);
  });
});

describe('calendarMarkdown', () => {
  it('draws today’s month with weekdays, today in bold and holidays marked', () => {
    const engine = gregorian('15 March 2026 AD', [
      { id: 'h1', name: 'Ides', date: { month: 'March', day: 15 }, repeat: 'yearly' },
      { id: 'h2', name: '%%Assassination plot%%', date: { month: 'March', day: 20 }, repeat: 'yearly' },
    ]);
    const { markdown, removed } = calendarMarkdown(engine);
    expect(markdown).toContain('**Today:** Sunday, 15 March 2026 AD');
    expect(markdown).toContain('### March 2026 AD');
    expect(markdown).toContain('| Sunday | Monday |');
    expect(markdown).toContain('**15 ✦**');
    expect(markdown).toContain('- 15 March 2026 AD — Ides');
    expect(markdown).not.toContain('Assassination');
    expect(markdown).not.toContain('20 ✦');
    expect(removed).toBe(1);
  });

  it('shows the month asked for', () => {
    const engine = gregorian(null);
    const focus = engine.parse('1 July 1990 AD')!.date;
    expect(calendarMarkdown(engine, focus).markdown).toContain('### July 1990 AD');
  });
});

describe('timelineMarkdown', () => {
  const engine = gregorian('1 June 2000 AD');
  const entry = (title: string, date: string, extra: Partial<TimelineEntry> = {}): TimelineEntry => {
    const parsed = engine.parse(date)!;
    return {
      key: title, kind: 'event', title, day: engine.toDayNumber(parsed.date), endDay: null,
      label: engine.format(parsed.date, parsed.precision), precision: parsed.precision, path: null, color: null, lane: 'Events', event: null,
      ...extra,
    };
  };

  it('lists entries with a today marker and leaves out secret titles', () => {
    const { markdown, removed } = timelineMarkdown(engine, [
      entry('Founding', '1 January 1990 AD', { lane: 'Politics' }),
      entry('%%Betrayal%%', '1 March 2000 AD'),
      entry('Festival', '1 August 2000 AD'),
    ]);
    expect(markdown.split('\n')).toEqual([
      '- **1 January 1990 AD** — Founding *(Politics)*',
      '- **1 June 2000 AD** — *Today*',
      '- **1 August 2000 AD** — Festival',
    ]);
    expect(removed).toBe(1);
  });
});

describe('canvasMarkdown', () => {
  it('reads cards in order, under their groups, without secrets', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: 'g', type: 'group', label: 'Act 2', x: 0, y: 500, width: 800, height: 400 },
        { id: 't2', type: 'text', text: 'Inside the group', x: 20, y: 600, width: 200, height: 100 },
        { id: 't1', type: 'text', text: 'First %%GM note%%', x: 0, y: 0, width: 200, height: 100 },
        { id: 'f', type: 'file', file: 'Maps/Coast.map', x: 300, y: 0, width: 200, height: 100 },
        { id: 'l', type: 'link', url: 'https://example.com', x: 0, y: 200, width: 200, height: 100 },
      ],
      edges: [],
    });
    const { markdown, removed } = canvasMarkdown(canvas);
    expect(markdown).toBe('First\n\n---\n\n![[Maps/Coast.map]]\n\n---\n\n<https://example.com>\n\n### Act 2\n\nInside the group');
    expect(removed).toBe(1);
  });

  it('rejects files that aren’t JSON', () => {
    expect(() => canvasMarkdown('{nope')).toThrow();
  });
});

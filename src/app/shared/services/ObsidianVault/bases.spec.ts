import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex } from './vault-index.service';
import {
  BaseContext,
  NEW_BASE_CONTENT,
  QUEST_TRACKER_CONTENT,
  addBaseView,
  conditionsToFilter,
  filterToConditions,
  newNoteDefaults,
  notePropertyKey,
  parseBase,
  removeBaseView,
  runBaseView,
  setBaseFilters,
  setDisplayName,
  setViewField,
  statementToCondition,
} from './bases';

function file(relativePath: string): VaultEntry {
  const parts = relativePath.split('/');
  return {
    name: parts[parts.length - 1],
    kind: 'file',
    handle: {} as FileSystemHandle,
    relativePath,
    parentPath: parts.slice(0, -1).join('/'),
  };
}

function folder(relativePath: string, children: VaultEntry[]): VaultEntry {
  const parts = relativePath.split('/');
  return {
    name: parts[parts.length - 1],
    kind: 'directory',
    handle: {} as FileSystemHandle,
    relativePath,
    parentPath: parts.slice(0, -1).join('/'),
    children,
  };
}

function buildVault(): VaultIndex {
  const index = new VaultIndex([
    folder('NPCs', [file('NPCs/Strahd.md'), file('NPCs/Ireena.md'), file('NPCs/Ismark.md')]),
    folder('Places', [file('Places/Barovia.md')]),
    file('NPCs.base'),
    file('map.png'),
  ]);
  index.indexNoteContent('NPCs/Strahd.md', '---\ntags: [npc, villain]\nfaction: Zarovich\nlevel: 15\nalive: true\nmet: 2026-11-01\nhome: "[[Barovia]]"\n---\n', 3000);
  index.indexNoteContent('NPCs/Ireena.md', '---\ntags: [npc, ally]\nfaction: Barovia\nlevel: 3\nalive: true\nallies:\n  - "[[Ismark]]"\n---\nSee [[Strahd]].', 2000);
  index.indexNoteContent('NPCs/Ismark.md', '---\ntags:\n  - npc\n  - ally\nfaction: barovia\nlevel: "4"\nalive: false\n---\n', 1000);
  index.indexNoteContent('Places/Barovia.md', '---\ntags: [location]\n---\n');
  return index;
}

const names = (result: { rows: { entry: VaultEntry }[] }) => result.rows.map(row => row.entry.name);

describe('parseBase', () => {
  it('reads filters, formulas, display names and views', () => {
    const config = parseBase([
      'filters:',
      '  and:',
      '    - file.hasTag("npc")',
      '    - not:',
      '        - file.inFolder("Archive")',
      'formulas:',
      '  power: "level * 2"',
      'properties:',
      '  faction:',
      '    displayName: Faction',
      'views:',
      '  - type: cards',
      '    name: Gallery',
      '    order: [file.name, faction]',
      '    sort:',
      '      - property: level',
      '        direction: DESC',
      '    limit: 10',
      '    groupBy:',
      '      property: faction',
      '      direction: ASC',
      '    image: note.portrait',
    ].join('\n'));

    expect(config.error).toBeNull();
    expect(config.filters).toEqual({ and: ['file.hasTag("npc")', { not: ['file.inFolder("Archive")'] }] });
    expect(config.formulas).toEqual({ power: 'level * 2' });
    expect(config.displayNames).toEqual({ faction: 'Faction' });
    expect(config.views).toEqual([{
      type: 'cards',
      name: 'Gallery',
      filters: null,
      order: ['file.name', 'faction'],
      sort: [{ property: 'level', direction: 'DESC' }],
      limit: 10,
      groupBy: { property: 'faction', direction: 'ASC' },
      groupOrder: null,
      image: 'note.portrait',
    }]);
  });

  it('reports invalid YAML and treats an empty file as empty', () => {
    expect(parseBase('views: [').error).toBeTruthy();
    expect(parseBase('').views).toEqual([]);
  });
});

describe('editing a .base file', () => {
  const original = '# Party NPCs\nfilters: file.hasTag("npc")\nviews:\n  - type: table\n    name: All # main view\n    order:\n      - file.name\n    customKey: keep me\n';

  it('changes only what was edited and keeps comments and unknown keys', () => {
    const next = setViewField(original, 0, 'sort', [{ property: 'level', direction: 'DESC' }]);
    expect(next).toContain('# Party NPCs');
    expect(next).toContain('name: All # main view');
    expect(next).toContain('customKey: keep me');
    expect(parseBase(next).views[0].sort).toEqual([{ property: 'level', direction: 'DESC' }]);
    expect(parseBase(setViewField(next, 0, 'sort', null)).views[0].sort).toEqual([]);
  });

  it('sets filters for all views or one view', () => {
    const all = setBaseFilters(original, 'all', { and: ['file.hasTag("ally")'] });
    expect(parseBase(all).filters).toEqual({ and: ['file.hasTag("ally")'] });
    const one = setBaseFilters(original, 0, 'level > 3');
    expect(parseBase(one).views[0].filters).toBe('level > 3');
    expect(parseBase(setBaseFilters(original, 'all', null)).filters).toBeNull();
  });

  it('adds and removes views, and sets display names', () => {
    const added = addBaseView(NEW_BASE_CONTENT, { name: 'Cards', type: 'cards', order: ['file.name'] });
    expect(parseBase(added).views.map(v => [v.name, v.type])).toEqual([['Table', 'table'], ['Cards', 'cards']]);
    expect(parseBase(removeBaseView(added, 0)).views.map(v => v.name)).toEqual(['Cards']);
    expect(addBaseView('', { name: 'First' })).toBe('views:\n  - type: table\n    name: First\n');

    const named = setDisplayName(NEW_BASE_CONTENT, 'faction', 'Faction');
    expect(parseBase(named).displayNames).toEqual({ faction: 'Faction' });
    expect(setDisplayName(named, 'faction', '')).toBe(NEW_BASE_CONTENT);
  });
});

describe('filter builder', () => {
  it.each([
    ['file.hasTag("npc")', { kind: 'tag', value: 'npc' }],
    ['file.inFolder("NPCs/Barovia")', { kind: 'folder', value: 'NPCs/Barovia' }],
    ['faction == "Harpers"', { kind: 'property', property: 'faction', op: 'is', value: 'Harpers' }],
    ['level >= 3', { kind: 'property', property: 'level', op: 'gte', value: '3' }],
    ['note["Origin / Found"] != "x"', { kind: 'property', property: 'Origin / Found', op: 'is-not', value: 'x' }],
    ['allies.contains("[[Ismark]]")', { kind: 'property', property: 'allies', op: 'contains', value: '[[Ismark]]' }],
    ['!status.isEmpty()', { kind: 'property', property: 'status', op: 'not-empty', value: '' }],
    ['file.mtime > now() - "1 week"', { kind: 'raw', expression: 'file.mtime > now() - "1 week"' }],
  ])('round-trips %s', (statement, condition) => {
    expect(statementToCondition(statement)).toEqual(condition);
    expect(conditionsToFilter([condition as never])).toEqual({ and: [statement] });
  });

  it('only handles flat AND lists', () => {
    expect(filterToConditions(null)).toEqual([]);
    expect(filterToConditions('level > 3')).toHaveLength(1);
    expect(filterToConditions({ or: ['a', 'b'] })).toBeNull();
    expect(filterToConditions({ and: ['a', { not: ['b'] }] })).toBeNull();
    expect(conditionsToFilter([{ kind: 'tag', value: ' ' }])).toBeNull();
    expect(conditionsToFilter([{ kind: 'property', property: 'faction', op: 'is', value: '' }])).toBeNull();
  });
});

describe('expressions', () => {
  const index = buildVault();
  const ctx = (path: string) => new BaseContext(index.getByPath(path)!, index, { power: 'level * 2', loop: 'formula.loop' }, index.getByPath('NPCs.base'));
  const strahd = ctx('NPCs/Strahd.md');

  it.each([
    ['file.name', 'Strahd.md'],
    ['file.basename', 'Strahd'],
    ['file.folder', 'NPCs'],
    ['file.ext', 'md'],
    ['file.hasTag("npc", "nope")', true],
    ['file.hasTag("#VILLAIN")', true],
    ['file.inFolder("npcs")', true],
    ['file.inFolder("Places")', false],
    ['level > 10 && alive', true],
    ['note.level + 1', 16],
    ['note["faction"].lower()', 'zarovich'],
    ['faction == "zarovich"', true],
    ['faction != "Barovia"', true],
    ['home == link("Barovia")', true],
    ['home == "[[Places/Barovia]]"', true],
    ['file.hasLink("Barovia")', true],
    ['met < date("2026-12-01")', true],
    ['met + "1 week" > date("2026-11-07")', true],
    ['met.year', 2026],
    ['formula.power', 30],
    ['missing.isEmpty()', true],
    ['missing == null', true],
    ['if(level > 10, "high", "low")', 'high'],
    ['file.tags.contains("#villain")', true],
    ['[1, 2, 3].contains(2)', true],
    ['"a" + 1', 'a1'],
  ])('%s', (expression, expected) => {
    expect(strahd.evaluate(expression)).toEqual(expected);
  });

  it('compares numbers written as text and checks list items as links', () => {
    expect(ctx('NPCs/Ismark.md').evaluate('level > 3')).toBe(true);
    expect(ctx('NPCs/Ireena.md').evaluate('allies.contains(file("NPCs/Ismark.md"))')).toBe(true);
    expect(ctx('NPCs/Ireena.md').evaluate('allies.contains("[[Ismark]]")')).toBe(true);
    expect(ctx('NPCs/Ireena.md').evaluate('file.hasLink(this.file)')).toBe(false);
  });

  it('rejects what it does not support', () => {
    expect(() => strahd.evaluate('file.size > 10')).toThrow(/file.size/);
    expect(() => strahd.evaluate('faction.matches("x")')).toThrow(/matches/);
    expect(() => strahd.evaluate('formula.loop')).toThrow(/itself/);
    expect(() => strahd.evaluate('level >')).toThrow();
  });
});

describe('runBaseView', () => {
  const index = buildVault();

  it('filters, sorts with empty values last, and limits', () => {
    const config = parseBase('filters: file.hasTag("npc")\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: level\n        direction: DESC\n    limit: 2');
    const result = runBaseView(config, 0, index, 'NPCs.base');
    expect(names(result)).toEqual(['Strahd.md', 'Ismark.md']);
    expect(result.total).toBe(3);
  });

  it('combines global and view filters, and sorts by name by default', () => {
    const config = parseBase('filters: file.inFolder("NPCs")\nviews:\n  - type: table\n    name: T\n    filters:\n      and:\n        - file.hasTag("ally")');
    expect(names(runBaseView(config, 0, index, null))).toEqual(['Ireena.md', 'Ismark.md']);
  });

  it('supports or / not groups', () => {
    const config = parseBase('filters:\n  or:\n    - file.hasTag("location")\n    - not:\n        - file.inFolder("NPCs")\n        - file.inFolder("Places")\nviews: []');
    expect(names(runBaseView(config, 0, index, null))).toEqual(['Barovia.md', 'map.png', 'NPCs.base']);
  });

  it('groups rows by the exact property value', () => {
    const config = parseBase('filters: file.hasTag("npc")\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: faction\n      direction: ASC');
    const result = runBaseView(config, 0, index, null);
    expect(result.groups?.map(group => [group.label, group.rows.length])).toEqual([['Barovia', 1], ['barovia', 1], ['Zarovich', 1]]);
  });

  it('skips statements it cannot evaluate and reports them', () => {
    const config = parseBase('filters:\n  and:\n    - file.hasTag("npc")\n    - file.size > 100\nviews: []');
    const result = runBaseView(config, 0, index, null);
    expect(result.rows).toHaveLength(3);
    expect(result.warnings).toEqual(['file.size > 100 — uses file.size']);
  });

  it('sorts by modification time', () => {
    const config = parseBase('filters: file.hasTag("npc")\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: file.mtime\n        direction: ASC');
    expect(names(runBaseView(config, 0, index, null))).toEqual(['Ismark.md', 'Ireena.md', 'Strahd.md']);
  });
});

describe('boards (groupOrder)', () => {
  function questVault(): VaultIndex {
    const index = new VaultIndex([
      folder('Quests', [file('Quests/Find the bones.md'), file('Quests/Escort Ireena.md'), file('Quests/Kill Strahd.md'), file('Quests/Lost cat.md'), file('Quests/Rumour.md')]),
    ]);
    index.indexNoteContent('Quests/Find the bones.md', '---\ntags: [quest]\nstatus: active\n---\n');
    index.indexNoteContent('Quests/Escort Ireena.md', '---\ntags: [quest]\nstatus: open\n---\n');
    index.indexNoteContent('Quests/Kill Strahd.md', '---\ntags: [quest]\nstatus: open\n---\n');
    index.indexNoteContent('Quests/Lost cat.md', '---\ntags: [quest]\nstatus: failed\n---\n');
    index.indexNoteContent('Quests/Rumour.md', '---\ntags: [quest]\n---\n');
    return index;
  }

  it('shows listed columns in order, empty ones included, and reports the hidden ones', () => {
    const config = parseBase(QUEST_TRACKER_CONTENT);
    const result = runBaseView(config, 0, questVault(), 'Quests/Quests.base');
    expect(result.groups?.map(group => [group.label, group.value, group.rows.map(row => row.entry.name)])).toEqual([
      ['open', 'open', ['Escort Ireena.md', 'Kill Strahd.md']],
      ['active', 'active', ['Find the bones.md']],
      ['done', 'done', []],
    ]);
    expect(result.hiddenGroups).toEqual([
      { label: 'failed', value: 'failed', count: 1 },
      { label: 'No value', value: null, count: 1 },
    ]);
  });

  it('uses null in groupOrder for notes without a value', () => {
    const config = parseBase('filters: file.hasTag("quest")\nviews:\n  - type: kanban\n    name: B\n    groupBy:\n      property: status\n      direction: ASC\n    groupOrder:\n      - null\n      - failed');
    const result = runBaseView(config, 0, questVault(), null);
    expect(result.groups?.map(group => [group.label, group.value, group.rows.length])).toEqual([['No value', null, 1], ['failed', 'failed', 1]]);
    expect(config.views[0].groupOrder).toEqual([null, 'failed']);
  });

  it('parses the quest tracker preset', () => {
    const config = parseBase(QUEST_TRACKER_CONTENT);
    expect(config.error).toBeNull();
    expect(config.views.map(view => [view.type, view.name])).toEqual([['kanban', 'Board'], ['table', 'All quests']]);
    expect(config.views[0].groupBy).toEqual({ property: 'status', direction: 'ASC' });
  });
});

describe('new notes from a view', () => {
  it('takes tags, folder and "is" values from simple filters', () => {
    const config = parseBase([
      'filters:',
      '  and:',
      '    - file.hasTag("quest")',
      '    - file.inFolder("Quests/Main/")',
      'views:',
      '  - type: table',
      '    name: T',
      '    filters:',
      '      and:',
      '        - region == "Barovia"',
      '        - level > 3',
      '        - file.hasTag("urgent")',
    ].join('\n'));
    expect(newNoteDefaults(config, 0)).toEqual({
      folder: 'Quests/Main',
      tags: ['quest', 'urgent'],
      properties: [{ key: 'region', value: 'Barovia' }],
    });
  });

  it('ignores or/not groups', () => {
    expect(newNoteDefaults(parseBase('filters:\n  or:\n    - file.hasTag("a")\nviews: []'), 0))
      .toEqual({ folder: null, tags: [], properties: [] });
  });

  it('knows which references are note properties', () => {
    expect(notePropertyKey('status')).toBe('status');
    expect(notePropertyKey('note.status')).toBe('status');
    expect(notePropertyKey('file.name')).toBeNull();
    expect(notePropertyKey('formula.x')).toBeNull();
  });
});

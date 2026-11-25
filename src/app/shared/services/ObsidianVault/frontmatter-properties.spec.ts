import {
  convertProperty,
  formatYamlScalar,
  hasProperty,
  propertyTypeFromObsidian,
  propertyValueOf,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
} from './frontmatter';

const note = (yaml: string, body = '# Body\nText') => `---\n${yaml}\n---\n${body}`;

describe('readProperties', () => {
  it('reads scalars and infers their types', () => {
    const props = readProperties(note([
      'faction: Harpers',
      'level: 7',
      'alive: true',
      'met: 2026-11-24',
      'seen: 2026-11-24T18:30',
      'quoted: "true"',
      'link: "[[Strahd von Zarovich]]"',
      "single: 'it''s'",
      'comment: value # note',
    ].join('\n')));

    expect(props.map(p => [p.key, p.type, p.value])).toEqual([
      ['faction', 'text', 'Harpers'],
      ['level', 'number', '7'],
      ['alive', 'checkbox', 'true'],
      ['met', 'date', '2026-11-24'],
      ['seen', 'datetime', '2026-11-24T18:30'],
      ['quoted', 'text', 'true'],
      ['link', 'text', '[[Strahd von Zarovich]]'],
      ['single', 'text', "it's"],
      ['comment', 'text', 'value'],
    ]);
  });

  it('reads flow and block lists', () => {
    const props = readProperties(note('aliases: [Aldric, "The Grey, Old"]\nallies:\n  - "[[Harpers]]"\n  - Elminster\nflat:\n- a\n- b'));
    expect(props.map(p => [p.key, p.type, p.items])).toEqual([
      ['aliases', 'list', ['Aldric', 'The Grey, Old']],
      ['allies', 'list', ['[[Harpers]]', 'Elminster']],
      ['flat', 'list', ['a', 'b']],
    ]);
  });

  it('reads empty values and messy template keys', () => {
    const props = readProperties(note('Name: \nOrigin / Found:\nRelationship w/  Group:\n"quoted key": x\nnothing: null'));
    expect(props.map(p => [p.key, p.type, p.empty])).toEqual([
      ['Name', 'text', true],
      ['Origin / Found', 'text', true],
      ['Relationship w/  Group', 'text', true],
      ['quoted key', 'text', false],
      ['nothing', 'text', true],
    ]);
  });

  it('marks nested and multi-line values as complex', () => {
    const props = readProperties(note([
      'stats:',
      '  str: 10',
      'bio: |',
      '  Line one',
      '',
      '  Line two',
      'map: {a: 1}',
      'links: [[Strahd]]',
      'nested:',
      '  - name: x',
      'after: ok',
    ].join('\n')));
    expect(props.map(p => [p.key, p.type])).toEqual([
      ['stats', 'complex'],
      ['bio', 'complex'],
      ['map', 'complex'],
      ['links', 'complex'],
      ['nested', 'complex'],
      ['after', 'text'],
    ]);
    expect(props[1].raw).toBe('bio: |\n  Line one\n\n  Line two');
  });

  it('ignores comments and returns nothing without frontmatter', () => {
    expect(readProperties(note('# a comment\na: 1')).map(p => p.key)).toEqual(['a']);
    expect(readProperties('# Just a note')).toEqual([]);
    expect(readProperties('---\n---\nBody')).toEqual([]);
  });
});

describe('setProperty', () => {
  const content = note('Name: \ntags:\n  - npc\n# keep me\nfaction:   Harpers   # comment\nallies: [a, b]\nfoes:\n    - x');

  it('changes only the edited lines', () => {
    expect(setProperty(content, 'faction', { type: 'text', value: 'Zhentarim' }))
      .toBe(note('Name: \ntags:\n  - npc\n# keep me\nfaction: Zhentarim\nallies: [a, b]\nfoes:\n    - x'));
  });

  it('keeps the key as written and matches case-insensitively', () => {
    expect(setProperty(note('"Origin / Found": x'), 'origin / found', { type: 'text', value: 'y' }))
      .toBe(note('"Origin / Found": y'));
  });

  it('keeps a list style and its indentation', () => {
    expect(setProperty(content, 'allies', { type: 'list', items: ['a', 'b, c', '[[Strahd]]'] }))
      .toContain('allies: [a, "b, c", "[[Strahd]]"]\n');
    expect(setProperty(content, 'foes', { type: 'list', items: ['x', 'y'] }))
      .toContain('foes:\n    - x\n    - y\n---');
  });

  it('writes an empty list as [] and an empty scalar as a bare key', () => {
    expect(setProperty(content, 'allies', { type: 'list', items: [] })).toContain('allies: []\n');
    expect(setProperty(content, 'faction', { type: 'text', value: '' })).toContain('\nfaction:\n');
  });

  it('quotes text that YAML would read differently', () => {
    expect(setProperty(note('a: 1'), 'a', { type: 'text', value: 'true' })).toBe(note('a: "true"'));
    expect(setProperty(note('a: 1'), 'a', { type: 'text', value: '[[Strahd]]' })).toBe(note('a: "[[Strahd]]"'));
    expect(setProperty(note('a: 1'), 'a', { type: 'number', value: '12' })).toBe(note('a: 12'));
    expect(setProperty(note('a: 1'), 'a', { type: 'checkbox', value: 'false' })).toBe(note('a: false'));
  });

  it('adds new properties at the end, quoting awkward keys, and creates frontmatter', () => {
    expect(setProperty(note('a: 1'), 'status', { type: 'text', value: 'active' })).toBe(note('a: 1\nstatus: active'));
    expect(setProperty(note('a: 1'), 'odd: key', { type: 'text', value: 'x' })).toBe(note('a: 1\n"odd: key": x'));
    expect(setProperty('# Body', 'type', { type: 'list', items: ['npc'] })).toBe('---\ntype:\n  - npc\n---\n# Body');
  });

  it('keeps CRLF line endings and the gap after the frontmatter', () => {
    expect(setProperty('---\r\na: 1\r\nb: 2\r\n---\r\n\r\nBody', 'a', { type: 'number', value: '3' }))
      .toBe('---\r\na: 3\r\nb: 2\r\n---\r\n\r\nBody');
  });

  it('round-trips values it wrote', () => {
    const values = ['plain', 'true', '12', 'a: b', ' padded ', '#hash', "it's \"quoted\"", '[[Link|Alias]]'];
    for (const value of values) {
      const [prop] = readProperties(setProperty('', 'k', { type: 'text', value: value.trim() }));
      expect(prop.value).toBe(value.trim());
      expect(prop.type).toBe('text');
    }
    const [list] = readProperties(setProperty('', 'k', { type: 'list', items: ['a, b', '"q"', '- dash'] }));
    expect(list.items).toEqual(['a, b', '"q"', '- dash']);
  });
});

describe('removeProperty and renameProperty', () => {
  it('removes a property with its lines', () => {
    expect(removeProperty(note('a: 1\nlist:\n  - x\n  - y\nb: 2'), 'list')).toBe(note('a: 1\nb: 2'));
  });

  it('removes a multi-line block including blank lines inside it', () => {
    expect(removeProperty(note('bio: |\n  one\n\n  two\nb: 2'), 'bio')).toBe(note('b: 2'));
  });

  it('drops the frontmatter when the last property goes', () => {
    expect(removeProperty(note('a: 1'), 'a')).toBe('# Body\nText');
  });

  it('renames a key and keeps the value as written', () => {
    expect(renameProperty(note('Aliasses:\n  - x # c\nb: 2'), 'Aliasses', 'aliases')).toBe(note('aliases:\n  - x # c\nb: 2'));
    expect(renameProperty(note('a:   [1, 2]'), 'a', 'new key: x')).toBe(note('"new key: x":   [1, 2]'));
  });

  it('hasProperty ignores case', () => {
    expect(hasProperty(note('Status: x'), 'status')).toBe(true);
    expect(hasProperty(note('Status: x'), 'faction')).toBe(false);
  });
});

describe('convertProperty', () => {
  const [text] = readProperties(note('a: 2026-11-24'));
  const [list] = readProperties(note('a: [x, y]'));

  it('converts between types', () => {
    expect(convertProperty(text, 'list')).toEqual({ type: 'list', items: ['2026-11-24'] });
    expect(convertProperty(text, 'datetime')).toEqual({ type: 'datetime', value: '2026-11-24T00:00' });
    expect(convertProperty(text, 'number')).toEqual({ type: 'number', value: '' });
    expect(convertProperty(list, 'text')).toEqual({ type: 'text', value: 'x, y' });
    expect(convertProperty(list, 'checkbox')).toEqual({ type: 'checkbox', value: 'false' });
  });
});

describe('helpers', () => {
  it('maps Obsidian type names', () => {
    expect(propertyTypeFromObsidian('multitext')).toBe('list');
    expect(propertyTypeFromObsidian('aliases')).toBe('list');
    expect(propertyTypeFromObsidian('date')).toBe('date');
    expect(propertyTypeFromObsidian('weird')).toBeNull();
  });

  it('quotes scalars only when needed', () => {
    expect(formatYamlScalar('Harpers')).toBe('Harpers');
    expect(formatYamlScalar('12')).toBe('"12"');
    expect(formatYamlScalar('12', { keepTyped: true })).toBe('12');
    expect(formatYamlScalar('a, b')).toBe('a, b');
    expect(formatYamlScalar('a, b', { inFlowList: true })).toBe('"a, b"');
  });
});

describe('propertyValueOf', () => {
  it('gives the value to write back to restore a property', () => {
    const content = note('status: open\nlevel: 3\nallies: [a, b]\nempty:\nstats:\n  str: 1');
    expect(propertyValueOf(content, 'Status')).toEqual({ type: 'text', value: 'open' });
    expect(propertyValueOf(content, 'level')).toEqual({ type: 'number', value: '3' });
    expect(propertyValueOf(content, 'allies')).toEqual({ type: 'list', items: ['a', 'b'] });
    expect(propertyValueOf(content, 'empty')).toEqual({ type: 'text', value: '' });
    expect(propertyValueOf(content, 'stats')).toBeNull();
    expect(propertyValueOf(content, 'missing')).toBeNull();
  });
});

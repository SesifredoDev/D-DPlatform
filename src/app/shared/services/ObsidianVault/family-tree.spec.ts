import {
  FamilyTree,
  PERSON_WIDTH,
  addPerson,
  addRelation,
  emptyFamilyTree,
  isFamilyTreePath,
  layoutFamilyTree,
  noteImageCandidates,
  parseFamilyTree,
  relativesOf,
  removePerson,
  removeRelation,
  serializeFamilyTree,
  updatePerson,
} from './family-tree';

function build(): { tree: FamilyTree; ids: Record<string, string> } {
  let tree: FamilyTree = { people: [], relations: [] };
  const ids: Record<string, string> = {};
  const add = (key: string, name: string, link: string | null = null) => {
    const result = addPerson(tree, { name, link });
    tree = result.tree;
    ids[key] = result.id;
  };
  add('ned', 'Ned', 'NPCs/Ned Stark');
  add('cat', 'Catelyn');
  add('robb', 'Robb');
  add('arya', 'Arya Stark', 'Arya Stark');
  add('talisa', 'Talisa');
  const relate = (kind: 'parent' | 'spouse', a: string, b: string) => {
    const result = addRelation(tree, kind, ids[a], ids[b]);
    expect(result.error).toBeNull();
    tree = result.tree;
  };
  relate('spouse', 'ned', 'cat');
  relate('parent', 'ned', 'robb');
  relate('parent', 'cat', 'robb');
  relate('parent', 'ned', 'arya');
  relate('parent', 'cat', 'arya');
  relate('spouse', 'robb', 'talisa');
  return { tree, ids };
}

describe('family tree', () => {
  it('recognises tree files by extension, in any folder', () => {
    expect(isFamilyTreePath('Starks.familytree')).toBe(true);
    expect(isFamilyTreePath('World/Houses/Starks.FamilyTree')).toBe(true);
    expect(isFamilyTreePath('Starks.canvas')).toBe(false);
    expect(isFamilyTreePath('Starks.md')).toBe(false);
  });

  it('round-trips through the file format', () => {
    const { tree } = build();
    const text = serializeFamilyTree(tree);
    expect(JSON.parse(text)).toMatchObject({ type: 'family-tree', version: 1 });
    expect(parseFamilyTree(text)).toEqual({ ...tree, type: 'family-tree', version: 1 });
    expect(parseFamilyTree(emptyFamilyTree())).toMatchObject({ people: [], relations: [] });
    expect(parseFamilyTree('')).toEqual({ people: [], relations: [] });
  });

  it('keeps unknown keys and drops broken entries when reading', () => {
    const tree = parseFamilyTree(JSON.stringify({
      type: 'family-tree',
      version: 1,
      title: 'House Stark',
      people: [
        { id: 'a', name: 'Ned', link: 'NPCs/Ned', born: 263 },
        { id: 'b', name: 'Cat' },
        { name: 'no id' },
        { id: 'a', name: 'duplicate id' },
      ],
      relations: [
        { id: 'r1', kind: 'spouse', from: 'a', to: 'b' },
        { id: 'r2', kind: 'parent', from: 'a', to: 'b' }, // same pair again
        { id: 'r3', kind: 'parent', from: 'a', to: 'ghost' },
        { id: 'r4', kind: 'cousin', from: 'b', to: 'a' },
      ],
    }));
    expect(tree['title']).toBe('House Stark');
    expect(tree.people).toEqual([
      { id: 'a', name: 'Ned', details: '', link: 'NPCs/Ned', portrait: null, born: 263 },
      { id: 'b', name: 'Cat', details: '', link: null, portrait: null },
    ]);
    expect(tree.relations.map(relation => relation.id)).toEqual(['r1']);
    expect(JSON.parse(serializeFamilyTree(tree)).people[0]).toEqual({ id: 'a', name: 'Ned', link: 'NPCs/Ned', born: 263 });
  });

  it('sets and clears portraits', () => {
    const { tree, ids } = build();
    const withPortrait = updatePerson(tree, ids['arya'], { portrait: 'Images/arya.png' });
    const text = serializeFamilyTree(withPortrait);
    expect(parseFamilyTree(text).people.find(person => person.id === ids['arya'])!.portrait).toBe('Images/arya.png');
    const cleared = updatePerson(withPortrait, ids['arya'], { portrait: null });
    expect(JSON.parse(serializeFamilyTree(cleared)).people.find((person: { id: string }) => person.id === ids['arya'])).not.toHaveProperty('portrait');
  });

  it('finds image references in a note, in order', () => {
    const note = [
      '---',
      'image: "[[Portraits/arya.png]]"',
      'banner: maps/winterfell.jpg',
      '---',
      'Links to [[Ned Stark]] and [[sketch.webp|a sketch]].',
      '```',
      '![[ignored.png]]',
      '```',
      'Inline `![[also ignored.png]]` code.',
      '![[Arya Stark#Looks]]',
      '![Needle](Images/needle%20sword.png "Needle")',
      '![[Portraits/arya.png]]',
      '![](https://example.com/arya.jpg)',
    ].join('\n');
    expect(noteImageCandidates(note)).toEqual([
      'Portraits/arya.png',
      'maps/winterfell.jpg',
      'sketch.webp',
      'Arya Stark',
      'Images/needle sword.png',
      'https://example.com/arya.jpg',
    ]);
    expect(noteImageCandidates('No pictures here, just [[Links]].')).toEqual([]);
  });

  it('refuses files that are not family trees, so they are never overwritten', () => {
    expect(() => parseFamilyTree('[1, 2]')).toThrow();
    expect(() => parseFamilyTree('{ nope')).toThrow();
    expect(() => parseFamilyTree('{"type": "canvas"}')).toThrow();
  });

  it('edits people', () => {
    const { tree, ids } = build();
    const renamed = updatePerson(tree, ids['robb'], { name: 'The Young Wolf', details: 'King in the North', link: 'NPCs/Robb' });
    expect(renamed.people.find(person => person.id === ids['robb'])).toMatchObject({ name: 'The Young Wolf', details: 'King in the North', link: 'NPCs/Robb' });
    const unlinked = updatePerson(renamed, ids['robb'], { link: null, name: '  ' });
    expect(unlinked.people.find(person => person.id === ids['robb'])).toMatchObject({ name: 'The Young Wolf', link: null });
  });

  it('refuses relations that make no sense', () => {
    const { tree, ids } = build();
    expect(addRelation(tree, 'parent', ids['arya'], ids['ned']).error).toContain('already related');
    expect(addRelation(tree, 'parent', ids['robb'], ids['robb']).error).toContain('themselves');
    const { tree: withKid, id: kid } = addPerson(tree, { name: 'Kid' });
    const step = addRelation(withKid, 'parent', ids['robb'], kid);
    expect(addRelation(step.tree, 'parent', kid, ids['ned']).error).toContain('ancestor');
    // Adding the same relation twice is a no-op.
    expect(addRelation(tree, 'spouse', ids['cat'], ids['ned'])).toEqual({ tree, error: null });
  });

  it('lists relatives and removes people and relations', () => {
    const { tree, ids } = build();
    const relatives = relativesOf(tree, ids['robb']);
    expect(relatives.parents.map(item => item.person.name)).toEqual(['Ned', 'Catelyn']);
    expect(relatives.spouses.map(item => item.person.name)).toEqual(['Talisa']);
    expect(relatives.children).toEqual([]);

    const unmarried = removeRelation(tree, relatives.spouses[0].relation.id);
    expect(relativesOf(unmarried, ids['robb']).spouses).toEqual([]);

    const without = removePerson(tree, ids['robb']);
    expect(without.people.map(person => person.name)).toEqual(['Ned', 'Catelyn', 'Arya Stark', 'Talisa']);
    expect(without.relations.every(relation => relation.from !== ids['robb'] && relation.to !== ids['robb'])).toBe(true);
  });

  it('lays out generations with spouses side by side and parents over children', () => {
    const { tree, ids } = build();
    const positions = layoutFamilyTree(tree);
    const at = (key: string) => positions.get(ids[key])!;
    expect(at('ned').generation).toBe(0);
    expect(at('cat').generation).toBe(0);
    expect(at('robb').generation).toBe(1);
    expect(at('talisa').generation).toBe(1);
    expect(at('robb').y).toBeGreaterThan(at('ned').y);

    expect(Math.abs(at('ned').x - at('cat').x)).toBeLessThan(PERSON_WIDTH * 2);
    const row = ['robb', 'arya', 'talisa'].map(at).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) expect(row[i].x - row[i - 1].x).toBeGreaterThanOrEqual(PERSON_WIDTH);

    const parentsMid = (at('ned').x + at('cat').x) / 2;
    const childrenMid = (at('robb').x + at('arya').x) / 2;
    expect(Math.abs(parentsMid - childrenMid)).toBeLessThan(1);
  });

  it('survives cycles written by hand', () => {
    const tree = parseFamilyTree(JSON.stringify({
      people: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      relations: [
        { id: 'r1', kind: 'parent', from: 'a', to: 'b' },
        { id: 'r2', kind: 'parent', from: 'b', to: 'c' },
        { id: 'r3', kind: 'parent', from: 'c', to: 'a' },
      ],
    }));
    expect(layoutFamilyTree(tree).size).toBe(3);
  });
});

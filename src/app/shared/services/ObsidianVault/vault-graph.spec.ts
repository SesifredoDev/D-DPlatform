import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex, parseGraphColorGroups } from './vault-index.service';
import { DEFAULT_GRAPH_FILTERS, GraphFilters, buildVaultGraph, compileQuery, defaultColorGroups, graphSignature } from './vault-graph';

function file(relativePath: string): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts[parts.length - 1], kind: 'file', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/') };
}

function folder(relativePath: string, children: VaultEntry[]): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts[parts.length - 1], kind: 'directory', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/'), children };
}

function vault(): VaultIndex {
  const index = new VaultIndex([
    folder('NPCs', [file('NPCs/Strahd.md'), file('NPCs/Ireena.md'), file('NPCs/Ismark.md')]),
    folder('Places', [file('Places/Barovia.md'), file('Places/Castle.md')]),
    file('Lonely.md'),
    file('map.png'),
    file('Notes'), // a file without extension
  ]);
  index.indexNoteContent('NPCs/Strahd.md', '---\ntags: [npc, villain]\nhome: "[[Castle]]"\n---\nLoves [[Ireena]]. ![[map.png]] [[Strahd]]');
  index.indexNoteContent('NPCs/Ireena.md', '---\ntags: [npc]\n---\nSister of [[Ismark]], fears [[Strahd]]. Lives in [[Barovia]]. Wants [[The Amber Temple]].');
  index.indexNoteContent('NPCs/Ismark.md', '---\ntags: [npc]\n---\nIn [[Places/Barovia|the village]].');
  index.indexNoteContent('Places/Barovia.md', '---\ntags: [location]\n---\n');
  index.indexNoteContent('Places/Castle.md', '---\ntags: [location]\n---\n');
  index.indexNoteContent('Lonely.md', 'Nobody links here.');
  return index;
}

const ids = (graph: { nodes: { id: string }[] }) => graph.nodes.map(node => node.id).sort();
const filters = (overrides: Partial<GraphFilters> = {}): GraphFilters => ({ ...DEFAULT_GRAPH_FILTERS, ...overrides });

describe('buildVaultGraph', () => {
  const index = vault();

  it('has every note and one edge per linked pair, without self-links', () => {
    const graph = buildVaultGraph(index, filters(), []);
    expect(ids(graph)).toEqual(['Lonely.md', 'NPCs/Ireena.md', 'NPCs/Ismark.md', 'NPCs/Strahd.md', 'Places/Barovia.md', 'Places/Castle.md']);
    // Strahd↔Ireena is linked both ways but drawn once.
    expect(graph.edges).toHaveLength(5);
    expect(graph.nodes.find(node => node.id === 'NPCs/Ireena.md')!.degree).toBe(3);
  });

  it('adds attachments and missing notes when asked', () => {
    const graph = buildVaultGraph(index, filters({ showAttachments: true, showMissing: true }), []);
    expect(graph.nodes.find(node => node.id === 'map.png')).toMatchObject({ kind: 'file', label: 'map.png', degree: 1 });
    expect(graph.nodes.find(node => node.id === 'missing:the amber temple')).toMatchObject({ kind: 'missing', label: 'The Amber Temple', path: null });
  });

  it('hides orphans when asked', () => {
    expect(ids(buildVaultGraph(index, filters({ showOrphans: false }), []))).not.toContain('Lonely.md');
  });

  it('filters by tag and by search text', () => {
    expect(ids(buildVaultGraph(index, filters({ tag: 'npc' }), []))).toEqual(['NPCs/Ireena.md', 'NPCs/Ismark.md', 'NPCs/Strahd.md']);
    expect(ids(buildVaultGraph(index, filters({ search: 'places/' }), []))).toEqual(['Places/Barovia.md', 'Places/Castle.md']);
  });

  it('builds a local graph to a given depth, in both link directions', () => {
    const depth1 = buildVaultGraph(index, filters({ search: 'ignored in local mode' }), [], { path: 'NPCs/Ismark.md', depth: 1 });
    expect(ids(depth1)).toEqual(['NPCs/Ireena.md', 'NPCs/Ismark.md', 'Places/Barovia.md']);
    const depth2 = buildVaultGraph(index, filters(), [], { path: 'NPCs/Ismark.md', depth: 2 });
    expect(ids(depth2)).toEqual(['NPCs/Ireena.md', 'NPCs/Ismark.md', 'NPCs/Strahd.md', 'Places/Barovia.md']);
  });

  it('keeps the focused note even when it has no links', () => {
    expect(ids(buildVaultGraph(index, filters({ showOrphans: false }), [], { path: 'Lonely.md', depth: 1 }))).toEqual(['Lonely.md']);
  });

  it('colours nodes by the first matching group', () => {
    const graph = buildVaultGraph(index, filters(), [
      { query: 'tag:#villain', color: '#f00' },
      { query: 'tag:#npc', color: '#0f0' },
      { query: 'path:Places', color: '#00f' },
    ]);
    const color = (id: string) => graph.nodes.find(node => node.id === id)!.color;
    expect(color('NPCs/Strahd.md')).toBe('#f00');
    expect(color('NPCs/Ireena.md')).toBe('#0f0');
    expect(color('Places/Castle.md')).toBe('#00f');
    expect(color('Lonely.md')).toBeNull();
  });

  it('changes its signature only when the shape changes', () => {
    const before = graphSignature(buildVaultGraph(index, filters(), []));
    index.indexNoteContent('Lonely.md', 'Still nobody, but different text.');
    expect(graphSignature(buildVaultGraph(index, filters(), []))).toBe(before);
    index.indexNoteContent('Lonely.md', 'Now links to [[Castle]].');
    expect(graphSignature(buildVaultGraph(index, filters(), []))).not.toBe(before);
  });
});

describe('colour groups', () => {
  const index = vault();
  const node = (id: string) => buildVaultGraph(index, filters({ showMissing: true }), []).nodes.find(item => item.id === id)!;

  it('supports tag:, path:, file:, words, negation and OR', () => {
    expect(compileQuery('tag:#npc -tag:#villain', index)(node('NPCs/Ireena.md'))).toBe(true);
    expect(compileQuery('tag:#npc -tag:#villain', index)(node('NPCs/Strahd.md'))).toBe(false);
    expect(compileQuery('file:castle OR file:lonely', index)(node('Lonely.md'))).toBe(true);
    expect(compileQuery('barovia', index)(node('Places/Barovia.md'))).toBe(true);
    expect(compileQuery('line:(foo)', index)(node('Places/Barovia.md'))).toBe(false);
  });

  it('reads Obsidian graph.json colour groups, and falls back to top tags', () => {
    expect(parseGraphColorGroups('{"colorGroups":[{"query":"tag:#npc","color":{"a":1,"rgb":14701138}},{"query":"","color":{"a":1,"rgb":1}}]}'))
      .toEqual([{ query: 'tag:#npc', color: '#e05252' }]);
    expect(parseGraphColorGroups('{"colorGroups":[]}')).toBeNull();
    expect(parseGraphColorGroups('nope')).toBeNull();
    expect(defaultColorGroups(index).map(group => group.query)).toEqual(['tag:#npc', 'tag:#location', 'tag:#villain']);
  });
});

import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex, extractLinks, extractProperties, extractTags, parsePropertyTypes } from './vault-index.service';

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
  return new VaultIndex([
    folder('NPCs', [
      file('NPCs/Aldric.md'),
      folder('NPCs/Villains', [file('NPCs/Villains/Strahd.md')]),
    ]),
    folder('Sessions', [file('Sessions/Session 1.md'), file('Sessions/map.png')]),
    folder('Locations', []),
    file('Locations.md'),
    file('Home.md'),
  ]);
}

describe('VaultIndex', () => {
  it('counts files and folders', () => {
    const index = buildVault();
    expect(index.fileCount).toBe(6);
    expect(index.folderCount).toBe(4);
  });

  it('looks up paths case-insensitively', () => {
    expect(buildVault().getByPath('npcs/aldric.MD')?.relativePath).toBe('NPCs/Aldric.md');
  });

  describe('resolveLink', () => {
    it('resolves exact paths with or without .md', () => {
      const index = buildVault();
      expect(index.resolveLink('NPCs/Aldric')?.relativePath).toBe('NPCs/Aldric.md');
      expect(index.resolveLink('NPCs/Aldric.md')?.relativePath).toBe('NPCs/Aldric.md');
    });

    it('resolves paths relative to the linking note', () => {
      const index = buildVault();
      expect(index.resolveLink('../Aldric', 'NPCs/Villains/Strahd.md')?.relativePath).toBe('NPCs/Aldric.md');
    });

    it('resolves bare note names anywhere in the vault', () => {
      expect(buildVault().resolveLink('Strahd')?.relativePath).toBe('NPCs/Villains/Strahd.md');
    });

    it('strips headings, block refs and aliases', () => {
      const index = buildVault();
      expect(index.resolveLink('Strahd#Lair Actions')?.relativePath).toBe('NPCs/Villains/Strahd.md');
      expect(index.resolveLink('Strahd|the Count')?.relativePath).toBe('NPCs/Villains/Strahd.md');
    });

    it('prefers a note over a folder with the same name', () => {
      expect(buildVault().resolveLink('Locations')?.relativePath).toBe('Locations.md');
    });

    it('returns null for unknown links', () => {
      expect(buildVault().resolveLink('Nobody')).toBeNull();
    });
  });

  describe('resolveFile', () => {
    it('finds attachments by path, relative path or file name, files only', () => {
      const index = buildVault();
      expect(index.resolveFile('Sessions/map.png')?.relativePath).toBe('Sessions/map.png');
      expect(index.resolveFile('map.png', 'Sessions/Session 1.md')?.relativePath).toBe('Sessions/map.png');
      expect(index.resolveFile('map.png', 'Home.md')?.relativePath).toBe('Sessions/map.png');
      expect(index.resolveFile('NPCs')).toBeNull();
    });
  });

  describe('content index', () => {
    it('reports outgoing links and backlinks', () => {
      const index = buildVault();
      index.indexNoteContent('Sessions/Session 1.md', 'Met [[Aldric]] and fled from [[Strahd|the Count]]. ![[map.png]]');
      index.indexNoteContent('Home.md', 'Start at [Session 1](Sessions/Session%201.md)');

      expect(index.getOutgoingLinks('Sessions/Session 1.md').map(e => e.relativePath)).toEqual([
        'NPCs/Aldric.md',
        'NPCs/Villains/Strahd.md',
        'Sessions/map.png',
      ]);
      expect(index.getBacklinks('NPCs/Aldric.md').map(e => e.relativePath)).toEqual(['Sessions/Session 1.md']);
      expect(index.getBacklinks('Sessions/Session 1.md').map(e => e.relativePath)).toEqual(['Home.md']);
    });

    it('returns backlinks with readable snippets of the linking lines', () => {
      const index = buildVault();
      index.indexNoteContent('Sessions/Session 1.md', [
        '# Session 1',
        '- The party **fled** from [[NPCs/Villains/Strahd|the Count]] at dawn.',
        'Later they met [[Aldric]] and [[Strahd#Lair]] again. ![[Strahd]]',
      ].join('\n'));
      index.indexNoteContent('Home.md', 'Unrelated');

      const mentions = index.getBacklinkMentions('NPCs/Villains/Strahd.md');
      expect(mentions.map(m => m.source.relativePath)).toEqual(['Sessions/Session 1.md']);
      expect(mentions[0].snippets).toEqual([
        'The party fled from the Count at dawn.',
        'Later they met Aldric and Strahd again.',
      ]);
    });

    it('trims long snippets around the link', () => {
      const index = buildVault();
      const filler = 'word '.repeat(60);
      index.indexNoteContent('Home.md', `${filler}see [[Aldric]] here ${filler}`);

      const [snippet] = index.getBacklinkMentions('NPCs/Aldric.md')[0].snippets;
      expect(snippet.startsWith('…')).toBe(true);
      expect(snippet.endsWith('…')).toBe(true);
      expect(snippet).toContain('see Aldric here');
      expect(snippet.length).toBeLessThan(160);
    });

    it('bumps the content version on every index update', () => {
      const index = buildVault();
      const before = index.contentVersion;
      index.indexNoteContent('Home.md', '[[Aldric]]');
      expect(index.contentVersion).toBe(before + 1);
    });

    it('updates backlinks when a note is re-indexed', () => {
      const index = buildVault();
      index.indexNoteContent('Home.md', '[[Aldric]]');
      expect(index.getBacklinks('NPCs/Aldric.md')).toHaveLength(1);

      index.indexNoteContent('Home.md', 'no links now');
      expect(index.getBacklinks('NPCs/Aldric.md')).toHaveLength(0);
    });

    it('queries tags, including nested tags', () => {
      const index = buildVault();
      index.indexNoteContent('NPCs/Aldric.md', '#npc #faction/harpers');
      index.indexNoteContent('NPCs/Villains/Strahd.md', '#npc #villain');

      expect(index.getAllTags()[0]).toEqual({ tag: 'npc', count: 2 });
      expect(index.getNotesWithTag('#faction').map(e => e.relativePath)).toEqual(['NPCs/Aldric.md']);
    });

    it('keeps indexed content for paths that survive a rebuild', () => {
      const index = buildVault();
      index.indexNoteContent('Home.md', '[[Aldric]]');

      const rebuilt = buildVault();
      index.copyContentIndexTo(rebuilt);
      expect(rebuilt.getBacklinks('NPCs/Aldric.md').map(e => e.relativePath)).toEqual(['Home.md']);
    });
  });
});

describe('extractLinks', () => {
  it('ignores external links, anchors and code', () => {
    const links = extractLinks([
      '[[Note A]] [site](https://example.com) [top](#top)',
      '`[[not a link]]`',
      '```',
      '[[also not]]',
      '```',
      '![img](images/pic.png)',
    ].join('\n'));

    expect(links).toEqual(['Note A', 'images/pic.png']);
  });
});

describe('notes saved by older app versions', () => {
  it('still counts [x](wikilink:…) links and \\#tags', () => {
    expect(extractLinks('[Session 1](<wikilink:Session 1>) and [the Count](wikilink:Strahd) ![m](wikilink-blob:map.png)'))
      .toEqual(['Session 1', 'Strahd', 'map.png']);
    expect(extractTags('\\#campaign #handout')).toEqual(['campaign', 'handout']);
  });
});

describe('extractTags', () => {
  it('reads inline tags and both frontmatter styles, skipping headings, numbers and code', () => {
    const inline = extractTags('---\ntags: [lore, Elves]\n---\n# Heading\n#quest text #123 `#code`');
    expect(inline.sort()).toEqual(['elves', 'lore', 'quest']);

    const block = extractTags('---\ntags:\n  - npc\n  - "faction/zhentarim"\n---\nbody');
    expect(block.sort()).toEqual(['faction/zhentarim', 'npc']);
  });
});

describe('properties in the index', () => {
  const index = new VaultIndex([file('A.md'), file('B.md'), file('C.md')]);
  index.indexNoteContent('A.md', '---\ntags: [npc]\nfaction: Harpers\nlevel: 3\nallies:\n  - "[[B]]"\n---\n');
  index.indexNoteContent('B.md', '---\nFaction: harpers\nlevel:\n---\n');
  index.indexNoteContent('C.md', '---\nfaction: Zhentarim\nstats:\n  str: 10\n---\n');

  it('lists keys case-insensitively, most used first, with their usual type', () => {
    expect(index.getPropertyKeys()).toEqual([
      { key: 'faction', type: 'text', count: 3 },
      { key: 'level', type: 'number', count: 2 },
      { key: 'allies', type: 'list', count: 1 },
      { key: 'stats', type: null, count: 1 },
    ]);
  });

  it('lists values used for a key, list items included', () => {
    expect(index.getPropertyValues('FACTION')).toEqual([
      { value: 'Harpers', count: 2 },
      { value: 'Zhentarim', count: 1 },
    ]);
    expect(index.getPropertyValues('allies')).toEqual([{ value: '[[B]]', count: 1 }]);
  });

  it('keeps tags out of properties', () => {
    expect(extractProperties('---\ntags: [a]\ntag: b\nx: 1\n---\n').map(p => p.key)).toEqual(['x']);
  });

  it('parses Obsidian types.json', () => {
    expect(parsePropertyTypes('{"types":{"Status":"text","allies":"multitext","x":"odd"}}'))
      .toEqual({ status: 'text', allies: 'list' });
    expect(parsePropertyTypes('not json')).toEqual({});
  });
});

describe('statblock notes', () => {
  it('marks notes holding a statblock, and keeps the mark across rebuilds', () => {
    const index = buildVault();
    index.indexNoteContent('NPCs/Aldric.md', '# Aldric\n\n```statblock\nname: Aldric\n```\n');
    index.indexNoteContent('Home.md', '```js\nconst statblock = 1;\n```');
    expect(index.isStatblockNote('npcs/aldric.md')).toBe(true);
    expect(index.isStatblockNote('Home.md')).toBe(false);

    const rebuilt = buildVault();
    index.copyContentIndexTo(rebuilt);
    expect(rebuilt.isStatblockNote('NPCs/Aldric.md')).toBe(true);

    index.indexNoteContent('NPCs/Aldric.md', '# Aldric, statblock removed');
    expect(index.isStatblockNote('NPCs/Aldric.md')).toBe(false);
  });
});

describe('item notes', () => {
  it('records whether a note holds a statblock or an item', () => {
    const index = buildVault();
    index.indexNoteContent('NPCs/Aldric.md', '```statblock\nname: Aldric\n```');
    index.indexNoteContent('Home.md', '# Loot\n\n```item\nname: Rope\n```');
    expect(index.getStatblockKind('NPCs/Aldric.md')).toBe('creature');
    expect(index.getStatblockKind('Home.md')).toBe('item');
    expect(index.isStatblockNote('Home.md')).toBe(true);
    expect(index.getStatblockKind('Locations.md')).toBeNull();
  });
});

describe('imported sources', () => {
  it('finds the note holding a block imported from a source', () => {
    const index = buildVault();
    index.indexNoteContent('NPCs/Aldric.md', '```statblock\nname: Goblin\nsource: open5e/srd_goblin\n```');
    index.indexNoteContent('Home.md', '```spell\nname: Fireball\nsource: "open5e/srd_fireball"\n```');
    expect(index.findBySource('open5e/SRD_goblin')?.relativePath).toBe('NPCs/Aldric.md');
    expect(index.findBySource('open5e/srd_fireball')?.relativePath).toBe('Home.md');
    expect(index.findBySource('open5e/srd_orc')).toBeNull();

    index.indexNoteContent('NPCs/Aldric.md', '```statblock\nname: Goblin\n```');
    expect(index.findBySource('open5e/srd_goblin')).toBeNull();
  });
});

describe('map files', () => {
  it('count pins as links, so pinned notes list the map in their backlinks', () => {
    const index = new VaultIndex([
      folder('Maps', [file('Maps/Coast.map'), file('Maps/coast.jpg')]),
      file('Waterdeep.md'),
    ]);
    index.indexMapContent('Maps/Coast.map', JSON.stringify({
      image: 'Maps/coast.jpg',
      pins: [{ id: 'p', x: 0.4, y: 0.3, link: 'Waterdeep', label: 'City of Splendors' }],
    }));
    expect(index.getBacklinks('Waterdeep.md').map(entry => entry.relativePath)).toEqual(['Maps/Coast.map']);
    expect(index.getBacklinks('Maps/coast.jpg').map(entry => entry.relativePath)).toEqual(['Maps/Coast.map']);
    expect(index.getBacklinkMentions('Waterdeep.md')[0].snippets).toEqual(['📍 City of Splendors']);
  });
});

describe('calendars, timelines and inline dates', () => {
  it('records inline dates and links from calendars and timelines', () => {
    const index = new VaultIndex([file('Home.md'), file('Lore.md'), file('Harptos.calendar'), file('History.timeline')]);
    index.indexNoteContent('Home.md', 'Left on [date:: 15 Mirtul 1492 DR], back [date:: 3 days later].');
    expect(index.getInlineDates('Home.md')).toEqual(['15 Mirtul 1492 DR', '3 days later']);
    expect(index.notesWithInlineDates().map(entry => entry.relativePath)).toEqual(['Home.md']);

    index.indexCalendarContent('Harptos.calendar', JSON.stringify({
      type: 'calendar', months: [{ name: 'Hammer', days: 30 }],
      holidays: [{ id: 'h', name: 'Founding', date: { month: 'Hammer', day: 1 }, link: 'Lore' }],
    }));
    index.indexTimelineContent('History.timeline', JSON.stringify({
      type: 'timeline', events: [{ id: 'e', date: '1 Hammer 1 DR', title: 'Founding', link: 'Lore' }],
    }));
    expect(index.getBacklinks('Lore.md').map(entry => entry.relativePath).sort()).toEqual(['Harptos.calendar', 'History.timeline']);
  });
});

import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex, extractLinks, extractTags } from './vault-index.service';

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

import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex } from './vault-index.service';
import { rewriteMovedLinks } from './link-rewrite';

function file(relativePath: string): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts.at(-1)!, kind: 'file', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/') };
}
function folder(relativePath: string, children: VaultEntry[]): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts.at(-1)!, kind: 'directory', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/'), children };
}

/** Vault before: NPCs/Strahd.md, Sessions/Session 1.md, map.png. */
const before = new VaultIndex([
  folder('NPCs', [file('NPCs/Strahd.md')]),
  folder('Sessions', [file('Sessions/Session 1.md')]),
  file('map.png'),
]);

/** Simulates renaming NPCs/Strahd.md → NPCs/Count Strahd.md (or moving it with `newPath`). */
function rename(content: string, newPath = 'NPCs/Count Strahd.md', notePath = 'Sessions/Session 1.md') {
  const after = new VaultIndex([
    folder('NPCs', newPath.startsWith('NPCs/') ? [file(newPath)] : []),
    folder('Villains', newPath.startsWith('Villains/') ? [file(newPath)] : []),
    folder('Sessions', [file('Sessions/Session 1.md')]),
    file('map.png'),
  ]);
  return rewriteMovedLinks(content, {
    notePath,
    resolve: (target, from) => before.resolveLink(target, from)?.relativePath ?? null,
    moved: new Map([['npcs/strahd.md', newPath]]),
    wikilinkTextFor: (path, original) => {
      const md = /\.md$/i.test(path) && !/\.md$/i.test(original);
      const strip = (value: string) => (md ? value.slice(0, -3) : value);
      return original.includes('/') ? strip(path) : after.linkTextFor(after.getByPath(path)!);
    },
  });
}

describe('rewriteMovedLinks', () => {
  it('renames wikilinks, keeping headings, aliases and embeds', () => {
    const result = rename('Met [[Strahd]], see [[Strahd#Lair]] and [[NPCs/Strahd|the Count]]. ![[Strahd]]');
    expect(result.content).toBe('Met [[Count Strahd]], see [[Count Strahd#Lair]] and [[NPCs/Count Strahd|the Count]]. ![[Count Strahd]]');
    expect(result.count).toBe(4);
  });

  it('leaves name-only links alone when the file only moved folders', () => {
    const result = rename('Met [[Strahd]] and [[NPCs/Strahd]].', 'Villains/Strahd.md');
    expect(result.content).toBe('Met [[Strahd]] and [[Villains/Strahd]].');
    expect(result.count).toBe(1);
  });

  it('rewrites Markdown links, keeping root or relative style and encoding', () => {
    expect(rename('[a](NPCs/Strahd.md) [b](<NPCs/Strahd.md>) [c](../NPCs/Strahd.md#lair)').content)
      .toBe('[a](NPCs/Count%20Strahd.md) [b](<NPCs/Count Strahd.md>) [c](../NPCs/Count%20Strahd.md#lair)');
  });

  it('rewrites links saved in the old [x](wikilink:…) format', () => {
    expect(rename('[Strahd](wikilink:Strahd)').content).toBe('[Strahd](wikilink:Count Strahd)');
  });

  it('does not touch code, other links or unrelated text', () => {
    const content = [
      'Keep `[[Strahd]]` and [[Session 1]] and [site](https://example.com/Strahd.md)',
      '```',
      '[[Strahd]]',
      '```',
      'Strahd watched.',
    ].join('\n');
    const result = rename(content);
    expect(result.content).toBe(content);
    expect(result.count).toBe(0);
  });

  it('keeps CRLF line endings', () => {
    expect(rename('[[Strahd]]\r\nnext').content).toBe('[[Count Strahd]]\r\nnext');
  });
});

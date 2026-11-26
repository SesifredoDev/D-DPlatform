import type { VaultEntry } from './obsidian-vault-service';
import { VaultIndex } from './vault-index.service';
import { VaultImageService, cleanImageLink, findImage } from './vault-image.service';

function file(relativePath: string): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts.at(-1)!, kind: 'file', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/') };
}

function folder(relativePath: string, children: VaultEntry[]): VaultEntry {
  const parts = relativePath.split('/');
  return { name: parts.at(-1)!, kind: 'directory', handle: {} as FileSystemHandle, relativePath, parentPath: parts.slice(0, -1).join('/'), children };
}

const vault = () => new VaultIndex([
  folder('Maps', [file('Maps/Coast.png'), file('Maps/Harbour.webp'), file('Maps/Coast.map')]),
  folder('Sessions', [file('Sessions/One.md'), file('Sessions/token.png')]),
  file('Harbour.md'),
  file('portrait.jpg'),
]);

describe('cleanImageLink', () => {
  it('strips the embed prefix, size, heading and encoding', () => {
    expect(cleanImageLink('wikilink-blob:Maps/Coast.png')).toBe('Maps/Coast.png');
    expect(cleanImageLink('Coast.png|300')).toBe('Coast.png');
    expect(cleanImageLink('My%20Map.png#x')).toBe('My Map.png');
    expect(cleanImageLink('Maps' + String.fromCharCode(92) + 'Coast.png')).toBe('Maps/Coast.png');
  });
});

describe('findImage', () => {
  it('finds by path, name, or relative to the note', () => {
    const index = vault();
    expect(findImage(index, 'Maps/Coast.png')?.relativePath).toBe('Maps/Coast.png');
    expect(findImage(index, 'Coast.png')?.relativePath).toBe('Maps/Coast.png');
    expect(findImage(index, 'token.png', 'Sessions/One.md')?.relativePath).toBe('Sessions/token.png');
  });

  it('adds image extensions, preferring an image over a note of the same name', () => {
    const index = vault();
    expect(findImage(index, 'Coast')?.relativePath).toBe('Maps/Coast.png');
    expect(findImage(index, 'Harbour')?.relativePath).toBe('Maps/Harbour.webp');
    expect(findImage(index, 'portrait')?.relativePath).toBe('portrait.jpg');
  });

  it('returns null for missing images and non-images', () => {
    const index = vault();
    expect(findImage(index, 'Nowhere.png')).toBeNull();
    expect(findImage(index, 'Sessions/One.md')).toBeNull();
  });
});

describe('VaultImageService.resolveIn', () => {
  it('remembers answers (misses too) until the vault is re-indexed', () => {
    const service = new VaultImageService({} as never, {} as never);
    const index = vault();
    const lookups = vi.spyOn(index, 'resolveFile');
    expect(service.resolveIn(index, 'Nowhere.png')).toBeNull();
    const calls = lookups.mock.calls.length;
    expect(service.resolveIn(index, 'Nowhere.png')).toBeNull();
    expect(service.resolveIn(index, 'wikilink-blob:Nowhere.png|200')).toBeNull();
    expect(lookups.mock.calls.length).toBe(calls);

    // A re-scan (new index) looks again.
    const rescanned = new VaultIndex([file('Nowhere.png')]);
    expect(service.resolveIn(rescanned, 'Nowhere.png')).toBe('Nowhere.png');
  });
});

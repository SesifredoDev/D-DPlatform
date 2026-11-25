import { VaultConflictError, type VaultWriteOptions } from './obsidian-vault-service';
import { writeNoteProperty } from './note-property-writer';
import { findTemplateForTags } from './note-templates';

/** In-memory stand-in for the vault: files with a modified time, and an optional edit "from Obsidian" mid-write. */
function fakeVault(files: Record<string, string>, options: { editBeforeWrite?: string } = {}) {
  const store = new Map(Object.entries(files).map(([path, content]) => [path, { content, modified: 100 }]));
  let clock = 100;
  const writes: string[] = [];
  return {
    store,
    writes,
    async readFileWithMeta(_serverId: string, path: string) {
      const file = store.get(path);
      if (!file) throw new Error(`missing ${path}`);
      return { content: file.content, lastModified: file.modified };
    },
    async writeFile(_serverId: string, path: string, content: string | Blob, writeOptions: VaultWriteOptions = {}) {
      if (options.editBeforeWrite) {
        store.set(path, { content: options.editBeforeWrite, modified: ++clock });
      }
      const current = store.get(path);
      if (current && writeOptions.expectedLastModified !== undefined && current.modified > writeOptions.expectedLastModified) {
        throw new VaultConflictError(path, current.modified);
      }
      store.set(path, { content: String(content), modified: ++clock });
      writes.push(path);
      return clock;
    },
  };
}

describe('writeNoteProperty', () => {
  const quest = '---\ntags: [quest]\nstatus: open # set by the GM\ngiver: "[[Ismark]]"\n---\n# Escort Ireena\nBody';

  it('changes one property, keeps the rest of the note, and returns the old value', async () => {
    const vault = fakeVault({ 'Quests/Escort.md': quest });
    const result = await writeNoteProperty(vault, 's', 'Quests/Escort.md', 'status', { type: 'text', value: 'active' });

    expect(result.previous).toEqual({ type: 'text', value: 'open' });
    expect(result.modified).toBe(101);
    expect(vault.store.get('Quests/Escort.md')!.content)
      .toBe('---\ntags: [quest]\nstatus: active\ngiver: "[[Ismark]]"\n---\n# Escort Ireena\nBody');
  });

  it('undoes by writing the previous value back, or removing a property that was added', async () => {
    const vault = fakeVault({ 'Q.md': quest });
    const moved = await writeNoteProperty(vault, 's', 'Q.md', 'status', { type: 'text', value: 'done' });
    await writeNoteProperty(vault, 's', 'Q.md', 'status', moved.previous);
    expect(vault.store.get('Q.md')!.content).toContain('\nstatus: open\n');

    const added = await writeNoteProperty(vault, 's', 'Q.md', 'reward', { type: 'number', value: '50' });
    expect(added.previous).toBeNull();
    await writeNoteProperty(vault, 's', 'Q.md', 'reward', added.previous);
    expect(vault.store.get('Q.md')!.content).not.toContain('reward');
  });

  it('does not write when nothing changes', async () => {
    const vault = fakeVault({ 'Q.md': quest });
    const result = await writeNoteProperty(vault, 's', 'Q.md', 'giver', { type: 'text', value: '[[Ismark]]' });
    expect(result.modified).toBeNull();
    expect(vault.writes).toEqual([]);
  });

  it('refuses when the note changes on disk in between', async () => {
    const vault = fakeVault({ 'Q.md': quest }, { editBeforeWrite: 'edited in Obsidian' });
    await expect(writeNoteProperty(vault, 's', 'Q.md', 'status', { type: 'text', value: 'done' }))
      .rejects.toBeInstanceOf(VaultConflictError);
    expect(vault.store.get('Q.md')!.content).toBe('edited in Obsidian');
  });
});

describe('findTemplateForTags', () => {
  it('matches a template named like a tag', () => {
    expect(findTemplateForTags(['quest'])?.fileName).toBe('Quest.md');
    expect(findTemplateForTags(['#NPC', 'villain'])?.fileName).toBe('NPC.md');
    expect(findTemplateForTags(['villain'])).toBeUndefined();
  });
});

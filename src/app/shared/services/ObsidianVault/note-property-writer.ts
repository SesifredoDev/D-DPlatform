import { PropertyValue, propertyValueOf, removeProperty, setProperty } from './frontmatter';
import type { ObsidianVaultService } from './obsidian-vault-service';

export interface NotePropertyWrite {
  /** The property's value before the write (null if the note didn't have it), for undo. */
  previous: PropertyValue | null;
  /** The note's content after the write. */
  content: string;
  /** The file's new last-modified time, or null when nothing needed writing. */
  modified: number | null;
}

/**
 * Sets (or with `null`, removes) one frontmatter property of a note on disk, leaving the rest of the
 * file as it was. Refuses with VaultConflictError if the file changes between the read and the write.
 */
export async function writeNoteProperty(
  vault: Pick<ObsidianVaultService, 'readFileWithMeta' | 'writeFile'>,
  serverId: string,
  path: string,
  key: string,
  value: PropertyValue | null,
): Promise<NotePropertyWrite> {
  const { content, lastModified } = await vault.readFileWithMeta(serverId, path);
  const previous = propertyValueOf(content, key);
  const next = value ? setProperty(content, key, value) : removeProperty(content, key);
  if (next === content) return { previous, content, modified: null };

  const modified = await vault.writeFile(serverId, path, next, { expectedLastModified: lastModified });
  return { previous, content: next, modified };
}

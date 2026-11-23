/**
 * Single source of truth for how each vault file type is shown, read, and edited.
 * To support a new file type, add an entry here (and a viewer branch in the view template
 * if it needs a new `viewer`).
 */
export type VaultFileViewer = 'markdown' | 'canvas' | 'image' | 'pdf' | 'download';

export interface VaultFileType {
  id: string;
  extensions: readonly string[];
  icon: string;
  viewer: VaultFileViewer;
  /** 'text' files are loaded into the editor as a string; 'blob' files are shown via an object URL. */
  readAs: 'text' | 'blob';
  /** Editable files are auto-saved. */
  editable: boolean;
  /** Fixed label for the tree badge. Defaults to the upper-cased extension. */
  label?: string;
  /** Hide the extension in titles (e.g. "Session 1" instead of "Session 1.md"). */
  hideExtensionInTitle?: boolean;
  /** Default extension used when creating a file of this type without one. */
  defaultExtension?: string;
}

export const VAULT_FILE_TYPES: readonly VaultFileType[] = [
  {
    id: 'markdown',
    extensions: ['md', 'markdown'],
    icon: 'description',
    viewer: 'markdown',
    readAs: 'text',
    editable: true,
    label: 'MD',
    hideExtensionInTitle: true,
    defaultExtension: 'md',
  },
  {
    id: 'canvas',
    extensions: ['canvas'],
    icon: 'account_tree',
    viewer: 'canvas',
    readAs: 'text',
    editable: true,
    label: 'Canvas',
    hideExtensionInTitle: true,
    defaultExtension: 'canvas',
  },
  {
    id: 'image',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'],
    icon: 'image',
    viewer: 'image',
    readAs: 'blob',
    editable: false,
  },
  {
    id: 'pdf',
    extensions: ['pdf'],
    icon: 'picture_as_pdf',
    viewer: 'pdf',
    readAs: 'blob',
    editable: false,
  },
  {
    id: 'audio',
    extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a'],
    icon: 'graphic_eq',
    viewer: 'download',
    readAs: 'blob',
    editable: false,
  },
  {
    id: 'video',
    extensions: ['mp4', 'webm', 'mov', 'avi'],
    icon: 'movie',
    viewer: 'download',
    readAs: 'blob',
    editable: false,
  },
];

export const GENERIC_FILE_TYPE: VaultFileType = {
  id: 'file',
  extensions: [],
  icon: 'insert_drive_file',
  viewer: 'download',
  readAs: 'blob',
  editable: false,
};

const typeByExtension = new Map<string, VaultFileType>(
  VAULT_FILE_TYPES.flatMap(type => type.extensions.map(ext => [ext, type] as const))
);

export function getFileExtension(name: string): string {
  const fileName = name.split('/').pop() || name;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
}

export function getVaultFileType(name: string): VaultFileType {
  return typeByExtension.get(getFileExtension(name)) ?? GENERIC_FILE_TYPE;
}

export function isVaultFileType(name: string, typeId: string): boolean {
  return getVaultFileType(name).id === typeId;
}

export function getVaultFileTypeById(typeId: string): VaultFileType | undefined {
  return VAULT_FILE_TYPES.find(type => type.id === typeId);
}

/** Display name for a file: strips the extension for types that hide it (markdown, canvas). */
export function getVaultDisplayName(name: string): string {
  const type = getVaultFileType(name);
  if (!type.hideExtensionInTitle) return name;

  const extension = getFileExtension(name);
  return extension ? name.slice(0, -(extension.length + 1)) : name;
}

export function getVaultFileTypeLabel(name: string): string {
  const type = getVaultFileType(name);
  if (type.label) return type.label;

  const extension = getFileExtension(name);
  return extension ? extension.toUpperCase() : 'File';
}

export function inferImageMimeType(filename: string): string {
  const ext = getFileExtension(filename);
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return ext ? `image/${ext}` : 'image/png';
}

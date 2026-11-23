import { getVaultDisplayName, getVaultFileType, getVaultFileTypeLabel, inferImageMimeType } from './vault-file-types';
import { applyTemplateVariables } from './note-templates';

describe('vault file types', () => {
  it('maps extensions to types case-insensitively', () => {
    expect(getVaultFileType('Notes/Session.MD').id).toBe('markdown');
    expect(getVaultFileType('tree.canvas').viewer).toBe('canvas');
    expect(getVaultFileType('map.JPEG').viewer).toBe('image');
    expect(getVaultFileType('rules.pdf').viewer).toBe('pdf');
    expect(getVaultFileType('theme.mp3').icon).toBe('graphic_eq');
    expect(getVaultFileType('README').id).toBe('file');
  });

  it('hides extensions only for notes and canvases', () => {
    expect(getVaultDisplayName('Session 1.md')).toBe('Session 1');
    expect(getVaultDisplayName('Lore.markdown')).toBe('Lore');
    expect(getVaultDisplayName('Family.canvas')).toBe('Family');
    expect(getVaultDisplayName('map.png')).toBe('map.png');
  });

  it('labels files the way the tree did before', () => {
    expect(getVaultFileTypeLabel('a.md')).toBe('MD');
    expect(getVaultFileTypeLabel('a.canvas')).toBe('Canvas');
    expect(getVaultFileTypeLabel('a.png')).toBe('PNG');
    expect(getVaultFileTypeLabel('README')).toBe('File');
  });

  it('infers image mime types', () => {
    expect(inferImageMimeType('a.jpg')).toBe('image/jpeg');
    expect(inferImageMimeType('a.svg')).toBe('image/svg+xml');
    expect(inferImageMimeType('a.webp')).toBe('image/webp');
  });
});

describe('note templates', () => {
  it('fills known variables and leaves unknown ones', () => {
    const now = new Date(2026, 10, 3);
    const result = applyTemplateVariables(
      '# {{title}} / {{ NAME }} on {{date}} #{{number}} {{unknown}}',
      'Sessions/Session 12.md',
      now
    );
    expect(result).toBe('# Session 12 / Session 12 on 2026-11-03 #12 {{unknown}}');
  });
});

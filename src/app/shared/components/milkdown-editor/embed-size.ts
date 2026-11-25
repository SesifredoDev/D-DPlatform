/**
 * Sizes of embeds, kept in the embed's `|…` part like Obsidian:
 *   `![[map.png|300]]`        300px wide
 *   `![[map.png|300x200]]`    300 × 200
 *   `![[Coast.map|x420]]`     420px tall, full width (maps)
 * Anything else in the `|…` part (a caption) isn't a size.
 */
export interface EmbedSize {
  width: number | null;
  height: number | null;
}

export function parseEmbedSize(alias: string | null | undefined): EmbedSize | null {
  const text = (alias ?? '').trim();
  const width = text.match(/^(\d{1,5})$/);
  if (width) return Number(width[1]) > 0 ? { width: Number(width[1]), height: null } : null;
  const both = text.match(/^(\d{0,5})\s*x\s*(\d{1,5})$/i);
  if (!both) return null;
  const size = { width: both[1] ? Number(both[1]) : null, height: Number(both[2]) };
  return (size.width === null || size.width > 0) && size.height > 0 ? size : null;
}

/** The `|…` text for a size ('' when there is none). */
export function formatEmbedSize(size: EmbedSize | null): string {
  if (!size) return '';
  const width = size.width ? Math.round(size.width) : null;
  const height = size.height ? Math.round(size.height) : null;
  if (width && height) return `${width}x${height}`;
  if (height) return `x${height}`;
  return width ? `${width}` : '';
}

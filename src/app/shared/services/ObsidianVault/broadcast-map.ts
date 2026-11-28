/**
 * Interactive maps in broadcasts. A broadcast map travels inside the message as a fenced block:
 *
 *   ```astral-map
 *   {"type":"map","version":1,"title":"Sword Coast","image":"https://…","pins":[…],"layers":[…]}
 *   ```
 *
 * It's a player copy of a vault map (see ObsidianBroadcastService): the image is an uploaded file,
 * GM-only pins are gone, pins carry their names but no note links, and only layers that still have
 * pins are kept. Text channels and the call overlay show it as a map players can pan, zoom and
 * filter by layer (VaultMapComponent in `player` mode); anywhere else it reads as a code block.
 *
 * Pure functions, no Angular.
 */
import { MapPin, VaultMap, parseVaultMap, serializeVaultMap } from './vault-map';

export const BROADCAST_MAP_LANGUAGE = 'astral-map';

const BLOCK = /^(`{3,})astral-map[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;

export type BroadcastContentPart =
  | { kind: 'markdown'; text: string }
  /** `content` is map file text for VaultMapComponent; `title` its name. */
  | { kind: 'map'; title: string; content: string; image: string | null };

/** The fenced block for a player map. */
export function broadcastMapBlock(title: string, map: VaultMap): string {
  const json = JSON.parse(serializeVaultMap(map)) as Record<string, unknown>;
  return `\`\`\`${BROADCAST_MAP_LANGUAGE}\n${JSON.stringify({ ...json, title })}\n\`\`\``;
}

/** A pin as players get it: named, unlinked, never GM-only. */
export function playerPin(pin: MapPin, label: string, icon: string): MapPin {
  return { id: pin.id, x: pin.x, y: pin.y, link: null, label, icon, color: pin.color, size: pin.size, layer: pin.layer, gmOnly: false };
}

/** True when a message holds a broadcast map. */
export function hasBroadcastMap(markdown: string | null | undefined): boolean {
  return !!markdown && markdown.includes(`\`\`\`${BROADCAST_MAP_LANGUAGE}`);
}

/** A message split into Markdown and maps, in order. Blocks that don't read as a map stay Markdown. */
export function splitBroadcastContent(markdown: string): BroadcastContentPart[] {
  if (!hasBroadcastMap(markdown)) return [{ kind: 'markdown', text: markdown }];
  const parts: BroadcastContentPart[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (text.trim()) parts.push({ kind: 'markdown', text });
  };
  for (const match of markdown.matchAll(BLOCK)) {
    const map = readBlock(match[2]);
    if (!map) continue;
    pushText(markdown.slice(last, match.index));
    parts.push(map);
    last = (match.index ?? 0) + match[0].length;
  }
  pushText(markdown.slice(last));
  return parts.length ? parts : [{ kind: 'markdown', text: markdown }];
}

/** Maps written as their image, for places that only show Markdown (session notes). */
export function broadcastMapsAsImages(markdown: string): string {
  if (!hasBroadcastMap(markdown)) return markdown;
  return splitBroadcastContent(markdown)
    .map(part => {
      if (part.kind === 'markdown') return part.text.trim();
      const alt = part.title.replace(/[[\]\r\n]/g, ' ').trim() || 'Map';
      return part.image ? `![${alt}](${part.image})` : `**${alt}**`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function readBlock(text: string): Extract<BroadcastContentPart, { kind: 'map' }> | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const map = parseVaultMap(text);
    const title = typeof data['title'] === 'string' && data['title'].trim() ? data['title'].trim() : 'Map';
    return { kind: 'map', title, content: text, image: map.image };
  } catch {
    return null;
  }
}

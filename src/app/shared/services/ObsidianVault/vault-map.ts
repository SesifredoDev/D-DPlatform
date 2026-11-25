/**
 * Maps: their own file type (`*.map`), a small JSON file holding an image and pins that link to
 * notes or to other maps (nested maps).
 *
 *   {
 *     "type": "map",
 *     "version": 1,
 *     "image": "Maps/sword-coast.jpg",
 *     "size": { "width": 4096, "height": 3072 },
 *     "pins": [{ "id": "…", "x": 0.412, "y": 0.318, "link": "Locations/Waterdeep", "label": "",
 *                "icon": "castle", "color": "#e8a48f", "size": "large", "layer": null, "gmOnly": false }],
 *     "layers": [{ "id": "…", "name": "Cities", "visible": true }]
 *   }
 *
 * `image` is a vault image (path or link text) or a web URL. Pin positions are fractions of the
 * image (0–1), so they stay put if the image is swapped for a bigger copy. `link` is a wikilink
 * target (a note, or another `.map` for a sub-map); `label` overrides the linked note's name.
 * Keys the app doesn't know are kept when the file is rewritten.
 *
 * Pure functions, no Angular. Edits return a new map.
 */
import { getFileExtension } from './vault-file-types';

export type PinSize = 'small' | 'normal' | 'large';

export interface MapPin {
  id: string;
  /** 0–1 across the image. */
  x: number;
  /** 0–1 down the image. */
  y: number;
  /** Wikilink target (note or .map); null for a plain marker. */
  link: string | null;
  /** Shown name; '' means "the linked note's name". */
  label: string;
  icon: string;
  color: string;
  size: PinSize;
  layer: string | null;
  /** GM-only pins are left out when the map is shown to players. */
  gmOnly: boolean;
  [key: string]: unknown;
}

export interface MapLayer {
  id: string;
  name: string;
  visible: boolean;
  [key: string]: unknown;
}

export interface VaultMap {
  image: string | null;
  size: { width: number; height: number } | null;
  pins: MapPin[];
  layers: MapLayer[];
  [key: string]: unknown;
}

/** Map symbols offered for pins (Material icon names). */
export const PIN_ICONS: readonly { icon: string; label: string }[] = [
  { icon: 'location_on', label: 'Place' },
  { icon: 'location_city', label: 'City' },
  { icon: 'castle', label: 'Castle' },
  { icon: 'cottage', label: 'Village' },
  { icon: 'sports_bar', label: 'Tavern' },
  { icon: 'temple_buddhist', label: 'Temple' },
  { icon: 'landscape', label: 'Mountain' },
  { icon: 'forest', label: 'Forest' },
  { icon: 'water', label: 'Water' },
  { icon: 'sailing', label: 'Port' },
  { icon: 'dark_mode', label: 'Cave' },
  { icon: 'skull', label: 'Danger' },
  { icon: 'flag', label: 'Camp' },
  { icon: 'star', label: 'Landmark' },
  { icon: 'person', label: 'Person' },
  { icon: 'help', label: 'Mystery' },
];

export const PIN_COLORS: readonly string[] = ['#e8a48f', '#f2c14e', '#8fe0ad', '#7fc8f8', '#b8a6ff', '#ff8fb1', '#e9eef6'];

const DEFAULT_PIN = { icon: 'location_on', color: PIN_COLORS[0], size: 'normal' as PinSize };
/** Pins linked to another map look like a stack of maps. */
export const SUBMAP_ICON = 'layers';

export function isVaultMapPath(path: string): boolean {
  return getFileExtension(path) === 'map';
}

export function isMapLink(link: string | null | undefined): boolean {
  return !!link && getFileExtension(link.split('#')[0].split('|')[0].trim()) === 'map';
}

export function emptyVaultMap(): string {
  return serializeVaultMap({ image: null, size: null, pins: [], layers: [] });
}

/** Reads a map file. Throws (with a readable message) when it isn't one. */
export function parseVaultMap(text: string): VaultMap {
  if (!text.trim()) return { image: null, size: null, pins: [], layers: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This map file isn’t valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This file isn’t a map.');
  const data = raw as Record<string, unknown>;
  if (data['type'] !== undefined && data['type'] !== 'map') throw new Error('This file isn’t a map.');

  const { type: _type, version: _version, image, size, pins, layers, ...rest } = data;
  const sizeObj = size && typeof size === 'object' ? size as Record<string, unknown> : null;
  const width = Number(sizeObj?.['width']);
  const height = Number(sizeObj?.['height']);
  return {
    ...rest,
    image: typeof image === 'string' && image.trim() ? image.trim() : null,
    size: width > 0 && height > 0 ? { width, height } : null,
    pins: (Array.isArray(pins) ? pins : []).filter(isRecord).map(readPin),
    layers: (Array.isArray(layers) ? layers : []).filter(isRecord).map(layer => ({
      ...layer,
      id: str(layer['id']) || newId(),
      name: str(layer['name']) || 'Layer',
      visible: layer['visible'] !== false,
    })),
  };
}

function readPin(pin: Record<string, unknown>): MapPin {
  const size = pin['size'];
  return {
    ...pin,
    id: str(pin['id']) || newId(),
    x: clamp01(Number(pin['x'])),
    y: clamp01(Number(pin['y'])),
    link: str(pin['link']) || null,
    label: str(pin['label']),
    icon: str(pin['icon']) || DEFAULT_PIN.icon,
    color: str(pin['color']) || DEFAULT_PIN.color,
    size: size === 'small' || size === 'large' ? size : 'normal',
    layer: str(pin['layer']) || null,
    gmOnly: pin['gmOnly'] === true,
  };
}

export function serializeVaultMap(map: VaultMap): string {
  const { image, size, pins, layers, ...rest } = map;
  return `${JSON.stringify({ type: 'map', version: 1, image, size, pins, layers, ...rest }, null, 2)}\n`;
}

// ---- Edits ----

export function addPin(map: VaultMap, pin: Partial<MapPin> & { x: number; y: number }): { map: VaultMap; pin: MapPin } {
  const created: MapPin = {
    ...pin,
    id: newId(),
    x: clamp01(pin.x),
    y: clamp01(pin.y),
    link: pin.link ?? null,
    label: pin.label ?? '',
    icon: pin.icon ?? (isMapLink(pin.link) ? SUBMAP_ICON : DEFAULT_PIN.icon),
    color: pin.color ?? DEFAULT_PIN.color,
    size: pin.size ?? DEFAULT_PIN.size,
    layer: pin.layer ?? null,
    gmOnly: pin.gmOnly ?? false,
  };
  return { map: { ...map, pins: [...map.pins, created] }, pin: created };
}

export function updatePin(map: VaultMap, id: string, changes: Partial<MapPin>): VaultMap {
  return {
    ...map,
    pins: map.pins.map(pin => {
      if (pin.id !== id) return pin;
      const next = { ...pin, ...changes, id: pin.id };
      next.x = clamp01(next.x);
      next.y = clamp01(next.y);
      return next;
    }),
  };
}

export function removePin(map: VaultMap, id: string): VaultMap {
  return { ...map, pins: map.pins.filter(pin => pin.id !== id) };
}

export function addLayer(map: VaultMap, name: string): { map: VaultMap; layer: MapLayer } {
  const layer: MapLayer = { id: newId(), name: name.trim() || 'Layer', visible: true };
  return { map: { ...map, layers: [...map.layers, layer] }, layer };
}

export function updateLayer(map: VaultMap, id: string, changes: Partial<MapLayer>): VaultMap {
  return { ...map, layers: map.layers.map(layer => (layer.id === id ? { ...layer, ...changes, id } : layer)) };
}

/** Removes a layer; its pins stay, without a layer. */
export function removeLayer(map: VaultMap, id: string): VaultMap {
  return {
    ...map,
    layers: map.layers.filter(layer => layer.id !== id),
    pins: map.pins.map(pin => (pin.layer === id ? { ...pin, layer: null } : pin)),
  };
}

/** Pins on visible layers (pins without a layer are always visible). */
export function visiblePins(map: VaultMap, options: { includeGmOnly?: boolean } = {}): MapPin[] {
  const hidden = new Set(map.layers.filter(layer => !layer.visible).map(layer => layer.id));
  return map.pins.filter(pin =>
    (!pin.layer || !hidden.has(pin.layer)) && (options.includeGmOnly !== false || !pin.gmOnly));
}

/**
 * The pin a link anchor points at (`[[Sword Coast.map#Waterdeep]]`): its id, its label, or the
 * name of the note it links to, ignoring case.
 */
export function findPinByAnchor(map: VaultMap, anchor: string): MapPin | null {
  const wanted = anchor.trim().toLowerCase();
  if (!wanted) return null;
  return map.pins.find(pin => pin.id.toLowerCase() === wanted)
    ?? map.pins.find(pin => pin.label.trim().toLowerCase() === wanted)
    ?? map.pins.find(pin => linkName(pin.link).toLowerCase() === wanted)
    ?? null;
}

/** "Locations/Waterdeep.md#Docks|Port" → "Waterdeep"; "Maps/Undermountain.map" → "Undermountain". */
export function linkName(link: string | null): string {
  if (!link) return '';
  const target = link.split('|')[0].split('#')[0].trim();
  const name = target.split('/').pop() ?? target;
  return name.replace(/\.(md|map)$/i, '');
}

// ---- Links (index, renames) ----

export interface MapLinkRef {
  target: string;
  /** "📍 Waterdeep" for pins, "Map image" for the image — shown in backlinks. */
  snippet: string;
  kind: 'pin' | 'image';
}

/** Everything a map links to: its pins and its image (when it's a vault file). */
export function mapLinks(map: VaultMap): MapLinkRef[] {
  const links: MapLinkRef[] = map.pins
    .filter(pin => !!pin.link)
    .map(pin => ({ target: pin.link!, snippet: `📍 ${pin.label || linkName(pin.link)}`, kind: 'pin' as const }));
  if (map.image && !/^https?:\/\//i.test(map.image)) {
    links.push({ target: map.image.replace(/^!?\[\[|\]\]$/g, ''), snippet: 'Map image', kind: 'image' });
  }
  return links;
}

/** Links of a map file's text; [] when it can't be read. */
export function mapLinksFromText(text: string): MapLinkRef[] {
  try {
    return mapLinks(parseVaultMap(text));
  } catch {
    return [];
  }
}

export interface MapRewriteContext {
  mapPath: string;
  resolve: (target: string, fromPath: string) => string | null;
  /** Moved files: lower-cased old path → new path. */
  moved: Map<string, string>;
  linkTextFor: (newPath: string, originalTarget: string) => string;
}

/** After files moved: points pins (and the image) at their new paths, keeping `#anchors`. */
export function rewriteMapLinks(text: string, ctx: MapRewriteContext): { content: string; count: number } {
  let map: VaultMap;
  try {
    map = parseVaultMap(text);
  } catch {
    return { content: text, count: 0 };
  }

  let count = 0;
  const rewrite = (link: string): string => {
    const [targetPart, ...anchor] = link.split('#');
    const target = targetPart.trim();
    const resolved = ctx.resolve(target, ctx.mapPath);
    const moved = resolved ? ctx.moved.get(resolved.toLowerCase()) : undefined;
    if (!moved) return link;
    count++;
    const text = ctx.linkTextFor(moved, target);
    return anchor.length ? `${text}#${anchor.join('#')}` : text;
  };

  const pins = map.pins.map(pin => (pin.link ? { ...pin, link: rewrite(pin.link) } : pin));
  const image = map.image && !/^https?:\/\//i.test(map.image) ? rewrite(map.image.replace(/^!?\[\[|\]\]$/g, '')) : map.image;
  if (!count) return { content: text, count: 0 };
  return { content: serializeVaultMap({ ...map, pins, image }), count };
}

// ---- Helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

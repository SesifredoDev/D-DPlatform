/**
 * Pictures for broadcasts: map images scaled down to what players need, and family trees drawn
 * with their portraits. Only what the caller passes in is drawn: the broadcast service leaves out
 * secret people beforehand.
 */
import type { FamilyTree, PersonPosition } from './family-tree';
import { PERSON_HEIGHT, PERSON_WIDTH } from './family-tree';

/** Longest side of a map copy; bigger images are scaled down. */
const MAP_MAX_SIDE = 2400;
/** Largest side of a rendered family tree. */
const TREE_MAX_SIDE = 8000;

const COLORS = {
  background: '#1e1f22',
  card: '#2b2d35',
  cardBorder: '#4b5170',
  name: '#f2f3f5',
  details: '#b5bac1',
  line: '#8d93a8',
};

/**
 * The map image as a JPEG no bigger than players need. Null when the image can't be read (or is a
 * web image that doesn't allow being copied).
 */
export async function renderMapImage(source: Blob | string): Promise<Blob | null> {
  const image = await loadImage(source);
  if (!image) return null;
  const scale = Math.min(1, MAP_MAX_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const { canvas, ctx } = createCanvas(width, height);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image.source, 0, 0, width, height);
  image.close();
  return toBlob(canvas, 'image/jpeg', 0.9);
}

/** Portraits are drawn from this small a picture: enough to recognise someone, cheap to send. */
const PORTRAIT_SOURCE_SIZE = 64;
/** Portrait circle on a card, as in the family tree view. */
const PORTRAIT_CX = 38;
const PORTRAIT_RADIUS = 27;
const PORTRAIT_TEXT_X = 74;

/**
 * The family tree as a PNG: a card per person (with their portrait, if they have one), lines to
 * their children and between spouses. `portraits` are image files by person id.
 */
export async function renderFamilyTreeImage(
  tree: FamilyTree,
  positions: Map<string, PersonPosition>,
  portraits: Map<string, Blob> = new Map()
): Promise<Blob | null> {
  if (!tree.people.length) return null;
  const pictures = new Map<string, ImageBitmap>();
  await Promise.all(Array.from(portraits.entries()).map(async ([id, blob]) => {
    const picture = await lowResPortrait(blob);
    if (picture) pictures.set(id, picture);
  }));

  const padding = 48;
  const xs = tree.people.map(person => positions.get(person.id)?.x ?? 0);
  const ys = tree.people.map(person => positions.get(person.id)?.y ?? 0);
  const contentWidth = Math.max(...xs) + PERSON_WIDTH + padding * 2;
  const contentHeight = Math.max(...ys) + PERSON_HEIGHT + padding * 2;
  const scale = Math.min(2, TREE_MAX_SIDE / Math.max(contentWidth, contentHeight));
  const { canvas, ctx } = createCanvas(Math.round(contentWidth * scale), Math.round(contentHeight * scale));
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, contentWidth, contentHeight);
  ctx.translate(padding, padding);

  const at = (id: string) => positions.get(id) ?? { x: 0, y: 0, generation: 0 };
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  // Spouses: a line between their cards.
  for (const relation of tree.relations) {
    if (relation.kind !== 'spouse') continue;
    const [left, right] = [at(relation.from), at(relation.to)].sort((a, b) => a.x - b.x);
    const y = left.y + PERSON_HEIGHT / 2;
    line(ctx, [[left.x + PERSON_WIDTH, y], [right.x, right.y + PERSON_HEIGHT / 2]]);
  }

  // Children: from their parents (the middle of a couple) down to a bar, then down to each child.
  const families = new Map<string, { parents: string[]; children: string[] }>();
  for (const person of tree.people) {
    const parents = tree.relations.filter(r => r.kind === 'parent' && r.to === person.id).map(r => r.from).sort();
    if (!parents.length) continue;
    const key = parents.join('\u0000');
    const family = families.get(key) ?? { parents, children: [] };
    family.children.push(person.id);
    families.set(key, family);
  }
  for (const { parents, children } of families.values()) {
    const parentPositions = parents.map(at);
    const startX = parentPositions.reduce((sum, p) => sum + p.x + PERSON_WIDTH / 2, 0) / parentPositions.length;
    const startY = parentPositions.length > 1
      ? Math.max(...parentPositions.map(p => p.y)) + PERSON_HEIGHT / 2
      : parentPositions[0].y + PERSON_HEIGHT;
    const childTop = Math.min(...children.map(id => at(id).y));
    const barY = startY + (childTop - startY) / 2;
    line(ctx, [[startX, startY], [startX, barY]]);
    const childXs = children.map(id => at(id).x + PERSON_WIDTH / 2);
    line(ctx, [[Math.min(startX, ...childXs), barY], [Math.max(startX, ...childXs), barY]]);
    for (const id of children) line(ctx, [[at(id).x + PERSON_WIDTH / 2, barY], [at(id).x + PERSON_WIDTH / 2, at(id).y]]);
  }

  for (const person of tree.people) {
    const { x, y } = at(person.id);
    roundedRect(ctx, x, y, PERSON_WIDTH, PERSON_HEIGHT, 10);
    ctx.fillStyle = COLORS.card;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.stroke();

    const picture = pictures.get(person.id);
    if (picture) drawPortrait(ctx, picture, x + PORTRAIT_CX, y + PERSON_HEIGHT / 2);

    // Beside the portrait, or centred on cards without one.
    const textX = picture ? x + PORTRAIT_TEXT_X : x + PERSON_WIDTH / 2;
    const textWidth = picture ? PERSON_WIDTH - PORTRAIT_TEXT_X - 12 : PERSON_WIDTH - 24;
    ctx.textAlign = picture ? 'left' : 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.name;
    ctx.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif';
    const nameY = person.details ? y + PERSON_HEIGHT / 2 - 10 : y + PERSON_HEIGHT / 2;
    ctx.fillText(fit(ctx, person.name, textWidth), textX, nameY);
    if (person.details) {
      ctx.fillStyle = COLORS.details;
      ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(fit(ctx, person.details, textWidth), textX, y + PERSON_HEIGHT / 2 + 12);
    }
  }
  pictures.forEach(picture => picture.close());
  return toBlob(canvas, 'image/png');
}

/** A square, centre-cropped, low-resolution copy of a picture; null if it can't be read. */
async function lowResPortrait(blob: Blob): Promise<ImageBitmap | null> {
  try {
    const full = await createImageBitmap(blob);
    const side = Math.min(full.width, full.height);
    try {
      return await createImageBitmap(full, (full.width - side) / 2, (full.height - side) / 2, side, side, {
        resizeWidth: PORTRAIT_SOURCE_SIZE,
        resizeHeight: PORTRAIT_SOURCE_SIZE,
        resizeQuality: 'medium',
      });
    } finally {
      full.close();
    }
  } catch {
    return null;
  }
}

function drawPortrait(ctx: CanvasRenderingContext2D, picture: ImageBitmap, cx: number, cy: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, PORTRAIT_RADIUS, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(picture, cx - PORTRAIT_RADIUS, cy - PORTRAIT_RADIUS, PORTRAIT_RADIUS * 2, PORTRAIT_RADIUS * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, PORTRAIT_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = COLORS.cardBorder;
  ctx.stroke();
}

// ---- Drawing helpers ----

function line(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** The text, shortened with an ellipsis to fit `maxWidth`. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Drawing isn’t available in this browser.');
  return { canvas, ctx };
}

/** Null when the canvas can't be exported (a web image without CORS taints it). */
function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(blob => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function loadImage(source: Blob | string): Promise<LoadedImage | null> {
  try {
    if (source instanceof Blob) {
      const bitmap = await createImageBitmap(source);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = source;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } catch {
    return null;
  }
}

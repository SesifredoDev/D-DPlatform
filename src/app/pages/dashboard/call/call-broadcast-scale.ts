/**
 * How big a broadcast image or video shows on the call: a share of the space the overlay has
 * (25–100 %). Drag the corner handle, use − / + (or the arrow keys on the handle), or
 * double-click the handle to fill the space again. Each viewer's size is their own, and is kept
 * for the next image or video (per kind) on this device.
 */
export type BroadcastScaleKind = 'image' | 'video';

export const BROADCAST_SCALE_MIN = 0.25;
export const BROADCAST_SCALE_MAX = 1;
const STEP = 0.1;
const STORAGE_PREFIX = 'call-broadcast-scale:';

export function clampBroadcastScale(value: number): number {
  if (!Number.isFinite(value)) return BROADCAST_SCALE_MAX;
  return Math.min(BROADCAST_SCALE_MAX, Math.max(BROADCAST_SCALE_MIN, Math.round(value * 100) / 100));
}

function load(kind: BroadcastScaleKind): number {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + kind);
    return stored === null ? BROADCAST_SCALE_MAX : clampBroadcastScale(Number(stored));
  } catch {
    return BROADCAST_SCALE_MAX;
  }
}

function save(kind: BroadcastScaleKind, value: number): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + kind, String(value));
  } catch {
    // Storage unavailable (private window): the size just isn't remembered.
  }
}

export class BroadcastScale {
  value: number;
  resizing = false;
  private pointerId: number | null = null;
  private area: DOMRect | null = null;

  constructor(private readonly kind: BroadcastScaleKind) {
    this.value = load(kind);
  }

  get percent(): number {
    return Math.round(this.value * 100);
  }

  get canShrink(): boolean {
    return this.value > BROADCAST_SCALE_MIN;
  }

  get canGrow(): boolean {
    return this.value < BROADCAST_SCALE_MAX;
  }

  set(value: number, persist = true): void {
    this.value = clampBroadcastScale(value);
    if (persist) save(this.kind, this.value);
  }

  shrink(): void {
    this.set(this.value - STEP);
  }

  grow(): void {
    this.set(this.value + STEP);
  }

  reset(): void {
    this.set(BROADCAST_SCALE_MAX);
  }

  /** Starts a corner drag. The overlay centres the media, so the corner follows the pointer. */
  onHandlePointerDown(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement | null;
    const area = handle?.closest('.broadcast-overlay') as HTMLElement | null;
    if (!handle || !area || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.area = area.getBoundingClientRect();
    this.pointerId = event.pointerId;
    this.resizing = true;
    handle.setPointerCapture(event.pointerId);
  }

  onHandlePointerMove(event: PointerEvent): void {
    if (!this.resizing || event.pointerId !== this.pointerId || !this.area) return;
    const { left, top, width, height } = this.area;
    const fromCentreX = Math.abs(event.clientX - (left + width / 2)) * 2 / width;
    const fromCentreY = Math.abs(event.clientY - (top + height / 2)) * 2 / height;
    this.set(Math.max(fromCentreX, fromCentreY), false);
  }

  onHandlePointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    this.resizing = false;
    this.pointerId = null;
    this.area = null;
    save(this.kind, this.value);
  }

  onHandleKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === '+' || event.key === '=') {
      this.grow();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === '-') {
      this.shrink();
    } else if (event.key === 'Home' || event.key === 'Enter') {
      this.reset();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}

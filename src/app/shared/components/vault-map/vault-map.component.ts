import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { MapLibraryEntry } from '../../models/vttsync/vttsync.model';
import { NoteInsertService } from '../../services/ObsidianVault/note-insert.service';
import { findNoteTemplate, loadNoteTemplate } from '../../services/ObsidianVault/note-templates';
import { ObsidianVaultService, VaultEntry } from '../../services/ObsidianVault/obsidian-vault-service';
import { splitFrontmatter } from '../../services/ObsidianVault/frontmatter';
import { VaultIndex, VaultIndexService } from '../../services/ObsidianVault/vault-index.service';
import { getFileExtension, getVaultDisplayName, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import {
  MapLayer,
  MapPin,
  PIN_COLORS,
  PIN_ICONS,
  PinSize,
  SUBMAP_ICON,
  VaultMap,
  addLayer,
  addPin,
  findPinByAnchor,
  isMapLink,
  linkName,
  parseVaultMap,
  removePin,
  serializeVaultMap,
  removeLayer,
  updateLayer,
  updatePin,
  visiblePins,
} from '../../services/ObsidianVault/vault-map';
import { VttSync } from '../../services/vttsync/vttsync';
import type { EmbedSize } from '../milkdown-editor/embed-size';
import { VaultImageService } from '../../services/ObsidianVault/vault-image.service';

/** A pin as drawn: where it is on screen and what it links to. */
interface PinView {
  pin: MapPin;
  left: number;
  top: number;
  title: string;
  /** The linked file, when the link resolves. */
  entry: VaultEntry | null;
  isSubmap: boolean;
  missing: boolean;
  showLabel: boolean;
}

/** The card shown when a pin is clicked. */
interface PinCard {
  pinId: string;
  loading: boolean;
  excerpt: string;
  kindLabel: string;
}

interface LinkSuggestion {
  entry: VaultEntry;
  title: string;
  folder: string;
  icon: string;
}

type ImageSource = 'vault' | 'upload' | 'vtt';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
/** Embedded maps: default and allowed heights / widths (px). */
const EMBED_DEFAULT_HEIGHT = 380;
const EMBED_MIN_HEIGHT = 180;
const EMBED_MAX_HEIGHT = 1400;
const EMBED_MIN_WIDTH = 260;
/** Thumbnails shown at once in "Choose from vault"; type to narrow the rest. */
const PICKER_LIMIT = 60;

/**
 * A map file (see vault-map.ts): an image with pins linking to notes and other maps.
 *
 * `file` mode is the map open in the vault (view, or Edit to place, drag and edit pins).
 * `embed` mode is `![[Map.map]]` inside a note: pan, zoom and pin cards, read only.
 * Hovering a pin asks the host for its usual link preview (`linkHover`); clicking one opens a card.
 */
@Component({
  selector: 'app-vault-map',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './vault-map.component.html',
  styleUrl: './vault-map.component.scss',
})
export class VaultMapComponent implements OnChanges, AfterViewInit, OnDestroy {
  /** The map file's text. */
  @Input() content: string | null = null;
  @Input() path = '';
  @Input() serverId = '';
  @Input() readonly = false;
  /**
   * `file`: the map's own view. `embed`: `![[X.map]]` in a note. `player`: a broadcast map (see
   * broadcast-map.ts) — no vault, pins only show their name, players pick the layers they see.
   */
  @Input() mode: 'file' | 'embed' | 'player' = 'file';
  /** Embeds and player maps: zoom with a plain scroll (not just Ctrl + scroll), where the page doesn't scroll. */
  @Input() wheelZoom = false;
  /** Fly to a pin (from `[[Map.map#Pin]]` links); a new token re-runs it. */
  @Input() focus: { anchor: string; token: number } | null = null;

  @Output() contentChange = new EventEmitter<string>();
  /** A vault path (optionally `#pin`) to open. */
  @Output() openFile = new EventEmitter<string>();
  /** The pointer entered (or left, with null) a pin: show the usual link preview. */
  @Output() linkHover = new EventEmitter<{ target: string; rect: DOMRect } | null>();
  /** An image was saved into the vault, so the file list should be refreshed. */
  @Output() filesAdded = new EventEmitter<void>();

  /** Embeds: the size saved in the embed (`![[Coast.map|x420]]`); null for the default. */
  @Input() embedSize: EmbedSize | null = null;
  /** Embeds: show resize handles (the note is editable). */
  @Input() resizable = false;
  /** Embeds: the user resized the embed (null = back to the default size). */
  @Output() embedResize = new EventEmitter<EmbedSize | null>();

  /** The size while a resize handle is being dragged (shown before it's saved). */
  liveSize: EmbedSize | null = null;
  private resizeDrag: { id: number; axis: 'y' | 'both'; startX: number; startY: number; width: number; height: number; full: number } | null = null;

  @ViewChild('viewport') private viewportRef?: ElementRef<HTMLElement>;
  /** Focuses (and selects) a layer's name when renaming starts. */
  @ViewChild('layerNameInput') private set layerNameInput(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref) setTimeout(() => ref.nativeElement.select());
  }
  @ViewChild('linkInput') private set linkInput(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref && this.focusLinkInput) {
      this.focusLinkInput = false;
      setTimeout(() => ref.nativeElement.focus());
    }
  }

  readonly icons = PIN_ICONS;
  readonly linkName = linkName;
  readonly colors = PIN_COLORS;
  readonly sizes: { value: PinSize; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'normal', label: 'Normal' },
    { value: 'large', label: 'Large' },
  ];

  map: VaultMap = { image: null, size: null, pins: [], layers: [] };
  parseError: string | null = null;
  pins: PinView[] = [];

  transform = { k: 1, x: 0, y: 0 };
  imageUrl = '';
  imageFailed = false;
  /** Natural image size, from the file or the loaded image. */
  natural: { width: number; height: number } | null = null;

  editing = false;
  addingPin = false;
  selectedPinId: string | null = null;
  hoveredPinId: string | null = null;
  card: PinCard | null = null;
  panelOpen = true;
  pinQuery = '';

  linkQuery = '';
  linkSuggestions: LinkSuggestion[] = [];
  newNoteFolder: string | null = null;
  newNoteFolders: string[] = [];
  useLocationTemplate = true;
  creatingNote = false;
  newLayerName = '';
  /** The layer being renamed, and its name as typed. */
  renamingLayerId: string | null = null;
  layerNameDraft = '';

  /** Image picker (empty state and ⋯ → Change image). */
  pickingImage = false;
  imageSource: ImageSource = 'vault';
  pickerQuery = '';
  pickerImages: VaultEntry[] = [];
  pickerTotal = 0;
  thumbUrls: Record<string, string> = {};
  vttMaps: { id: string; name: string; url: string }[] = [];
  vttMapsLoading = false;
  uploading = false;

  /** Parent maps (maps with a pin linking here), nearest last. */
  breadcrumbs: { path: string; title: string }[] = [];
  /** Embeds only zoom with Ctrl + wheel; a hint says so when plain scrolling happens. */
  showZoomHint = false;

  private lastEmitted: string | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture:
    | { kind: 'pan'; id: number; startX: number; startY: number; tx: number; ty: number; moved: boolean }
    | { kind: 'pin'; id: number; pinId: string; startX: number; startY: number; moved: boolean; x: number; y: number }
    | { kind: 'pinch'; distance: number; k: number }
    | null = null;
  private needsFit = true;
  private pendingFocus: string | null = null;
  private imageObjectUrl = '';
  private pickerQueryTimer?: ReturnType<typeof setTimeout>;
  private resizeObserver?: ResizeObserver;
  private zoomHintTimer?: ReturnType<typeof setTimeout>;
  private focusLinkInput = false;
  private undo: VaultMap | null = null;

  constructor(
    private host: ElementRef<HTMLElement>,
    private snackBar: MatSnackBar,
    private vaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private noteInsert: NoteInsertService,
    private vttSync: VttSync,
    private vaultImages: VaultImageService
  ) {}

  // ---- Lifecycle ----

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['embedSize']) this.liveSize = null;
    // Another map opened in this same view (e.g. a sub-map, then back to its parent): start over.
    // Without this, a parent whose text happens to equal what this view last saved for it would be
    // skipped below, leaving the previous map on screen.
    const pathChanged = !!changes['path'] && !changes['path'].firstChange;
    if (pathChanged) {
      this.lastEmitted = null;
      this.map = { image: null, size: null, pins: [], layers: [] };
      this.natural = null;
      this.needsFit = true;
      this.selectedPinId = null;
      this.hoveredPinId = null;
      this.card = null;
      this.addingPin = false;
      this.pickingImage = false;
      this.undo = null;
      this.linkHover.emit(null);
    }
    if ((changes['content'] || pathChanged) && this.content !== this.lastEmitted) {
      this.load(this.content ?? '');
    }
    if (changes['readonly'] && this.readonly) {
      this.editing = false;
      this.addingPin = false;
    }
    if (changes['focus'] && this.focus?.anchor) {
      this.pendingFocus = this.focus.anchor;
      this.applyPendingFocus();
    }
    if (changes['path'] || changes['serverId']) this.updateBreadcrumbs();
  }

  ngAfterViewInit(): void {
    const viewport = this.viewportRef?.nativeElement;
    if (viewport && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.needsFit) this.fit();
        else this.layoutPins();
      });
      this.resizeObserver.observe(viewport);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.revokeImage();
    // Thumbnails are shared and cached by VaultImageService: not ours to revoke.
    if (this.pickerQueryTimer) clearTimeout(this.pickerQueryTimer);
    if (this.zoomHintTimer) clearTimeout(this.zoomHintTimer);
    this.linkHover.emit(null);
  }

  private load(text: string): void {
    try {
      const map = parseVaultMap(text);
      const imageChanged = map.image !== this.map.image;
      this.map = map;
      this.parseError = null;
      if (map.size) this.natural = map.size;
      if (imageChanged) this.loadImage();
      if (this.selectedPinId && !map.pins.some(pin => pin.id === this.selectedPinId)) this.selectedPinId = null;
      this.layoutPins();
      if (this.needsFit) setTimeout(() => this.fit());
    } catch (error) {
      this.parseError = error instanceof Error ? error.message : 'This map can’t be read.';
    }
  }

  private commit(map: VaultMap, options: { undoable?: boolean } = {}): void {
    if (this.readonly || this.parseError) return;
    if (options.undoable) this.undo = this.map;
    this.map = map;
    const text = serializeVaultMap(map);
    this.lastEmitted = text;
    this.contentChange.emit(text);
    this.layoutPins();
  }

  get index(): VaultIndex | null {
    return this.serverId ? this.vaultIndexService.get(this.serverId) : null;
  }

  get canEdit(): boolean {
    return this.mode === 'file' && !this.readonly && !this.parseError;
  }

  get title(): string {
    return getVaultDisplayName(this.path.split('/').pop() || this.path);
  }

  get selectedPin(): MapPin | null {
    return this.map.pins.find(pin => pin.id === this.selectedPinId) ?? null;
  }

  get cardPin(): PinView | null {
    return this.card ? this.pins.find(view => view.pin.id === this.card!.pinId) ?? null : null;
  }

  // ---- Image ----

  private async loadImage(): Promise<void> {
    this.revokeImage();
    this.imageUrl = '';
    this.imageFailed = false;
    const ref = this.map.image;
    if (!ref) return;
    // Player maps come with the uploaded image's URL; there's no vault to read from.
    if (/^https?:\/\//i.test(ref) || this.mode === 'player') {
      this.imageUrl = ref;
      return;
    }
    const path = this.resolveImagePath(ref);
    if (!path || !this.serverId) {
      this.imageFailed = true;
      return;
    }
    try {
      const blob = await this.vaultService.readFileAsBlob(this.serverId, path);
      if (this.map.image !== ref) return;
      this.imageObjectUrl = URL.createObjectURL(blob);
      this.imageUrl = this.imageObjectUrl;
    } catch {
      this.imageFailed = true;
    }
  }

  private resolveImagePath(ref: string): string | null {
    const text = ref.replace(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/, '$1').trim();
    const entry = this.index?.resolveFile(text, this.path) ?? this.index?.resolveLink(text, this.path) ?? null;
    if (entry?.kind === 'file' && getVaultFileType(entry.name).viewer === 'image') return entry.relativePath;
    return getVaultFileType(text).viewer === 'image' ? text.replace(/^\/+/, '') : null;
  }

  private revokeImage(): void {
    if (this.imageObjectUrl) URL.revokeObjectURL(this.imageObjectUrl);
    this.imageObjectUrl = '';
  }

  /** Records the image's real size (so pins can be laid out before it loads next time). */
  onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    const size = { width: img.naturalWidth, height: img.naturalHeight };
    if (!size.width || !size.height) return;
    const changed = !this.natural || this.natural.width !== size.width || this.natural.height !== size.height;
    this.natural = size;
    if (changed) {
      this.needsFit = true;
      this.fit();
      if (this.canEdit && (this.map.size?.width !== size.width || this.map.size?.height !== size.height)) {
        this.commit({ ...this.map, size });
      }
    }
  }

  onImageError(): void {
    this.imageFailed = true;
  }

  // ---- Layout ----

  /** Recomputes where pins sit on screen (they don't scale with the map). */
  layoutPins(): void {
    const size = this.natural;
    const index = this.index;
    const shown = visiblePins(this.map);
    const displayed = size ? size.width * this.transform.k : 0;
    this.pins = shown.map(pin => {
      const entry = pin.link ? this.resolvePinLink(pin.link, index) : null;
      const isSubmap = isMapLink(pin.link);
      const title = pin.label || (entry ? getVaultDisplayName(entry.name) : linkName(pin.link)) || 'Marker';
      const important = pin.size === 'large';
      const roomy = pin.size === 'small' ? displayed > 2200 : displayed > 1000;
      return {
        pin,
        left: size ? this.transform.x + pin.x * size.width * this.transform.k : 0,
        top: size ? this.transform.y + pin.y * size.height * this.transform.k : 0,
        title,
        entry,
        isSubmap,
        missing: !!pin.link && !entry && !!index,
        showLabel: important || roomy,
      };
    });
  }

  private resolvePinLink(link: string, index: VaultIndex | null): VaultEntry | null {
    const entry = index?.resolveLink(link, this.path) ?? null;
    return entry?.kind === 'file' ? entry : null;
  }

  trackPin(_: number, view: PinView): string {
    return view.pin.id;
  }

  pinIcon(view: PinView): string {
    return view.isSubmap && view.pin.icon === 'location_on' ? SUBMAP_ICON : view.pin.icon;
  }

  get filteredPins(): PinView[] {
    const q = this.pinQuery.trim().toLowerCase();
    const all = this.allPinViews();
    return q ? all.filter(view => view.title.toLowerCase().includes(q)) : all;
  }

  /** Every pin (also those on hidden layers), for the pins list. */
  allPinViews(): PinView[] {
    const index = this.index;
    return this.map.pins
      .map(pin => {
        const entry = pin.link ? this.resolvePinLink(pin.link, index) : null;
        return {
          pin,
          left: 0,
          top: 0,
          title: pin.label || (entry ? getVaultDisplayName(entry.name) : linkName(pin.link)) || 'Marker',
          entry,
          isSubmap: isMapLink(pin.link),
          missing: !!pin.link && !entry && !!index,
          showLabel: true,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  layerName(id: string | null): string {
    return this.map.layers.find(layer => layer.id === id)?.name ?? '';
  }

  // ---- Embed size ----

  get embedHeight(): number {
    return this.liveSize?.height ?? this.embedSize?.height ?? EMBED_DEFAULT_HEIGHT;
  }

  /** Embed width in px, or null for full width. */
  get embedWidth(): number | null {
    return this.liveSize ? this.liveSize.width : this.embedSize?.width ?? null;
  }

  /** The width an embed can grow to: the note's text column. */
  private availableWidth(): number {
    const host = this.host.nativeElement;
    return host.parentElement?.clientWidth || host.clientWidth || 800;
  }

  onResizeStart(event: PointerEvent, axis: 'y' | 'both'): void {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const root = this.host.nativeElement.querySelector<HTMLElement>('.vmap');
    const rect = root?.getBoundingClientRect();
    this.resizeDrag = {
      id: event.pointerId,
      axis,
      startX: event.clientX,
      startY: event.clientY,
      width: rect?.width ?? this.availableWidth(),
      height: rect?.height ?? this.embedHeight,
      full: this.availableWidth(),
    };
  }

  onResizeMove(event: PointerEvent): void {
    const drag = this.resizeDrag;
    if (!drag || drag.id !== event.pointerId) return;
    const height = clamp(drag.height + event.clientY - drag.startY, EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT);
    let width = this.embedWidth;
    if (drag.axis === 'both') {
      const next = clamp(drag.width + event.clientX - drag.startX, EMBED_MIN_WIDTH, drag.full);
      // Within a few px of the full column counts as full width (stays responsive).
      width = next >= drag.full - 12 ? null : Math.round(next);
    }
    this.liveSize = { width, height: Math.round(height) };
  }

  onResizeEnd(event: PointerEvent): void {
    const drag = this.resizeDrag;
    if (!drag || drag.id !== event.pointerId) return;
    this.resizeDrag = null;
    if (this.liveSize) this.embedResize.emit(this.liveSize);
    this.layoutPins();
  }

  /** Double-click a handle: back to the default size. */
  resetEmbedSize(): void {
    this.liveSize = null;
    this.embedResize.emit(null);
  }

  /** Arrow keys on a focused handle resize in 20px steps (Shift: 100px). */
  onResizeKey(event: KeyboardEvent, axis: 'y' | 'both'): void {
    const step = event.shiftKey ? 100 : 20;
    let height = this.embedHeight;
    let width = this.embedWidth;
    const full = this.availableWidth();
    switch (event.key) {
      case 'ArrowUp': height -= step; break;
      case 'ArrowDown': height += step; break;
      case 'ArrowLeft':
        if (axis !== 'both') return;
        width = Math.max(EMBED_MIN_WIDTH, (width ?? full) - step);
        break;
      case 'ArrowRight':
        if (axis !== 'both') return;
        width = (width ?? full) + step >= full - 12 ? null : (width ?? full) + step;
        break;
      case 'Enter':
      case 'Escape':
        return;
      default:
        return;
    }
    event.preventDefault();
    this.liveSize = { width, height: clamp(height, EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT) };
    this.embedResize.emit(this.liveSize);
  }

  // ---- Pan and zoom ----

  get layerTransform(): string {
    return `translate(${this.transform.x}px, ${this.transform.y}px) scale(${this.transform.k})`;
  }

  fit(): void {
    const viewport = this.viewportRef?.nativeElement;
    const size = this.natural;
    if (!viewport || !size || !viewport.clientWidth) return;
    const padding = this.mode === 'file' ? 24 : 8;
    const k = clamp(
      Math.min((viewport.clientWidth - padding * 2) / size.width, (viewport.clientHeight - padding * 2) / size.height),
      MIN_ZOOM,
      MAX_ZOOM
    );
    this.transform = { k, x: (viewport.clientWidth - size.width * k) / 2, y: (viewport.clientHeight - size.height * k) / 2 };
    this.needsFit = false;
    this.layoutPins();
    this.applyPendingFocus();
  }

  zoomBy(factor: number): void {
    const viewport = this.viewportRef?.nativeElement;
    if (viewport) this.zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const { k, x, y } = this.transform;
    const next = clamp(k * factor, MIN_ZOOM, MAX_ZOOM);
    this.transform = { k: next, x: sx - ((sx - x) / k) * next, y: sy - ((sy - y) / k) * next };
    this.needsFit = false;
    this.layoutPins();
  }

  /** Centres a pin (and zooms in if the map is shown small). */
  flyToPin(pin: MapPin, options: { select?: boolean } = {}): void {
    const viewport = this.viewportRef?.nativeElement;
    const size = this.natural;
    if (!viewport || !size) return;
    const k = Math.max(this.transform.k, Math.min(1, (viewport.clientWidth * 1.6) / size.width));
    this.transform = {
      k,
      x: viewport.clientWidth / 2 - pin.x * size.width * k,
      y: viewport.clientHeight / 2 - pin.y * size.height * k,
    };
    this.needsFit = false;
    this.layoutPins();
    if (options.select) this.openCard(pin.id);
  }

  private applyPendingFocus(): void {
    if (!this.pendingFocus || !this.natural || !this.viewportRef || this.parseError) return;
    const pin = findPinByAnchor(this.map, this.pendingFocus);
    this.pendingFocus = null;
    if (pin) setTimeout(() => this.flyToPin(pin, { select: true }));
  }

  onWheel(event: WheelEvent): void {
    // In a note, plain scrolling scrolls the note; Ctrl + wheel zooms the map.
    if (this.mode !== 'file' && !this.wheelZoom && !event.ctrlKey && !event.metaKey) {
      this.flashZoomHint();
      return;
    }
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
  }

  private flashZoomHint(): void {
    this.showZoomHint = true;
    if (this.zoomHintTimer) clearTimeout(this.zoomHintTimer);
    this.zoomHintTimer = setTimeout(() => (this.showZoomHint = false), 1400);
  }

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const target = event.target as Element;
    if (target.closest('.pin-card, .map-panel, .map-toolbar, .zoom-controls, button:not(.pin), input, select, textarea')) return;

    const pinElement = target.closest<HTMLElement>('.pin');
    const pin = pinElement ? this.map.pins.find(item => item.id === pinElement.dataset['pin']) : null;
    // Viewing: a pin tap is an ordinary click (see onPinClick); it never pans.
    if (pin && !this.editing) return;

    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    if (this.pointers.size === 2) {
      const [a, b] = Array.from(this.pointers.values());
      this.gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), k: this.transform.k };
      return;
    }

    if (pin) {
      this.gesture = { kind: 'pin', id: event.pointerId, pinId: pin.id, startX: event.clientX, startY: event.clientY, moved: false, x: pin.x, y: pin.y };
      return;
    }
    this.gesture = {
      kind: 'pan', id: event.pointerId, startX: event.clientX, startY: event.clientY,
      tx: this.transform.x, ty: this.transform.y, moved: false,
    };
  }

  /**
   * Pressing on the map (not on a control) must not start the browser's own drag or text selection:
   * either would take over from panning. (Cancelling pointerdown alone doesn't stop a native drag.)
   */
  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('.pin-card, .map-panel, .map-toolbar, .zoom-controls, input, select, textarea, label')) return;
    event.preventDefault();
    // preventDefault also stops the viewport taking focus; keep keyboard shortcuts working.
    this.viewportRef?.nativeElement.focus({ preventScroll: true });
  }

  onPointerMove(event: PointerEvent): void {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = this.gesture;
    if (!gesture) return;

    if (gesture.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = Array.from(this.pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = this.viewportRef!.nativeElement.getBoundingClientRect();
      const factor = (gesture.k * (distance / gesture.distance)) / this.transform.k;
      this.zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, factor);
      return;
    }
    if (gesture.kind === 'pinch' || gesture.id !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;

    if (gesture.kind === 'pan') {
      this.transform = { ...this.transform, x: gesture.tx + dx, y: gesture.ty + dy };
      this.layoutPins();
    } else if (this.natural) {
      // Dragging a pin: move it locally; written once on release.
      const x = gesture.x + dx / (this.natural.width * this.transform.k);
      const y = gesture.y + dy / (this.natural.height * this.transform.k);
      this.map = updatePin(this.map, gesture.pinId, { x, y });
      this.layoutPins();
    }
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (gesture?.kind === 'pinch') {
      if (this.pointers.size < 2) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (!gesture || gesture.id !== event.pointerId) return;

    if (gesture.kind === 'pin') {
      if (gesture.moved) {
        const pin = this.map.pins.find(item => item.id === gesture.pinId);
        if (pin) this.commit(this.map);
      } else {
        this.selectPin(gesture.pinId);
      }
      return;
    }

    if (!gesture.moved) this.onBackgroundClick(event);
  }

  private onBackgroundClick(event: PointerEvent): void {
    if (this.addingPin) {
      this.placePinAt(event.clientX, event.clientY);
      return;
    }
    this.card = null;
    if (this.editing) this.selectedPinId = null;
  }

  onDoubleClick(event: MouseEvent): void {
    if (!this.editing || (event.target as Element).closest('.pin, .pin-card, .map-panel, .map-toolbar, .zoom-controls')) return;
    this.placePinAt(event.clientX, event.clientY);
  }

  onViewportKeydown(event: KeyboardEvent): void {
    if ((event.target as Element).closest('input, textarea, select')) return;
    const pan = 80;
    switch (event.key) {
      case '+':
      case '=': this.zoomBy(1.25); break;
      case '-': this.zoomBy(0.8); break;
      case '0': this.fit(); break;
      case 'ArrowLeft': this.nudgeOrPan(event, -1, 0, pan); break;
      case 'ArrowRight': this.nudgeOrPan(event, 1, 0, pan); break;
      case 'ArrowUp': this.nudgeOrPan(event, 0, -1, pan); break;
      case 'ArrowDown': this.nudgeOrPan(event, 0, 1, pan); break;
      case 'Escape':
        if (this.addingPin) this.addingPin = false;
        else if (this.card) this.card = null;
        else this.selectedPinId = null;
        break;
      case 'Delete':
      case 'Backspace':
        if (this.editing && this.selectedPinId) this.deletePin(this.selectedPinId);
        else if (event.key === 'Backspace' && this.mode === 'file') this.goUp();
        else return;
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** Arrow keys: in Edit with a pin selected they nudge it; otherwise they pan. */
  private nudgeOrPan(event: KeyboardEvent, dx: number, dy: number, pan: number): void {
    const pin = this.editing ? this.selectedPin : null;
    if (pin && this.natural) {
      const step = (event.shiftKey ? 10 : 2) / this.transform.k;
      this.commit(updatePin(this.map, pin.id, {
        x: pin.x + (dx * step) / this.natural.width,
        y: pin.y + (dy * step) / this.natural.height,
      }));
      return;
    }
    this.transform = { ...this.transform, x: this.transform.x - dx * pan, y: this.transform.y - dy * pan };
    this.layoutPins();
  }

  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    // Alt+← goes to the parent map (like a browser's Back).
    if (this.mode === 'file' && event.altKey && event.key === 'ArrowLeft' && this.breadcrumbs.length) {
      event.preventDefault();
      this.goUp();
    }
  }

  // ---- Pins: viewing ----

  onPinEnter(view: PinView, element: HTMLElement): void {
    this.hoveredPinId = view.pin.id;
    if (!view.entry || this.gesture) return;
    this.linkHover.emit({ target: view.entry.relativePath, rect: element.getBoundingClientRect() });
  }

  onPinLeave(): void {
    this.hoveredPinId = null;
    this.linkHover.emit(null);
  }

  onPinKeydown(view: PinView, event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (this.editing) this.selectPin(view.pin.id);
    else this.openCard(view.pin.id);
  }

  /** Viewing: click opens the pin's card; Ctrl/Cmd+click or double-click opens its note. */
  onPinClick(pinId: string, event: MouseEvent): void {
    if (this.editing) return;
    event.stopPropagation();
    const view = this.pins.find(item => item.pin.id === pinId);
    // Ctrl/Cmd+click or a double-click goes straight to the note.
    if (view?.entry && (event.ctrlKey || event.metaKey || event.detail >= 2)) {
      this.openPinTarget(view);
      return;
    }
    this.openCard(pinId);
  }

  openCard(pinId: string): void {
    const view = this.pins.find(item => item.pin.id === pinId) ?? this.allPinViews().find(item => item.pin.id === pinId);
    if (!view) return;
    this.linkHover.emit(null);
    this.card = { pinId, loading: !!view.entry, excerpt: '', kindLabel: this.kindLabel(view) };
    if (view.entry) void this.loadExcerpt(view, pinId);
  }

  closeCard(): void {
    this.card = null;
  }

  /** The line under a pin card's title: what it is, and its layer. */
  cardMeta(view: PinView, kindLabel: string): string {
    return [kindLabel, this.layerName(view.pin.layer)].filter(Boolean).join(', ');
  }

  /** The map has layers (player maps show a layers panel). */
  get hasLayers(): boolean {
    return this.map.layers.length > 0;
  }

  private kindLabel(view: PinView): string {
    // Players only get the pin's name: it doesn't link anywhere for them.
    if (this.mode === 'player') return '';
    if (!view.pin.link) return 'Marker';
    if (view.missing) return 'Note not found';
    if (view.isSubmap) return 'Map';
    const kind = view.entry ? this.index?.getStatblockKind(view.entry.relativePath) : null;
    if (kind === 'creature') return 'Statblock';
    if (kind) return kind === 'item' ? 'Item' : 'Spell';
    return view.entry && getVaultFileType(view.entry.name).id !== 'markdown' ? getVaultFileType(view.entry.name).label ?? 'File' : 'Note';
  }

  private async loadExcerpt(view: PinView, pinId: string): Promise<void> {
    try {
      const entry = view.entry!;
      let excerpt = '';
      if (view.isSubmap) {
        const sub = parseVaultMap(await this.vaultService.readFile(this.serverId, entry.relativePath));
        excerpt = `${sub.pins.length === 1 ? '1 pin' : `${sub.pins.length} pins`}. Open it to explore.`;
      } else if (getVaultFileType(entry.name).id === 'markdown') {
        excerpt = noteExcerpt(await this.vaultService.readFile(this.serverId, entry.relativePath));
      }
      if (this.card?.pinId === pinId) this.card = { ...this.card, loading: false, excerpt };
    } catch {
      if (this.card?.pinId === pinId) this.card = { ...this.card, loading: false };
    }
  }

  /** Opens what a pin links to (a note, or a sub-map). */
  openPinTarget(view: PinView): void {
    if (!view.entry) return;
    this.linkHover.emit(null);
    this.openFile.emit(view.entry.relativePath);
  }

  /** Card → "Show on map" for pins listed in the panel. */
  showPin(view: PinView): void {
    const pin = view.pin;
    if (pin.layer && !this.map.layers.find(layer => layer.id === pin.layer)?.visible && this.canEdit) {
      this.commit(updateLayer(this.map, pin.layer, { visible: true }));
    }
    this.flyToPin(pin, { select: !this.editing });
    if (this.editing) this.selectPin(pin.id);
  }

  // ---- Breadcrumbs (nested maps) ----

  /** Parent maps, found from which maps have a pin linking here (nearest last). */
  updateBreadcrumbs(): void {
    const index = this.index;
    if (!index || this.mode !== 'file' || !this.path) {
      this.breadcrumbs = [];
      if (this.serverId && !index) void this.vaultIndexService.load(this.serverId).then(() => this.updateBreadcrumbs());
      return;
    }
    const crumbs: { path: string; title: string }[] = [];
    const seen = new Set([this.path.toLowerCase()]);
    let current = this.path;
    for (let depth = 0; depth < 6; depth++) {
      const parent = index.getBacklinks(current).find(entry => getFileExtension(entry.name) === 'map' && !seen.has(entry.relativePath.toLowerCase()));
      if (!parent) break;
      seen.add(parent.relativePath.toLowerCase());
      crumbs.unshift({ path: parent.relativePath, title: getVaultDisplayName(parent.name) });
      current = parent.relativePath;
    }
    this.breadcrumbs = crumbs;
  }

  /** Opens the parent map, centred on the pin that leads here. */
  goUp(): void {
    const parent = this.breadcrumbs[this.breadcrumbs.length - 1];
    if (parent) this.openCrumb(parent.path);
  }

  openCrumb(path: string): void {
    this.openFile.emit(`${path}#${this.title}`);
  }

  // ---- Edit mode ----

  toggleEditing(): void {
    if (!this.canEdit) return;
    this.editing = !this.editing;
    this.addingPin = false;
    this.card = null;
    if (!this.editing) this.selectedPinId = null;
    this.panelOpen = true;
  }

  startAddingPin(): void {
    if (!this.canEdit) return;
    this.editing = true;
    this.addingPin = !this.addingPin;
    this.card = null;
  }

  private placePinAt(clientX: number, clientY: number): void {
    const viewport = this.viewportRef?.nativeElement;
    if (!viewport || !this.natural || !this.canEdit) return;
    const rect = viewport.getBoundingClientRect();
    const x = (clientX - rect.left - this.transform.x) / (this.natural.width * this.transform.k);
    const y = (clientY - rect.top - this.transform.y) / (this.natural.height * this.transform.k);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const { map, pin } = addPin(this.map, { x, y });
    this.addingPin = false;
    this.commit(map);
    this.selectPin(pin.id, { focusLink: true });
  }

  selectPin(id: string, options: { focusLink?: boolean } = {}): void {
    this.selectedPinId = id;
    this.card = null;
    this.panelOpen = true;
    const pin = this.selectedPin;
    this.linkQuery = pin?.link ?? '';
    this.linkSuggestions = [];
    this.newNoteFolder = null;
    this.focusLinkInput = !!options.focusLink;
    if (options.focusLink) this.updateLinkSuggestions();
  }

  editPinFromCard(): void {
    const id = this.card?.pinId;
    if (!id || !this.canEdit) return;
    this.editing = true;
    this.selectPin(id);
  }

  setPin(changes: Partial<MapPin>): void {
    const pin = this.selectedPin;
    if (pin) this.commit(updatePin(this.map, pin.id, changes));
  }

  deletePin(id: string): void {
    const pin = this.map.pins.find(item => item.id === id);
    if (!pin) return;
    this.commit(removePin(this.map, id), { undoable: true });
    if (this.selectedPinId === id) this.selectedPinId = null;
    if (this.card?.pinId === id) this.card = null;
    const name = pin.label || linkName(pin.link) || 'Pin';
    const ref = this.snackBar.open(`Removed “${name}”.`, 'Undo', { duration: 6000 });
    ref.onAction().subscribe(() => {
      if (this.undo) this.commit(this.undo);
      this.undo = null;
    });
  }

  // Link search for the selected pin.

  updateLinkSuggestions(): void {
    const index = this.index;
    const q = this.linkQuery.trim().toLowerCase();
    if (!index) {
      this.linkSuggestions = [];
      return;
    }
    this.linkSuggestions = index.files
      .filter(entry => entry.relativePath !== this.path)
      .filter(entry => ['markdown', 'map'].includes(getVaultFileType(entry.name).id))
      .map(entry => ({ entry, title: getVaultDisplayName(entry.name), score: fuzzyScore(q, getVaultDisplayName(entry.name), entry.relativePath) }))
      .filter(item => !q || item.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 8)
      .map(({ entry, title }) => ({
        entry,
        title,
        folder: entry.parentPath,
        icon: getFileExtension(entry.name) === 'map' ? 'map' : this.noteIcon(entry),
      }));
  }

  private noteIcon(entry: VaultEntry): string {
    const kind = this.index?.getStatblockKind(entry.relativePath);
    return kind === 'creature' ? 'shield' : kind === 'item' ? 'diamond' : kind === 'spell' ? 'auto_fix_high' : 'description';
  }

  /** The typed name has no matching note: offer to create one. */
  get canCreateLinkedNote(): boolean {
    const q = this.linkQuery.trim();
    if (!q || !this.index) return false;
    return !this.index.resolveLink(q, this.path);
  }

  chooseLink(suggestion: LinkSuggestion): void {
    const index = this.index;
    const link = index ? index.linkTextFor(suggestion.entry) : suggestion.entry.relativePath;
    const pin = this.selectedPin;
    const changes: Partial<MapPin> = { link };
    // A pin with the default symbol becomes a map marker when it points at a map.
    if (pin && isMapLink(link) && pin.icon === 'location_on') changes.icon = SUBMAP_ICON;
    this.setPin(changes);
    this.linkQuery = link;
    this.linkSuggestions = [];
  }

  clearLink(): void {
    this.setPin({ link: null });
    this.linkQuery = '';
  }

  async prepareNewNote(): Promise<void> {
    if (!this.serverId) return;
    this.newNoteFolders = await this.noteInsert.folders(this.serverId);
    this.newNoteFolder = null;
  }

  /** Creates the typed note in the chosen folder and links the pin to it. */
  async createLinkedNote(): Promise<void> {
    const name = this.linkQuery.trim().replace(/\.md$/i, '');
    const folder = this.newNoteFolder;
    const pin = this.selectedPin;
    if (!name || folder === null || !pin || this.creatingNote) return;
    this.creatingNote = true;
    try {
      const template = this.useLocationTemplate ? findNoteTemplate('Location.md') : undefined;
      const target = `${folder ? `${folder}/` : ''}${name}.md`;
      const content = template ? await loadNoteTemplate(template, target).catch(() => '') : '';
      const path = await this.noteInsert.createNote(this.serverId, folder, name, content);
      this.commit(updatePin(this.map, pin.id, { link: path.replace(/\.md$/i, '') }));
      this.linkQuery = path.replace(/\.md$/i, '');
      this.newNoteFolders = [];
      this.snackBar.open(`Created “${name}” and linked the pin.`, 'Open', { duration: 5000 })
        .onAction().subscribe(() => this.openFile.emit(path));
    } catch (error) {
      console.error('[Map] Failed to create note', error);
      this.snackBar.open(`Couldn’t create “${name}”.`, 'OK', { duration: 4000 });
    } finally {
      this.creatingNote = false;
    }
  }

  // Layers.

  createLayer(): void {
    const name = this.newLayerName.trim();
    if (!name || !this.canEdit) return;
    const { map, layer } = addLayer(this.map, name);
    this.newLayerName = '';
    const pin = this.selectedPin;
    this.commit(pin ? updatePin(map, pin.id, { layer: layer.id }) : map);
  }

  /** Pins on a layer (shown next to its name). */
  layerPinCount(id: string): number {
    return this.map.pins.filter(pin => pin.layer === id).length;
  }

  startRenamingLayer(layer: MapLayer): void {
    if (!this.canEdit) return;
    this.renamingLayerId = layer.id;
    this.layerNameDraft = layer.name;
  }

  /** Enter or leaving the field saves; an empty name keeps the old one. */
  saveLayerName(): void {
    const id = this.renamingLayerId;
    if (!id) return;
    this.renamingLayerId = null;
    const name = this.layerNameDraft.trim();
    const layer = this.map.layers.find(item => item.id === id);
    if (layer && name && name !== layer.name) this.commit(updateLayer(this.map, id, { name }));
  }

  cancelRenamingLayer(): void {
    this.renamingLayerId = null;
  }

  /** Removes a layer (its pins stay, without a layer), with Undo. */
  deleteLayer(layer: MapLayer): void {
    if (!this.canEdit) return;
    const count = this.layerPinCount(layer.id);
    this.commit(removeLayer(this.map, layer.id), { undoable: true });
    if (this.renamingLayerId === layer.id) this.renamingLayerId = null;
    const kept = count ? ` Its ${count === 1 ? 'pin is' : `${count} pins are`} kept, without a layer.` : '';
    const ref = this.snackBar.open(`Deleted layer “${layer.name}”.${kept}`, 'Undo', { duration: 6000 });
    ref.onAction().subscribe(() => {
      if (this.undo) this.commit(this.undo);
      this.undo = null;
    });
  }

  toggleLayer(layer: MapLayer): void {
    if (this.canEdit) this.commit(updateLayer(this.map, layer.id, { visible: !layer.visible }));
    else {
      this.map = updateLayer(this.map, layer.id, { visible: !layer.visible });
      this.layoutPins();
    }
  }

  // ---- Image picker ----

  openImagePicker(source: ImageSource = 'vault'): void {
    if (!this.canEdit) return;
    this.pickingImage = true;
    this.setImageSource(source);
  }

  closeImagePicker(): void {
    this.pickingImage = false;
  }

  setImageSource(source: ImageSource): void {
    this.imageSource = source;
    if (source === 'vault') this.updateImagePicker();
    if (source === 'vtt') void this.loadVttMaps();
  }

  updateImagePicker(): void {
    const q = this.pickerQuery.trim().toLowerCase();
    const folder = this.path.split('/').slice(0, -1).join('/');
    const images = (this.index?.files ?? [])
      .filter(entry => getVaultFileType(entry.name).viewer === 'image')
      .filter(entry => !q || entry.relativePath.toLowerCase().includes(q))
      .sort((a, b) => Number(b.parentPath === folder) - Number(a.parentPath === folder) || a.relativePath.localeCompare(b.relativePath));
    this.pickerTotal = images.length;
    this.pickerImages = images.slice(0, PICKER_LIMIT);
    this.pickerImages.forEach(image => this.loadThumb(image.relativePath));
  }


  /** Picker thumbnails: small cached previews, not the full images (see VaultImageService). */
  private loadThumb(path: string): void {
    if (this.thumbUrls[path] !== undefined || !this.serverId) return;
    const serverId = this.serverId;
    void this.vaultImages.thumbnail(serverId, path).then(url => {
      if (serverId === this.serverId) this.thumbUrls = { ...this.thumbUrls, [path]: url ?? '' };
    });
  }

  /** The filter waits for a pause in typing, so each letter doesn't rebuild the grid. */
  onPickerQueryChange(): void {
    if (this.pickerQueryTimer) clearTimeout(this.pickerQueryTimer);
    this.pickerQueryTimer = setTimeout(() => {
      this.pickerQueryTimer = undefined;
      this.updateImagePicker();
    }, 150);
  }

  private async loadVttMaps(): Promise<void> {
    if (this.vttMaps.length || this.vttMapsLoading) return;
    this.vttMapsLoading = true;
    try {
      const library: MapLibraryEntry[] = await this.vttSync.loadMapLibrary();
      this.vttMaps = library
        .filter(entry => !entry.isArchived && (!entry.server || entry.server === this.serverId))
        .map(entry => ({ id: entry.id, name: entry.name, url: String(entry.data?.mapUrl ?? '') }))
        .filter(entry => /^https?:\/\//i.test(entry.url));
    } finally {
      this.vttMapsLoading = false;
    }
  }

  thumbFor(path: string): string {
    return this.thumbUrls[path] ?? '';
  }

  pickVaultImage(image: VaultEntry): void {
    const index = this.index;
    this.setImage(index ? index.linkTextFor(image) : image.relativePath);
  }

  pickVttMap(entry: { url: string }): void {
    this.setImage(entry.url);
  }

  private setImage(ref: string): void {
    this.pickingImage = false;
    this.needsFit = true;
    this.natural = null;
    this.commit({ ...this.map, image: ref, size: null });
    void this.loadImage();
  }

  /** Saves an image from the computer next to the map and uses it. */
  async uploadImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canEdit || !this.serverId) return;
    const extension = getFileExtension(file.name) || file.type.split('/')[1] || 'png';
    if (getVaultFileType(`x.${extension}`).viewer !== 'image') {
      this.snackBar.open('Choose an image file (PNG, JPG, WebP, GIF or SVG).', 'OK', { duration: 4000 });
      return;
    }
    const folder = this.path.split('/').slice(0, -1).join('/');
    const base = this.title.replace(/[\\/:*?"<>|#^[\]]+/g, '-').trim() || 'Map';
    this.uploading = true;
    try {
      let path = '';
      for (let i = 0; i < 100 && !path; i++) {
        const candidate = `${folder ? `${folder}/` : ''}${base}${i ? ` ${i}` : ''}.${extension}`;
        if (!(await this.vaultService.fileExists(this.serverId, candidate))) path = candidate;
      }
      if (!path) throw new Error('No free file name.');
      await this.vaultService.writeFile(this.serverId, path, file);
      this.filesAdded.emit();
      this.setImage(path);
    } catch (error) {
      console.error('[Map] Failed to save image', error);
      this.snackBar.open('Couldn’t save that image to the vault.', 'OK', { duration: 4000 });
    } finally {
      this.uploading = false;
    }
  }

  displayName(entry: VaultEntry): string {
    return getVaultDisplayName(entry.name);
  }

  /** Where the pin card sits: beside the pin, kept inside the viewport. */
  cardPosition(view: PinView): { left: number; top: number; below: boolean } {
    const viewport = this.viewportRef?.nativeElement;
    const width = 280;
    const vw = viewport?.clientWidth ?? 800;
    const vh = viewport?.clientHeight ?? 600;
    const left = clamp(view.left - width / 2, 8, Math.max(8, vw - width - 8));
    const below = view.top < 200;
    return { left, top: below ? Math.min(view.top + 24, vh - 40) : view.top - 22, below };
  }
}

/** The first readable lines of a note (no frontmatter, headings or Markdown symbols). */
export function noteExcerpt(markdown: string, max = 220): string {
  const { body } = splitFrontmatter(markdown);
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/%%[\s\S]*?%%/g, ' ')
    .replace(/^\s*>\s*\[!secret\][\s\S]*?(?=\n(?!>)|$)/gim, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target.split('/').pop()!)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?(\[![^\]]+\][+-]?\s*)?/gm, '')
    .replace(/[*_`~#|>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function fuzzyScore(query: string, title: string, path: string): number {
  if (!query) return 1;
  const t = title.toLowerCase();
  const p = path.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  if (t.includes(query)) return 60;
  if (p.includes(query)) return 40;
  let i = 0;
  for (const char of t) if (char === query[i]) i++;
  return i === query.length ? 20 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

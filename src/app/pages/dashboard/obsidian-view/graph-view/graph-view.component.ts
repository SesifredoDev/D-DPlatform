import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  Simulation,
  SimulationLinkDatum,
  SimulationNodeDatum,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import {
  DEFAULT_GRAPH_FILTERS,
  GraphFilters,
  GraphNode,
  VaultGraph,
  buildVaultGraph,
  defaultColorGroups,
  graphSignature,
} from '../../../../shared/services/ObsidianVault/vault-graph';
import type { GraphColorGroup, VaultIndex } from '../../../../shared/services/ObsidianVault/vault-index.service';

interface SimNode extends SimulationNodeDatum {
  id: string;
  node: GraphNode;
  r: number;
}

type SimLink = SimulationLinkDatum<SimNode>;

interface Palette {
  font: string;
  text: string;
  muted: string;
  accent: string;
  edge: string;
  background: string;
}

const FILTERS_STORAGE_KEY = 'obsidian-view.graph-filters';
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
/** Index changes (typing in a note) are batched before the graph is rebuilt. */
const REBUILD_DELAY = 400;

/**
 * The vault's link graph (or, with `focusPath`, the notes around one note), laid out with d3-force
 * and drawn on a canvas. Drag to pan, wheel to zoom, drag a note to move it, click it to open it.
 * The simulation and pointer handling run outside Angular so animation frames don't trigger
 * change detection.
 */
@Component({
  selector: 'app-vault-graph',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './graph-view.component.html',
  styleUrl: './graph-view.component.scss',
})
export class VaultGraphComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() index: VaultIndex | null = null;
  @Input() indexVersion = 0;
  /** Shows only the notes around this one (local graph). */
  @Input() focusPath: string | null = null;
  /** Colour groups from Obsidian's graph settings; null uses the vault's top tags. */
  @Input() colorGroups: GraphColorGroup[] | null = null;
  /** Small layout for the side panel: fewer controls. */
  @Input() compact = false;
  @Output() openFile = new EventEmitter<string>();
  /** The compact graph's "open the full graph" button. */
  @Output() expand = new EventEmitter<void>();

  @ViewChild('canvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;

  filters: GraphFilters = readFilters();
  depth = 1;
  graph: VaultGraph = { nodes: [], edges: [] };
  groups: GraphColorGroup[] = [];

  private simulation: Simulation<SimNode, SimLink> | null = null;
  private simNodes: SimNode[] = [];
  private simLinks: SimLink[] = [];
  private neighbours = new Map<string, Set<string>>();
  private signature = '';
  private transform = { k: 1, x: 0, y: 0 };
  private size = { width: 0, height: 0, dpr: 1 };
  private palette: Palette = { font: 'system-ui, sans-serif', text: '#fff', muted: '#999', accent: '#7289da', edge: 'rgba(255,255,255,0.18)', background: 'transparent' };
  private hovered: SimNode | null = null;
  private pointer: { mode: 'pan' | 'node'; node: SimNode | null; startX: number; startY: number; moved: boolean; tx: number; ty: number } | null = null;
  private fitted = false;
  private frame = 0;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['focusPath'] && !changes['focusPath'].isFirstChange()) {
      this.fitted = false;
      this.hovered = null;
    }
    const onlyContent = Object.keys(changes).every(key => key === 'indexVersion');
    if (onlyContent && this.simulation) {
      this.scheduleRebuild();
    } else {
      this.rebuild();
    }
  }

  ngAfterViewInit(): void {
    this.readPalette();
    this.zone.runOutsideAngular(() => {
      const canvas = this.canvasRef.nativeElement;
      const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
        canvas.addEventListener(type, handler as EventListener, options);
        this.cleanups.push(() => canvas.removeEventListener(type, handler as EventListener, options));
      };
      listen('pointerdown', event => this.onPointerDown(event));
      listen('pointermove', event => this.onPointerMove(event));
      listen('pointerup', event => this.onPointerUp(event));
      listen('pointercancel', () => this.endPointer());
      listen('pointerleave', () => this.setHovered(null));
      listen('wheel', event => this.onWheel(event), { passive: false });
      listen('keydown', event => this.onKeydown(event));

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement!);
    });
    this.resize();
    this.rebuild();
  }

  ngOnDestroy(): void {
    this.simulation?.stop();
    this.resizeObserver?.disconnect();
    this.cleanups.forEach(cleanup => cleanup());
    cancelAnimationFrame(this.frame);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
  }

  get summary(): string {
    const notes = this.graph.nodes.length;
    const links = this.graph.edges.length;
    return `${notes === 1 ? '1 note' : `${notes} notes`}, ${links === 1 ? '1 link' : `${links} links`}`;
  }

  get tagOptions(): string[] {
    return (this.index?.getAllTags() ?? []).map(item => item.tag);
  }

  onFiltersChange(): void {
    writeFilters(this.filters);
    this.fitted = false;
    this.rebuild();
  }

  setDepth(depth: number): void {
    if (this.depth === depth) return;
    this.depth = depth;
    this.fitted = false;
    this.rebuild();
  }

  /** Enter in the search box opens the best match. */
  openFirstMatch(): void {
    const query = this.filters.search.trim().toLowerCase();
    const match = this.graph.nodes.find(node => node.path && node.label.toLowerCase() === query)
      ?? this.graph.nodes.find(node => node.path && node.label.toLowerCase().includes(query));
    if (match?.path) this.openFile.emit(match.path);
  }

  fit(): void {
    this.fitToContent();
    this.requestDraw();
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.size.width / 2, this.size.height / 2, factor);
  }

  // ---- Graph ----

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, REBUILD_DELAY);
  }

  private rebuild(): void {
    const index = this.index;
    if (!index || !this.canvasRef) {
      this.graph = { nodes: [], edges: [] };
      return;
    }

    this.groups = this.colorGroups ?? defaultColorGroups(index);
    const focus = this.focusPath ? { path: this.focusPath, depth: this.depth } : null;
    const graph = buildVaultGraph(index, this.filters, this.groups, focus);
    this.graph = graph;

    const signature = graphSignature(graph);
    if (signature === this.signature && this.simulation) {
      this.requestDraw();
      return;
    }
    this.signature = signature;
    this.zone.runOutsideAngular(() => this.restartSimulation(graph));
  }

  private restartSimulation(graph: VaultGraph): void {
    // Keep positions of notes that were already on screen; place new ones next to a neighbour.
    const previous = new Map(this.simNodes.map(node => [node.id, node]));
    const neighbours = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      (neighbours.get(edge.source) ?? neighbours.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
      (neighbours.get(edge.target) ?? neighbours.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
    }
    this.neighbours = neighbours;

    this.simNodes = graph.nodes.map(node => {
      const old = previous.get(node.id);
      const r = radiusFor(node);
      if (old) return Object.assign(old, { node, r });
      const anchor = Array.from(neighbours.get(node.id) ?? []).map(id => previous.get(id)).find(Boolean);
      const spread = anchor ? 30 : 200;
      return {
        id: node.id,
        node,
        r,
        x: (anchor?.x ?? 0) + (Math.random() - 0.5) * spread,
        y: (anchor?.y ?? 0) + (Math.random() - 0.5) * spread,
      };
    });
    const byId = new Map(this.simNodes.map(node => [node.id, node]));
    this.simLinks = graph.edges.map(edge => ({ source: byId.get(edge.source)!, target: byId.get(edge.target)! }));
    if (this.hovered && !byId.has(this.hovered.id)) this.hovered = null;

    const local = !!this.focusPath;
    const count = this.simNodes.length;
    const charge = local ? -220 : count > 1500 ? -40 : count > 400 ? -70 : -120;

    this.simulation?.stop();
    this.simulation = forceSimulation<SimNode, SimLink>(this.simNodes)
      .force('link', forceLink<SimNode, SimLink>(this.simLinks).id(node => node.id).distance(local ? 70 : 45).strength(0.6))
      .force('charge', forceManyBody<SimNode>().strength(charge).distanceMax(local ? 600 : 400))
      .force('collide', forceCollide<SimNode>(node => node.r + 3))
      // A gentle pull to the middle keeps separate clusters and lone notes on screen.
      .force('x', forceX<SimNode>(0).strength(local ? 0.08 : 0.04))
      .force('y', forceY<SimNode>(0).strength(local ? 0.08 : 0.04))
      .alpha(previous.size ? 0.5 : 1)
      .on('tick', () => {
        if (!this.fitted && this.size.width && this.simulation && this.simulation.alpha() < 0.25) {
          this.fitted = true;
          this.fitToContent();
        }
        this.requestDraw();
      })
      .on('end', () => {
        if (!this.fitted && this.size.width) {
          this.fitted = true;
          this.fitToContent();
        }
        this.requestDraw();
      });
    if (previous.size === 0) this.fitted = false;
  }

  // ---- Drawing ----

  private readPalette(): void {
    const style = getComputedStyle(this.host.nativeElement);
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.palette = {
      // Canvas fonts can't use CSS variables, so use the resolved family.
      font: style.fontFamily || 'system-ui, sans-serif',
      text: value('--vv-text', '#ffffff'),
      muted: value('--vv-text-3', 'rgba(255,255,255,0.5)'),
      accent: value('--vv-accent', '#7289da'),
      edge: 'rgba(160, 165, 180, 0.28)',
      background: 'transparent',
    };
  }

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (!width || !height) return;
    const firstSize = !this.size.width;
    this.size = { width, height, dpr };
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (firstSize) this.transform = { k: 1, x: width / 2, y: height / 2 };
    if (!this.fitted && this.simNodes.length) this.fitToContent();
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, dpr } = this.size;
    const { k, x, y } = this.transform;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(x, y);
    ctx.scale(k, k);

    const hovered = this.hovered;
    const lit = hovered ? this.neighbours.get(hovered.id) ?? new Set<string>() : null;
    const isLit = (node: SimNode) => !lit || node === hovered || lit.has(node.id);

    // Links
    ctx.lineWidth = Math.max(0.6, 1 / k);
    for (const link of this.simLinks) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      const highlighted = hovered && (source === hovered || target === hovered);
      ctx.globalAlpha = lit && !highlighted ? 0.12 : 1;
      ctx.strokeStyle = highlighted ? this.palette.accent : this.palette.edge;
      ctx.beginPath();
      ctx.moveTo(source.x!, source.y!);
      ctx.lineTo(target.x!, target.y!);
      ctx.stroke();
    }

    // Nodes
    for (const node of this.simNodes) {
      ctx.globalAlpha = isLit(node) ? 1 : 0.2;
      const isFocus = node.id === this.focusPath;
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, node.r * (node === hovered ? 1.25 : 1), 0, Math.PI * 2);
      if (node.node.kind === 'missing') {
        ctx.lineWidth = Math.max(1, 1.5 / k);
        ctx.strokeStyle = this.palette.muted;
        ctx.stroke();
      } else {
        ctx.fillStyle = node.node.color ?? (node.node.kind === 'file' ? this.palette.muted : this.palette.text);
        if (node.node.kind === 'file') ctx.globalAlpha *= 0.7;
        ctx.fill();
      }
      if (isFocus) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(1.5, 2.5 / k);
        ctx.strokeStyle = this.palette.accent;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, node.r + 4 / Math.max(k, 0.5), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels: all of them when zoomed in (or in a small local graph), else only the highlighted ones.
    const showAll = k >= 1.1 || (!!this.focusPath && this.simNodes.length <= 40);
    const fontSize = 11 / k;
    ctx.font = `${fontSize}px ${this.palette.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of this.simNodes) {
      const highlighted = node === hovered || (lit?.has(node.id) ?? false) || node.id === this.focusPath;
      if (!showAll && !highlighted) continue;
      ctx.globalAlpha = isLit(node) ? (highlighted || !lit ? 1 : 0.85) : 0.15;
      ctx.fillStyle = node.node.kind === 'missing' ? this.palette.muted : this.palette.text;
      ctx.fillText(truncate(node.node.label, 40), node.x!, node.y! + node.r + 3 / k);
    }
    ctx.globalAlpha = 1;
  }

  private fitToContent(): void {
    const { width, height } = this.size;
    if (!width || !this.simNodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.simNodes) {
      minX = Math.min(minX, node.x! - node.r);
      maxX = Math.max(maxX, node.x! + node.r);
      minY = Math.min(minY, node.y! - node.r);
      maxY = Math.max(maxY, node.y! + node.r + 14);
    }
    const padding = this.compact ? 24 : 48;
    const k = clamp(Math.min((width - padding * 2) / Math.max(maxX - minX, 1), (height - padding * 2) / Math.max(maxY - minY, 1)), MIN_ZOOM, 2);
    this.transform = { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
  }

  private zoomAt(screenX: number, screenY: number, factor: number): void {
    const { k, x, y } = this.transform;
    const next = clamp(k * factor, MIN_ZOOM, MAX_ZOOM);
    this.transform = { k: next, x: screenX - ((screenX - x) / k) * next, y: screenY - ((screenY - y) / k) * next };
    this.requestDraw();
  }

  // ---- Pointer (runs outside Angular) ----

  private toWorld(event: MouseEvent): { x: number; y: number; sx: number; sy: number } {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return { x: (sx - this.transform.x) / this.transform.k, y: (sy - this.transform.y) / this.transform.k, sx, sy };
  }

  private nodeAt(event: MouseEvent): SimNode | null {
    const point = this.toWorld(event);
    const found = this.simulation?.find(point.x, point.y, 14 / this.transform.k + 6);
    return found && Math.hypot(found.x! - point.x, found.y! - point.y) <= found.r + 6 / this.transform.k ? found : null;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const node = this.nodeAt(event);
    const point = this.toWorld(event);
    this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
    this.pointer = {
      mode: node ? 'node' : 'pan',
      node,
      startX: point.sx,
      startY: point.sy,
      moved: false,
      tx: this.transform.x,
      ty: this.transform.y,
    };
  }

  private onPointerMove(event: PointerEvent): void {
    const pointer = this.pointer;
    if (!pointer) {
      this.setHovered(this.nodeAt(event));
      return;
    }
    const point = this.toWorld(event);
    if (!pointer.moved && Math.hypot(point.sx - pointer.startX, point.sy - pointer.startY) < 4) return;
    pointer.moved = true;

    if (pointer.mode === 'pan') {
      this.transform = { ...this.transform, x: pointer.tx + point.sx - pointer.startX, y: pointer.ty + point.sy - pointer.startY };
      this.requestDraw();
    } else if (pointer.node) {
      pointer.node.fx = point.x;
      pointer.node.fy = point.y;
      this.simulation?.alphaTarget(0.25).restart();
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const pointer = this.pointer;
    this.endPointer();
    if (pointer && !pointer.moved && pointer.node?.node.path) {
      const path = pointer.node.node.path;
      this.zone.run(() => this.openFile.emit(path));
    }
    this.setHovered(this.nodeAt(event));
  }

  private endPointer(): void {
    const node = this.pointer?.node;
    if (node && this.pointer?.moved) {
      node.fx = null;
      node.fy = null;
      this.simulation?.alphaTarget(0);
    }
    this.pointer = null;
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const point = this.toWorld(event);
    this.zoomAt(point.sx, point.sy, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
  }

  private onKeydown(event: KeyboardEvent): void {
    const pan = 60;
    switch (event.key) {
      case '+':
      case '=': this.zoomBy(1.25); break;
      case '-': this.zoomBy(0.8); break;
      case '0': this.fit(); break;
      case 'ArrowLeft': this.transform.x += pan; this.requestDraw(); break;
      case 'ArrowRight': this.transform.x -= pan; this.requestDraw(); break;
      case 'ArrowUp': this.transform.y += pan; this.requestDraw(); break;
      case 'ArrowDown': this.transform.y -= pan; this.requestDraw(); break;
      default: return;
    }
    event.preventDefault();
  }

  private setHovered(node: SimNode | null): void {
    if (node === this.hovered) return;
    this.hovered = node;
    const canvas = this.canvasRef.nativeElement;
    canvas.style.cursor = node ? (node.node.path ? 'pointer' : 'default') : 'grab';
    canvas.title = node ? (node.node.kind === 'missing' ? `${node.node.label} (no note yet)` : node.node.path ?? node.node.label) : '';
    this.requestDraw();
  }
}

function radiusFor(node: GraphNode): number {
  return Math.min(14, 3.5 + Math.sqrt(node.degree) * 1.6);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readFilters(): GraphFilters {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? 'null');
    return { ...DEFAULT_GRAPH_FILTERS, ...(stored ?? {}), search: '', tag: null };
  } catch {
    return { ...DEFAULT_GRAPH_FILTERS };
  }
}

function writeFilters(filters: GraphFilters): void {
  try {
    const { showAttachments, showOrphans, showMissing } = filters;
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ showAttachments, showOrphans, showMissing }));
  } catch {
    // Storage unavailable: the toggles just won't be remembered.
  }
}

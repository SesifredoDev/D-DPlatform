import {
  AfterViewInit,
  ChangeDetectorRef,
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
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import Konva from 'konva';
import type {
  JsonCanvasDocument,
  JsonCanvasEdge,
  JsonCanvasNode,
  JsonCanvasSide,
} from '../../models/ObsidianVault/json-canvas.model';
import {
  ObsidianVaultService,
  type VaultEntry,
} from '../../services/ObsidianVault/obsidian-vault-service';

type CanvasNodeField = 'text' | 'file' | 'subpath' | 'url' | 'label' | 'color';
type CanvasNodeNumberField = 'x' | 'y' | 'width' | 'height';
type CanvasEdgeField = 'label' | 'color';

interface CanvasPoint {
  x: number;
  y: number;
}

interface VaultFileDragPayload {
  kind: 'file' | 'directory';
  name: string;
  relativePath: string;
  parentPath?: string;
}

type CanvasPreviewStatus = 'loading' | 'ready' | 'error';
type CanvasPreviewKind =
  | 'image'
  | 'note-image'
  | 'note'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'generic'
  | 'webpage'
  | 'webpage-image'
  | 'video-embed';

interface CanvasFilePreview {
  status: CanvasPreviewStatus;
  kind: CanvasPreviewKind;
  title: string;
  subtitle: string;
  text?: string;
  siteName?: string;
  faviconUrl?: string;
  icon: string;
  objectUrls: string[];
  safeUrl?: SafeUrl;
  safeResourceUrl?: SafeResourceUrl;
}

interface CanvasPreviewOverlay {
  nodeId: string;
  status: CanvasPreviewStatus;
  kind: CanvasPreviewKind;
  title: string;
  subtitle: string;
  text: string;
  siteName: string;
  faviconUrl: string;
  icon: string;
  style: Record<string, string>;
  safeUrl?: SafeUrl;
  safeResourceUrl?: SafeResourceUrl;
}

interface CanvasNoteOption {
  name: string;
  relativePath: string;
  parentPath: string;
}

type CanvasNotePickerTarget = 'new' | 'selected';

interface CanvasColorOption {
  value: string;
  label: string;
  hex: string;
}

interface CreateCanvasEdgeOptions {
  keepConnectionMode?: boolean;
  selectEdge?: boolean;
}

@Component({
  selector: 'app-obsidian-canvas-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './obsidian-canvas-editor.component.html',
  styleUrl: './obsidian-canvas-editor.component.scss',
})
export class ObsidianCanvasEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() canvasJson = '';
  @Input() serverId = '';
  @Input() currentFilePath = '';
  @Input() readonly = false;
  @Output() canvasJsonChange = new EventEmitter<string>();
  @Output() fileOpen = new EventEmitter<string>();

  @ViewChild('editorRoot') private editorRoot?: ElementRef<HTMLElement>;
  @ViewChild('stageContainer') private stageContainer?: ElementRef<HTMLDivElement>;

  canvasDocument: JsonCanvasDocument = { nodes: [], edges: [] };
  parseError = '';
  selectedNodeId: string | null = null;
  selectedEdgeId: string | null = null;
  connectionMode = false;
  connectionSourceNodeId: string | null = null;
  zoomPercent = 100;
  previewOverlays: CanvasPreviewOverlay[] = [];
  notePickerOpen = false;
  notePickerLoading = false;
  notePickerError = '';
  notePickerQuery = '';
  noteOptions: CanvasNoteOption[] = [];
  cardLinkPickerOpen = false;
  cardLinkQuery = '';
  isCanvasDragTarget = false;

  private stage?: Konva.Stage;
  private gridLayer?: Konva.Layer;
  private edgeLayer?: Konva.Layer;
  private nodeLayer?: Konva.Layer;
  private resizeObserver?: ResizeObserver;
  private lastSerializedCanvas = '';
  private readonly vaultEntryDragType = 'application/x-dd-vault-entry';
  private readonly imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'];
  private readonly noteExtensions = ['md', 'markdown'];
  private readonly videoExtensions = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'];
  private readonly audioExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];
  readonly canvasColorOptions: CanvasColorOption[] = [
    { value: '1', label: 'Red', hex: '#f87171' },
    { value: '2', label: 'Orange', hex: '#fb923c' },
    { value: '3', label: 'Yellow', hex: '#facc15' },
    { value: '4', label: 'Green', hex: '#4ade80' },
    { value: '5', label: 'Blue', hex: '#60a5fa' },
    { value: '6', label: 'Purple', hex: '#a78bfa' },
  ];
  private readonly minNodeWidth = 90;
  private readonly minNodeHeight = 70;
  private previewCache = new Map<string, CanvasFilePreview>();
  private previewOverlayFrame: number | null = null;
  private destroyed = false;
  private notePickerTarget: CanvasNotePickerTarget = 'new';
  private cardLinkSourceNodeId: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private copiedNode: JsonCanvasNode | null = null;
  private readonly maxHistoryEntries = 80;

  constructor(
    private readonly obsidianVaultService: ObsidianVaultService,
    private readonly sanitizer: DomSanitizer,
    private readonly changeDetectorRef: ChangeDetectorRef
  ) {}

  get nodes(): JsonCanvasNode[] {
    this.canvasDocument.nodes ??= [];
    return this.canvasDocument.nodes;
  }

  get edges(): JsonCanvasEdge[] {
    this.canvasDocument.edges ??= [];
    return this.canvasDocument.edges;
  }

  get selectedNode(): JsonCanvasNode | null {
    if (!this.selectedNodeId) return null;
    return this.nodes.find(node => node.id === this.selectedNodeId) || null;
  }

  get selectedEdge(): JsonCanvasEdge | null {
    if (!this.selectedEdgeId) return null;
    return this.edges.find(edge => edge.id === this.selectedEdgeId) || null;
  }

  get hasCanvasItems(): boolean {
    return this.nodes.length > 0 || this.edges.length > 0;
  }

  get canUndo(): boolean {
    return !this.readonly && this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return !this.readonly && this.redoStack.length > 0;
  }

  get canvasSummaryLabel(): string {
    const cardLabel = `${this.nodes.length} ${this.nodes.length === 1 ? 'card' : 'cards'}`;
    const linkLabel = `${this.edges.length} ${this.edges.length === 1 ? 'link' : 'links'}`;
    return `${cardLabel} - ${linkLabel}`;
  }

  get canvasModeLabel(): string {
    if (this.readonly) return 'Preview';
    if (this.connectionMode) return this.connectionSourceNodeId ? 'Connecting' : 'Connect mode';
    if (this.selectedNode) return `Selected ${this.getNodeTypeLabel(this.selectedNode)}`;
    if (this.selectedEdge) return 'Selected link';
    return 'Editing';
  }

  get canvasDetailLabel(): string {
    if (this.selectedNode) return this.getCardLinkLabel(this.selectedNode);
    if (this.selectedEdge) return this.getEdgeDescription(this.selectedEdge);
    if (!this.hasCanvasItems) return 'Empty canvas';
    return 'Ready';
  }

  get notePickerTitle(): string {
    return this.notePickerTarget === 'selected' ? 'Choose note' : 'Attach note';
  }

  get visibleNoteOptions(): CanvasNoteOption[] {
    const query = this.normalizeSearchText(this.notePickerQuery);
    const source = query
      ? this.noteOptions.filter(note =>
          this.normalizeSearchText(`${note.name} ${note.relativePath}`).includes(query)
        )
      : this.noteOptions;

    return source.slice(0, 60);
  }

  get visibleCardLinkTargets(): JsonCanvasNode[] {
    const sourceNodeId = this.getCardLinkSourceNodeId();
    if (!sourceNodeId) return [];

    const query = this.normalizeSearchText(this.cardLinkQuery);
    return this.nodes
      .filter(node => node.id !== sourceNodeId)
      .filter(node => {
        if (!query) return true;

        return this.normalizeSearchText(
          `${this.getCardLinkLabel(node)} ${this.getCardLinkDescription(node)} ${node.type}`
        ).includes(query);
      })
      .slice(0, 60);
  }

  get connectionAssistTitle(): string {
    if (!this.connectionMode) return '';
    return this.connectionSourceNodeId ? 'Pick target cards' : 'Pick source card';
  }

  get connectionAssistSubtitle(): string {
    if (!this.connectionMode) return '';

    const sourceNode = this.connectionSourceNodeId
      ? this.nodes.find(node => node.id === this.connectionSourceNodeId)
      : null;

    return sourceNode
      ? `Source: ${this.getCardLinkLabel(sourceNode)}. Click more cards to connect them.`
      : 'Click a card to use as the source.';
  }

  ngAfterViewInit(): void {
    this.createStage();
    this.loadCanvasJson(this.canvasJson);
    this.renderCanvas();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const previewContextChanged = !!changes['serverId'] || !!changes['currentFilePath'];
    if (previewContextChanged) {
      this.clearPreviewCache();
    }
    if (changes['serverId']) {
      this.noteOptions = [];
      if (this.notePickerOpen) {
        void this.loadNoteOptions();
      }
    }

    if (changes['canvasJson']) {
      if (this.canvasJson === this.lastSerializedCanvas) {
        if (previewContextChanged) {
          this.renderCanvas();
        }
        return;
      }

      this.loadCanvasJson(this.canvasJson);
      this.resetHistory();
      this.renderCanvas();
      return;
    }

    if (previewContextChanged) {
      this.renderCanvas();
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.previewOverlayFrame !== null) {
      cancelAnimationFrame(this.previewOverlayFrame);
      this.previewOverlayFrame = null;
    }
    this.clearPreviewCache();
    this.resizeObserver?.disconnect();
    this.stage?.destroy();
  }

  focusEditor(): void {
    this.editorRoot?.nativeElement.focus({ preventScroll: true });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    if (!this.shouldHandleKeyboardShortcut(event)) return;

    const key = event.key.toLowerCase();
    const hasModifier = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape') {
      if (this.cardLinkPickerOpen) {
        event.preventDefault();
        this.closeCardLinkPicker();
        return;
      }

      if (this.notePickerOpen) {
        event.preventDefault();
        this.closeNotePicker();
        return;
      }

      if (this.connectionMode) {
        event.preventDefault();
        this.cancelConnectionMode();
        return;
      }

      if (this.selectedNodeId || this.selectedEdgeId) {
        event.preventDefault();
        this.closeInspector();
      }
      return;
    }

    if (!hasModifier && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (this.readonly || (!this.selectedNodeId && !this.selectedEdgeId)) return;
      event.preventDefault();
      this.deleteSelected();
      return;
    }

    if (!hasModifier && key === 'c') {
      if (this.readonly || this.nodes.length < 2) return;
      event.preventDefault();
      if (this.connectionMode) {
        this.cancelConnectionMode();
      } else if (this.selectedNodeId) {
        this.startConnectionFromSelected();
      } else {
        this.toggleConnectionMode();
      }
      return;
    }

    if (!hasModifier) return;

    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        this.redoCanvasChange();
      } else {
        this.undoCanvasChange();
      }
      return;
    }

    if (key === 'y') {
      event.preventDefault();
      this.redoCanvasChange();
      return;
    }

    if (key === 'c') {
      if (this.selectedNodeId) {
        event.preventDefault();
        this.copySelectedNode();
      }
      return;
    }

    if (key === 'v') {
      if (this.copiedNode && !this.readonly) {
        event.preventDefault();
        this.pasteCopiedNode();
      }
      return;
    }

    if (key === 'd') {
      if (this.selectedNodeId && !this.readonly) {
        event.preventDefault();
        this.duplicateSelectedNode();
      }
      return;
    }

    if (key === '0') {
      event.preventDefault();
      this.resetZoom();
      return;
    }

    if (key === '=' || key === '+') {
      event.preventDefault();
      this.zoomIn();
      return;
    }

    if (key === '-') {
      event.preventDefault();
      this.zoomOut();
    }
  }

  private shouldHandleKeyboardShortcut(event: KeyboardEvent): boolean {
    const root = this.editorRoot?.nativeElement;
    if (!root) return false;

    const target = event.target instanceof Node ? event.target : null;
    const activeElement = document.activeElement;
    const eventStartedInEditor = !!target && root.contains(target);
    const editorHasFocus = !!activeElement && root.contains(activeElement);

    if (!eventStartedInEditor && !editorHasFocus) return false;

    if (this.isEditableKeyboardTarget(event.target)) {
      return event.key === 'Escape';
    }

    return true;
  }

  private isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      tagName === 'select' ||
      target.isContentEditable
    );
  }

  addTextNode(): void {
    if (this.readonly) return;

    const point = this.getViewportCenter();
    const node: JsonCanvasNode = {
      id: this.createUniqueId('node'),
      type: 'text',
      x: Math.round(point.x - 140),
      y: Math.round(point.y - 80),
      width: 280,
      height: 160,
      text: 'New card',
    };

    this.nodes.push(node);
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  addFileNode(): void {
    if (this.readonly) return;

    this.addFileNodeForPath('Untitled.md');
  }

  openNotePicker(target: CanvasNotePickerTarget = 'new'): void {
    if (this.readonly) return;

    this.closeCardLinkPicker();
    this.notePickerTarget = target;
    this.notePickerOpen = true;
    this.notePickerQuery = '';
    this.notePickerError = '';

    if (this.noteOptions.length === 0) {
      void this.loadNoteOptions();
    }
  }

  closeNotePicker(): void {
    this.notePickerOpen = false;
    this.notePickerError = '';
  }

  openCardLinkPicker(): void {
    const sourceNodeId = this.selectedNodeId || this.connectionSourceNodeId;
    if (this.readonly || !sourceNodeId || this.nodes.length < 2) return;

    this.selectedNodeId = sourceNodeId;
    this.selectedEdgeId = null;
    this.cardLinkSourceNodeId = sourceNodeId;
    this.cardLinkQuery = '';
    this.cardLinkPickerOpen = true;
    this.closeNotePicker();
    if (!this.connectionMode) {
      this.connectionSourceNodeId = null;
    }
    this.renderCanvas();
  }

  closeCardLinkPicker(): void {
    this.cardLinkPickerOpen = false;
    this.cardLinkQuery = '';
    this.cardLinkSourceNodeId = null;
  }

  linkSelectedCardTo(targetNodeId: string): void {
    const sourceNodeId = this.getCardLinkSourceNodeId();
    if (this.readonly || !sourceNodeId || sourceNodeId === targetNodeId) return;

    const keepConnectionMode = this.connectionMode && this.connectionSourceNodeId === sourceNodeId;
    this.closeCardLinkPicker();
    this.createEdge(sourceNodeId, targetNodeId, {
      keepConnectionMode,
      selectEdge: !keepConnectionMode,
    });
  }

  isCardAlreadyLinked(targetNodeId: string): boolean {
    const sourceNodeId = this.getCardLinkSourceNodeId();
    return !!sourceNodeId && !!this.findExistingCardLink(sourceNodeId, targetNodeId);
  }

  startConnectionFromSelected(): void {
    if (this.readonly || !this.selectedNodeId || this.nodes.length < 2) return;

    this.closeCardLinkPicker();
    this.closeNotePicker();
    this.connectionMode = true;
    this.connectionSourceNodeId = this.selectedNodeId;
    this.stage?.container().style.setProperty('cursor', 'crosshair');
    this.renderCanvas();
  }

  cancelConnectionMode(): void {
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.stage?.container().style.setProperty('cursor', 'default');
    this.renderCanvas();
  }

  attachNote(option: CanvasNoteOption): void {
    if (this.readonly) return;

    if (this.notePickerTarget === 'selected' && this.selectedNode?.type === 'file') {
      this.selectedNode.file = option.relativePath;
      this.clearPreviewCache();
      this.closeNotePicker();
      this.commitCanvasChange();
      return;
    }

    this.addFileNodeForPath(option.relativePath);
    this.closeNotePicker();
  }

  retryLoadNoteOptions(): void {
    void this.loadNoteOptions();
  }

  private addFileNodeForPath(filePath: string): void {
    const point = this.getViewportCenter();
    const size = this.getDefaultFileNodeSize(filePath);
    const node: JsonCanvasNode = {
      id: this.createUniqueId('node'),
      type: 'file',
      x: Math.round(point.x - size.width / 2),
      y: Math.round(point.y - size.height / 2),
      width: size.width,
      height: size.height,
      file: filePath,
    };

    this.nodes.push(node);
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  onCanvasDragOver(event: DragEvent): void {
    if (!this.canAcceptVaultFileDrop(event)) {
      this.isCanvasDragTarget = false;
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.isCanvasDragTarget = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onCanvasDragLeave(event: DragEvent): void {
    const currentTarget = event.currentTarget;
    const relatedTarget = event.relatedTarget;

    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    this.isCanvasDragTarget = false;
  }

  onCanvasDrop(event: DragEvent): void {
    this.isCanvasDragTarget = false;
    if (this.readonly || this.parseError) return;

    const payload = this.getVaultFileDragPayload(event);
    if (!payload || payload.kind !== 'file' || !payload.relativePath.trim()) return;

    event.preventDefault();
    event.stopPropagation();
    this.addDroppedFileNode(payload, event.clientX, event.clientY);
  }

  addLinkNode(): void {
    if (this.readonly) return;

    const point = this.getViewportCenter();
    const node: JsonCanvasNode = {
      id: this.createUniqueId('node'),
      type: 'link',
      x: Math.round(point.x - 170),
      y: Math.round(point.y - 95),
      width: 340,
      height: 190,
      url: 'https://',
    };

    this.nodes.push(node);
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  addGroupNode(): void {
    if (this.readonly) return;

    const point = this.getViewportCenter();
    const node: JsonCanvasNode = {
      id: this.createUniqueId('node'),
      type: 'group',
      x: Math.round(point.x - 240),
      y: Math.round(point.y - 160),
      width: 480,
      height: 320,
      label: 'Group',
    };

    this.nodes.unshift(node);
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  toggleConnectionMode(): void {
    if (this.readonly) return;

    if (this.connectionMode) {
      this.cancelConnectionMode();
      return;
    }

    this.closeCardLinkPicker();
    this.closeNotePicker();
    this.connectionMode = true;
    this.connectionSourceNodeId = this.selectedNodeId;
    this.stage?.container().style.setProperty('cursor', 'crosshair');
    this.renderCanvas();
  }

  deleteSelected(): void {
    if (this.readonly) return;

    if (this.selectedNodeId) {
      const nodeId = this.selectedNodeId;
      this.canvasDocument.nodes = this.nodes.filter(node => node.id !== nodeId);
      this.canvasDocument.edges = this.edges.filter(
        edge => edge.fromNode !== nodeId && edge.toNode !== nodeId
      );
      this.selectedNodeId = null;
      this.connectionSourceNodeId = null;
      this.closeCardLinkPicker();
      this.commitCanvasChange();
      return;
    }

    if (this.selectedEdgeId) {
      const edgeId = this.selectedEdgeId;
      this.canvasDocument.edges = this.edges.filter(edge => edge.id !== edgeId);
      this.selectedEdgeId = null;
      this.commitCanvasChange();
    }
  }

  closeInspector(): void {
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this.closeCardLinkPicker();
    this.renderCanvas();
  }

  zoomIn(): void {
    this.zoomBy(1.16);
  }

  zoomOut(): void {
    this.zoomBy(0.86);
  }

  resetZoom(): void {
    if (!this.stage) return;
    this.stage.scale({ x: 1, y: 1 });
    this.stage.position({ x: 0, y: 0 });
    this.stage.batchDraw();
    this.updateZoomPercent();
    this.syncPreviewOverlays();
  }

  zoomToFit(): void {
    if (!this.stage || this.nodes.length === 0) {
      this.resetZoom();
      return;
    }

    const bounds = this.getNodeBounds();
    const padding = 90;
    const availableWidth = Math.max(1, this.stage.width() - padding * 2);
    const availableHeight = Math.max(1, this.stage.height() - padding * 2);
    const scale = Math.min(
      1.6,
      Math.max(0.18, Math.min(availableWidth / bounds.width, availableHeight / bounds.height))
    );

    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: padding - bounds.x * scale + (availableWidth - bounds.width * scale) / 2,
      y: padding - bounds.y * scale + (availableHeight - bounds.height * scale) / 2,
    });
    this.stage.batchDraw();
    this.updateZoomPercent();
    this.syncPreviewOverlays();
  }

  getSelectedNodeString(field: CanvasNodeField): string {
    const node = this.selectedNode;
    const value = node?.[field];
    return typeof value === 'string' ? value : '';
  }

  getSelectedNodeNumber(field: CanvasNodeNumberField): number {
    const node = this.selectedNode;
    return node ? Number(node[field]) || 0 : 0;
  }

  updateSelectedNodeField(field: CanvasNodeField, value: string): void {
    if (this.readonly || !this.selectedNode) return;
    this.selectedNode[field] = value;
    if (field === 'file' || field === 'url') {
      this.clearPreviewCache();
    }
    this.commitCanvasChange();
  }

  updateSelectedNodeNumber(field: CanvasNodeNumberField, value: string | number): void {
    if (this.readonly || !this.selectedNode) return;
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return;

    if (field === 'width' || field === 'height') {
      this.selectedNode[field] = Math.max(60, parsed);
    } else {
      this.selectedNode[field] = parsed;
    }
    this.commitCanvasChange();
  }

  getSelectedEdgeString(field: CanvasEdgeField): string {
    const edge = this.selectedEdge;
    const value = edge?.[field];
    return typeof value === 'string' ? value : '';
  }

  updateSelectedEdgeField(field: CanvasEdgeField, value: string): void {
    if (this.readonly || !this.selectedEdge) return;
    this.selectedEdge[field] = value;
    this.commitCanvasChange();
  }

  getSelectedNodeColorPickerValue(): string {
    return this.getColorPickerValue(this.getSelectedNodeString('color'), '#1e1f22');
  }

  getSelectedEdgeColorPickerValue(): string {
    return this.getColorPickerValue(this.getSelectedEdgeString('color'), '#7289da');
  }

  updateSelectedNodeColor(value: string): void {
    this.updateSelectedNodeField('color', value);
  }

  updateSelectedEdgeColor(value: string): void {
    this.updateSelectedEdgeField('color', value);
  }

  clearSelectedNodeColor(): void {
    this.updateSelectedNodeColor('');
  }

  clearSelectedEdgeColor(): void {
    this.updateSelectedEdgeColor('');
  }

  isSelectedNodeColorActive(option: CanvasColorOption): boolean {
    return this.isColorOptionActive(this.getSelectedNodeString('color'), option);
  }

  isSelectedEdgeColorActive(option: CanvasColorOption): boolean {
    return this.isColorOptionActive(this.getSelectedEdgeString('color'), option);
  }

  openSelectedFileNode(): void {
    const file = this.getSelectedNodeString('file').trim();
    if (file) {
      this.fileOpen.emit(file);
    }
  }

  openSelectedLinkNode(): void {
    const url = this.getSelectedNodeString('url').trim();
    if (/^https?:\/\//i.test(url)) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  getNodeLabel(node: JsonCanvasNode): string {
    if (node.type === 'text') return this.getStringField(node, 'text') || 'Text card';
    if (node.type === 'file') return this.getStringField(node, 'file') || 'File card';
    if (node.type === 'link') return this.getStringField(node, 'url') || 'Web link';
    if (node.type === 'group') return this.getStringField(node, 'label') || 'Group';
    return node.type || 'Card';
  }

  getNodeIcon(node: JsonCanvasNode): string {
    if (node.type === 'file') return 'description';
    if (node.type === 'link') return 'link';
    if (node.type === 'group') return 'select_all';
    return 'sticky_note_2';
  }

  getNodeTypeLabel(node: JsonCanvasNode): string {
    if (node.type === 'file') return 'File card';
    if (node.type === 'link') return 'Link card';
    if (node.type === 'group') return 'Group';
    return 'Text card';
  }

  getCardLinkLabel(node: JsonCanvasNode): string {
    if (node.type === 'file') {
      const filePath = this.getStringField(node, 'file').trim();
      if (this.isNotePath(filePath)) return this.getLinkedFileTitle(filePath);
      return this.getFilename(filePath) || filePath || 'File card';
    }

    if (node.type === 'link') {
      const url = this.getStringField(node, 'url').trim();
      return url ? this.getReadableUrlTitle(url) : 'Web link';
    }

    return this.getNodeLabel(node);
  }

  getEdgeTitle(edge: JsonCanvasEdge): string {
    const label = typeof edge.label === 'string' ? edge.label.trim() : '';
    return label || 'Link';
  }

  getEdgeDescription(edge: JsonCanvasEdge): string {
    const fromNode = this.nodes.find(node => node.id === edge.fromNode);
    const toNode = this.nodes.find(node => node.id === edge.toNode);
    const fromLabel = fromNode ? this.getCardLinkLabel(fromNode) : edge.fromNode || 'Unknown';
    const toLabel = toNode ? this.getCardLinkLabel(toNode) : edge.toNode || 'Unknown';
    return `${fromLabel} to ${toLabel}`;
  }

  getCardLinkDescription(node: JsonCanvasNode): string {
    if (node.type === 'file') return this.getStringField(node, 'file').trim() || 'File card';

    if (node.type === 'link') {
      const url = this.getStringField(node, 'url').trim();
      return this.getUrlHostname(url) || url || 'Web link';
    }

    if (node.type === 'group') return 'Group';
    return 'Text card';
  }

  private async loadNoteOptions(): Promise<void> {
    if (!this.serverId) {
      this.notePickerLoading = false;
      this.notePickerError = 'Vault unavailable';
      this.noteOptions = [];
      return;
    }

    this.notePickerLoading = true;
    this.notePickerError = '';

    try {
      const entries = await this.obsidianVaultService.listVaultFiles(this.serverId);
      if (this.destroyed) return;

      this.noteOptions = this.collectNoteOptions(entries);
      this.notePickerLoading = false;
      this.changeDetectorRef.detectChanges();
    } catch (error) {
      console.warn('[ObsidianCanvasEditor] Failed to load vault notes', error);
      if (this.destroyed) return;

      this.notePickerLoading = false;
      this.notePickerError = 'Unable to load notes';
      this.noteOptions = [];
      this.changeDetectorRef.detectChanges();
    }
  }

  private collectNoteOptions(entries: VaultEntry[], output: CanvasNoteOption[] = []): CanvasNoteOption[] {
    entries.forEach(entry => {
      if (entry.kind === 'file' && this.isNotePath(entry.name)) {
        output.push({
          name: entry.name,
          relativePath: entry.relativePath,
          parentPath: entry.parentPath || '',
        });
        return;
      }

      if (entry.kind === 'directory' && entry.children) {
        this.collectNoteOptions(entry.children, output);
      }
    });

    return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private createStage(): void {
    const container = this.stageContainer?.nativeElement;
    if (!container) return;

    this.stage?.destroy();
    this.stage = new Konva.Stage({
      container,
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      draggable: true,
    });

    this.gridLayer = new Konva.Layer({ listening: false });
    this.edgeLayer = new Konva.Layer();
    this.nodeLayer = new Konva.Layer();
    this.stage.add(this.gridLayer, this.edgeLayer, this.nodeLayer);

    this.stage.on('click tap', event => {
      if (event.target === this.stage) {
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.renderCanvas();
      }
    });

    this.stage.on('wheel', event => this.handleWheelZoom(event));
    this.stage.on('dragmove dragend', () => this.syncPreviewOverlays());

    this.resizeObserver = new ResizeObserver(() => this.resizeStage());
    this.resizeObserver.observe(container);
    this.drawGrid();
    this.updateZoomPercent();
  }

  private loadCanvasJson(value: string): void {
    const source = value.trim();
    if (!source) {
      this.canvasDocument = { nodes: [], edges: [] };
      this.parseError = '';
      this.lastSerializedCanvas = this.serializeCanvas();
      return;
    }

    try {
      const parsed = JSON.parse(source) as JsonCanvasDocument;
      this.canvasDocument = this.normalizeCanvasDocument(parsed);
      this.parseError = '';
      this.lastSerializedCanvas = this.serializeCanvas();
    } catch (error) {
      console.error('[ObsidianCanvasEditor] Invalid canvas JSON', error);
      this.canvasDocument = { nodes: [], edges: [] };
      this.parseError = 'Invalid canvas JSON';
    }
  }

  private normalizeCanvasDocument(document: JsonCanvasDocument): JsonCanvasDocument {
    const normalized: JsonCanvasDocument = { ...document };
    normalized.nodes = Array.isArray(document.nodes)
      ? document.nodes.map((node, index) => this.normalizeNode(node, index))
      : [];
    normalized.edges = Array.isArray(document.edges)
      ? document.edges.map((edge, index) => this.normalizeEdge(edge, index))
      : [];
    return normalized;
  }

  private normalizeNode(node: JsonCanvasNode, index: number): JsonCanvasNode {
    const normalized: JsonCanvasNode = {
      ...node,
      id: typeof node.id === 'string' && node.id ? node.id : this.createUniqueId('node'),
      type: typeof node.type === 'string' && node.type ? node.type : 'text',
      x: this.toInteger(node.x, index * 320),
      y: this.toInteger(node.y, index * 190),
      width: Math.max(60, this.toInteger(node.width, 280)),
      height: Math.max(60, this.toInteger(node.height, 160)),
    };

    if (normalized.type === 'text' && typeof normalized['text'] !== 'string') {
      normalized['text'] = '';
    } else if (normalized.type === 'file' && typeof normalized['file'] !== 'string') {
      normalized['file'] = '';
    } else if (normalized.type === 'link' && typeof normalized['url'] !== 'string') {
      normalized['url'] = '';
    }

    return normalized;
  }

  private normalizeEdge(edge: JsonCanvasEdge, index: number): JsonCanvasEdge {
    return {
      ...edge,
      id: typeof edge.id === 'string' && edge.id ? edge.id : this.createUniqueId('edge'),
      fromNode: typeof edge.fromNode === 'string' ? edge.fromNode : '',
      toNode: typeof edge.toNode === 'string' ? edge.toNode : '',
    };
  }

  private renderCanvas(): void {
    this.drawGrid();
    this.drawEdges();
    this.drawNodes();
  }

  private getThemeColor(cssVariable: string, fallback: string): string {
    if (typeof getComputedStyle === 'undefined') return fallback;

    const element = this.editorRoot?.nativeElement || document.documentElement;
    return getComputedStyle(element).getPropertyValue(cssVariable).trim() || fallback;
  }

  private getThemeRgbColor(cssVariable: string, fallbackRgb: string, alpha: number): string {
    return `rgba(${this.getThemeColor(cssVariable, fallbackRgb)}, ${alpha})`;
  }

  private drawGrid(): void {
    if (!this.stage || !this.gridLayer) return;

    this.gridLayer.destroyChildren();
    const width = Math.max(this.stage.width() * 4, 4000);
    const height = Math.max(this.stage.height() * 4, 4000);
    const startX = -width / 2;
    const startY = -height / 2;
    const gridSize = 80;
    const gridStroke = this.getThemeRgbColor('--primary-rgb', '114, 137, 218', 0.12);

    for (let x = startX; x <= width / 2; x += gridSize) {
      this.gridLayer.add(new Konva.Line({
        points: [x, startY, x, height / 2],
        stroke: gridStroke,
        strokeWidth: 1,
      }));
    }

    for (let y = startY; y <= height / 2; y += gridSize) {
      this.gridLayer.add(new Konva.Line({
        points: [startX, y, width / 2, y],
        stroke: gridStroke,
        strokeWidth: 1,
      }));
    }

    this.gridLayer.batchDraw();
  }

  private drawEdges(): void {
    if (!this.edgeLayer) return;

    this.edgeLayer.destroyChildren();
    const nodeMap = new Map(this.nodes.map(node => [node.id, node]));

    this.edges.forEach(edge => {
      const from = nodeMap.get(edge.fromNode);
      const to = nodeMap.get(edge.toNode);
      if (!from || !to) return;

      const fromSide = this.resolveSide(from, to, edge.fromSide);
      const toSide = this.resolveSide(to, from, edge.toSide);
      const fromPoint = this.getAnchorPoint(from, fromSide);
      const toPoint = this.getAnchorPoint(to, toSide);
      const isSelected = this.selectedEdgeId === edge.id;
      const color = this.resolveCanvasColor(
        edge.color,
        this.getThemeColor('--on-surface-variant', 'rgba(255, 255, 255, 0.7)')
      );
      const selectedColor = this.getThemeColor('--primary', '#7289da');

      const arrow = new Konva.Arrow({
        points: [fromPoint.x, fromPoint.y, toPoint.x, toPoint.y],
        stroke: isSelected ? selectedColor : color,
        fill: isSelected ? selectedColor : color,
        strokeWidth: isSelected ? 3 : 2,
        pointerLength: 11,
        pointerWidth: 10,
        pointerAtBeginning: edge.fromEnd === 'arrow',
        pointerAtEnding: edge.toEnd !== 'none',
        hitStrokeWidth: 18,
        lineCap: 'round',
        lineJoin: 'round',
      });

      arrow.on('click tap', event => {
        event.cancelBubble = true;
        this.selectEdge(edge.id);
      });

      this.edgeLayer?.add(arrow);

      const label = typeof edge.label === 'string' ? edge.label.trim() : '';
      if (label) {
        this.edgeLayer?.add(this.createEdgeLabel(label, fromPoint, toPoint, isSelected));
      }
    });

    this.edgeLayer.batchDraw();
  }

  private drawNodes(): void {
    if (!this.nodeLayer) return;

    this.nodeLayer.destroyChildren();
    let selectedGroup: Konva.Group | null = null;
    let selectedNode: JsonCanvasNode | null = null;
    const sortedNodes = [
      ...this.nodes.filter(node => node.type === 'group'),
      ...this.nodes.filter(node => node.type !== 'group'),
    ];

    sortedNodes.forEach(node => {
      this.ensureNodePreview(node);
      const isSelected = this.selectedNodeId === node.id;
      const isConnectionSource = this.connectionSourceNodeId === node.id;
      const isConnectionTarget = this.connectionMode && !!this.connectionSourceNodeId && !isConnectionSource;
      const group = new Konva.Group({
        x: node.x,
        y: node.y,
        draggable: !this.readonly && !this.connectionMode,
        name: `canvas-node-${node.id}`,
      });

      group.on('click tap', event => {
        event.cancelBubble = true;
        this.handleNodeClick(node.id);
      });

      group.on('dblclick dbltap', event => {
        event.cancelBubble = true;
        this.handleNodeOpen(node);
      });

      group.on('mouseenter', () => {
        if (!this.stage) return;
        const cursor = this.connectionMode && this.connectionSourceNodeId
          ? isConnectionTarget ? 'crosshair' : 'pointer'
          : !this.readonly ? 'grab' : 'default';
        this.stage.container().style.cursor = cursor;
      });

      group.on('mouseleave', () => {
        if (this.stage) {
          this.stage.container().style.cursor = this.connectionMode ? 'crosshair' : 'default';
        }
      });

      group.on('dragmove', () => {
        if (this.readonly) return;
        node.x = Math.round(group.x());
        node.y = Math.round(group.y());
        this.drawEdges();
        this.syncPreviewOverlays();
      });

      group.on('dragend', () => {
        if (this.readonly) return;
        node.x = Math.round(group.x());
        node.y = Math.round(group.y());
        this.syncPreviewOverlays();
        this.commitCanvasChange(false);
      });

      const rect = new Konva.Rect({
        width: node.width,
        height: node.height,
        fill: this.getNodeFill(node),
        stroke: isConnectionSource
          ? '#4ade80'
          : isConnectionTarget
            ? this.getThemeColor('--primary', '#7289da')
            : isSelected ? this.getThemeColor('--primary', '#7289da') : this.getNodeStroke(node),
        strokeWidth: isSelected || isConnectionSource ? 3 : isConnectionTarget ? 2.2 : 1.5,
        dash: isConnectionTarget ? [7, 5] : undefined,
        cornerRadius: node.type === 'group' ? 5 : 8,
        shadowColor: 'rgba(0, 0, 0, 0.45)',
        shadowBlur: node.type === 'group' ? 0 : 16,
        shadowOffset: { x: 0, y: 8 },
        shadowOpacity: node.type === 'group' ? 0 : 0.3,
      });

      group.add(rect);
      this.addNodeText(group, node);
      this.nodeLayer?.add(group);

      if (isSelected) {
        selectedGroup = group;
        selectedNode = node;
      }
    });

    if (selectedGroup && selectedNode && !this.readonly) {
      this.addNodeResizeTransformer(selectedGroup, selectedNode);
    }

    this.nodeLayer.batchDraw();
    this.syncPreviewOverlays();
  }

  private addNodeResizeTransformer(group: Konva.Group, node: JsonCanvasNode): void {
    if (!this.nodeLayer) return;

    let startWidth = node.width;
    let startHeight = node.height;

    const transformer = new Konva.Transformer({
      nodes: [group],
      rotateEnabled: false,
      keepRatio: false,
      flipEnabled: false,
      shouldOverdrawWholeArea: false,
      enabledAnchors: [
        'top-left',
        'top-center',
        'top-right',
        'middle-left',
        'middle-right',
        'bottom-left',
        'bottom-center',
        'bottom-right',
      ],
      borderStroke: this.getThemeColor('--primary', '#7289da'),
      borderStrokeWidth: 1.5,
      borderDash: [5, 4],
      anchorFill: this.getThemeColor('--surface', '#1e1f22'),
      anchorStroke: this.getThemeColor('--primary', '#7289da'),
      anchorStrokeWidth: 2,
      anchorSize: 10,
      anchorCornerRadius: 3,
      boundBoxFunc: (_oldBox, newBox) => ({
        ...newBox,
        width: Math.max(this.minNodeWidth, newBox.width),
        height: Math.max(this.minNodeHeight, newBox.height),
      }),
    });

    group.on('transformstart', () => {
      startWidth = node.width;
      startHeight = node.height;
    });

    group.on('transform', () => {
      this.applyNodeTransform(group, node, startWidth, startHeight);
      this.drawEdges();
      this.syncPreviewOverlays();
    });

    group.on('transformend', () => {
      this.applyNodeTransform(group, node, startWidth, startHeight);
      group.scale({ x: 1, y: 1 });
      this.commitCanvasChange();
    });

    this.nodeLayer.add(transformer);
  }

  private applyNodeTransform(
    group: Konva.Group,
    node: JsonCanvasNode,
    startWidth: number,
    startHeight: number
  ): void {
    node.x = Math.round(group.x());
    node.y = Math.round(group.y());
    node.width = Math.max(this.minNodeWidth, Math.round(startWidth * group.scaleX()));
    node.height = Math.max(this.minNodeHeight, Math.round(startHeight * group.scaleY()));
  }

  private addNodeText(group: Konva.Group, node: JsonCanvasNode): void {
    if (node.type === 'file') {
      this.addFileNodeText(group, node);
      return;
    }

    const padding = node.type === 'group' ? 12 : 14;
    const title = this.getNodeTitle(node);
    const body = this.getNodeBody(node);

    group.add(new Konva.Text({
      x: padding,
      y: padding,
      width: Math.max(20, node.width - padding * 2),
      text: title,
      fill: this.getNodeTextFill(node),
      fontSize: node.type === 'group' ? 14 : 15,
      fontStyle: 'bold',
      lineHeight: 1.2,
      wrap: 'word',
      ellipsis: true,
    }));

    if (body) {
      group.add(new Konva.Text({
        x: padding,
        y: padding + 28,
        width: Math.max(20, node.width - padding * 2),
        height: Math.max(20, node.height - padding * 2 - 28),
        text: body,
        fill: this.getNodeTextFill(node, true),
        fontSize: 13,
        lineHeight: 1.28,
        wrap: 'word',
        ellipsis: true,
      }));
    }
  }

  private addFileNodeText(group: Konva.Group, node: JsonCanvasNode): void {
    const padding = 14;
    const filePath = this.getStringField(node, 'file');
    const title = filePath.split('/').pop() || filePath || 'File';
    const kind = this.getFileKindLabel(filePath);

    group.add(new Konva.Rect({
      x: padding,
      y: padding,
      width: Math.min(86, Math.max(52, kind.length * 8 + 16)),
      height: 22,
      fill: this.getFileKindBadgeFill(filePath),
      cornerRadius: 6,
    }));

    group.add(new Konva.Text({
      x: padding,
      y: padding + 5,
      width: 86,
      text: kind,
      fill: '#0b1020',
      fontSize: 11,
      fontStyle: 'bold',
      align: 'center',
      letterSpacing: 0,
    }));

    group.add(new Konva.Text({
      x: padding,
      y: padding + 34,
      width: Math.max(20, node.width - padding * 2),
      text: title,
      fill: this.getNodeTextFill(node),
      fontSize: 15,
      fontStyle: 'bold',
      lineHeight: 1.2,
      wrap: 'word',
      ellipsis: true,
    }));

    group.add(new Konva.Text({
      x: padding,
      y: padding + 58,
      width: Math.max(20, node.width - padding * 2),
      height: Math.max(20, node.height - padding * 2 - 58),
      text: filePath,
      fill: this.getNodeTextFill(node, true),
      fontSize: 12,
      lineHeight: 1.3,
      wrap: 'word',
      ellipsis: true,
    }));
  }

  private createEdgeLabel(
    text: string,
    fromPoint: CanvasPoint,
    toPoint: CanvasPoint,
    isSelected: boolean
  ): Konva.Group {
    const label = new Konva.Group({
      x: (fromPoint.x + toPoint.x) / 2,
      y: (fromPoint.y + toPoint.y) / 2,
      listening: false,
    });
    const labelText = new Konva.Text({
      text,
      fontSize: 12,
      fontStyle: 'bold',
      fill: this.getThemeColor('--on-background', '#ffffff'),
      padding: 6,
    });
    const box = labelText.getClientRect();
    label.add(new Konva.Rect({
      x: box.x - 2,
      y: box.y - 1,
      width: box.width + 4,
      height: box.height + 2,
      fill: isSelected
        ? this.getThemeRgbColor('--primary-rgb', '114, 137, 218', 0.9)
        : 'rgba(0, 0, 0, 0.72)',
      cornerRadius: 6,
    }));
    label.add(labelText);
    label.offsetX((box.width + 4) / 2);
    label.offsetY((box.height + 2) / 2);
    return label;
  }

  private handleNodeClick(nodeId: string): void {
    if (this.connectionMode && !this.readonly) {
      if (!this.connectionSourceNodeId) {
        this.connectionSourceNodeId = nodeId;
        this.selectNode(nodeId);
        return;
      }

      if (this.connectionSourceNodeId === nodeId) {
        this.connectionSourceNodeId = null;
        this.selectNode(nodeId);
        return;
      }

      if (this.connectionSourceNodeId !== nodeId) {
        const sourceNodeId = this.connectionSourceNodeId;
        this.createEdge(sourceNodeId, nodeId, {
          keepConnectionMode: true,
          selectEdge: false,
        });
        return;
      }
    }

    this.selectNode(nodeId);
  }

  private handleNodeOpen(node: JsonCanvasNode): void {
    if (node.type === 'file') {
      const file = this.getStringField(node, 'file').trim();
      if (file) this.fileOpen.emit(file);
      return;
    }

    if (node.type === 'link') {
      const url = this.getStringField(node, 'url').trim();
      if (/^https?:\/\//i.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  }

  private getCardLinkSourceNodeId(): string | null {
    return this.cardLinkSourceNodeId || this.selectedNodeId;
  }

  private findExistingCardLink(fromNodeId: string, toNodeId: string): JsonCanvasEdge | null {
    return this.edges.find(edge =>
      (edge.fromNode === fromNodeId && edge.toNode === toNodeId) ||
      (edge.fromNode === toNodeId && edge.toNode === fromNodeId)
    ) || null;
  }

  private createEdge(
    fromNodeId: string,
    toNodeId: string,
    options: CreateCanvasEdgeOptions = {}
  ): void {
    if (fromNodeId === toNodeId) return;

    const selectEdge = options.selectEdge ?? true;
    if (options.keepConnectionMode) {
      this.connectionMode = true;
      this.connectionSourceNodeId = fromNodeId;
      this.stage?.container().style.setProperty('cursor', 'crosshair');
    } else {
      this.connectionMode = false;
      this.connectionSourceNodeId = null;
      this.stage?.container().style.setProperty('cursor', 'default');
    }

    const from = this.nodes.find(node => node.id === fromNodeId);
    const to = this.nodes.find(node => node.id === toNodeId);
    if (!from || !to) return;

    const existingEdge = this.findExistingCardLink(fromNodeId, toNodeId);
    if (existingEdge) {
      if (selectEdge) {
        this.selectedNodeId = null;
        this.selectedEdgeId = existingEdge.id;
      } else {
        this.selectedNodeId = fromNodeId;
        this.selectedEdgeId = null;
      }
      this.renderCanvas();
      return;
    }

    const edge: JsonCanvasEdge = {
      id: this.createUniqueId('edge'),
      fromNode: fromNodeId,
      fromSide: this.resolveSide(from, to),
      toNode: toNodeId,
      toSide: this.resolveSide(to, from),
      toEnd: 'arrow',
    };

    this.edges.push(edge);
    if (selectEdge) {
      this.selectedNodeId = null;
      this.selectedEdgeId = edge.id;
    } else {
      this.selectedNodeId = fromNodeId;
      this.selectedEdgeId = null;
    }
    this.commitCanvasChange();
  }

  private selectNode(nodeId: string): void {
    if (this.cardLinkPickerOpen && this.cardLinkSourceNodeId !== nodeId) {
      this.closeCardLinkPicker();
    }

    this.selectedNodeId = nodeId;
    this.selectedEdgeId = null;
    this.renderCanvas();
  }

  private selectEdge(edgeId: string): void {
    this.closeCardLinkPicker();
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.stage?.container().style.setProperty('cursor', 'default');
    this.selectedEdgeId = edgeId;
    this.selectedNodeId = null;
    this.renderCanvas();
  }

  private commitCanvasChange(render = true): void {
    const previousCanvas = this.lastSerializedCanvas;
    const nextCanvas = this.serializeCanvas();
    if (nextCanvas === previousCanvas) {
      if (render) {
        this.renderCanvas();
      }
      return;
    }

    if (previousCanvas) {
      this.undoStack.push(previousCanvas);
      if (this.undoStack.length > this.maxHistoryEntries) {
        this.undoStack.shift();
      }
    }
    this.redoStack = [];
    this.lastSerializedCanvas = nextCanvas;
    if (render) {
      this.renderCanvas();
    }
    this.canvasJsonChange.emit(this.lastSerializedCanvas);
  }

  undoCanvasChange(): void {
    if (this.readonly || this.undoStack.length === 0) return;

    const currentCanvas = this.lastSerializedCanvas || this.serializeCanvas();
    const previousCanvas = this.undoStack.pop();
    if (!previousCanvas) return;

    this.redoStack.push(currentCanvas);
    this.restoreCanvasSnapshot(previousCanvas);
  }

  redoCanvasChange(): void {
    if (this.readonly || this.redoStack.length === 0) return;

    const currentCanvas = this.lastSerializedCanvas || this.serializeCanvas();
    const nextCanvas = this.redoStack.pop();
    if (!nextCanvas) return;

    this.undoStack.push(currentCanvas);
    if (this.undoStack.length > this.maxHistoryEntries) {
      this.undoStack.shift();
    }
    this.restoreCanvasSnapshot(nextCanvas);
  }

  private restoreCanvasSnapshot(canvasJson: string): void {
    const selectedNodeId = this.selectedNodeId;
    const selectedEdgeId = this.selectedEdgeId;

    this.clearPreviewCache();
    this.loadCanvasJson(canvasJson);
    this.selectedNodeId = selectedNodeId && this.nodes.some(node => node.id === selectedNodeId)
      ? selectedNodeId
      : null;
    this.selectedEdgeId = selectedEdgeId && this.edges.some(edge => edge.id === selectedEdgeId)
      ? selectedEdgeId
      : null;
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.renderCanvas();
    this.canvasJsonChange.emit(this.lastSerializedCanvas);
  }

  private resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private copySelectedNode(): void {
    const node = this.selectedNode;
    if (!node) return;

    this.copiedNode = this.cloneJson(node);
  }

  private pasteCopiedNode(): void {
    if (this.readonly || !this.copiedNode) return;

    const node = this.createNodeCopy(this.copiedNode);
    this.nodes.push(node);
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  private duplicateSelectedNode(): void {
    const node = this.selectedNode;
    if (this.readonly || !node) return;

    this.copiedNode = this.cloneJson(node);
    this.pasteCopiedNode();
  }

  private createNodeCopy(source: JsonCanvasNode): JsonCanvasNode {
    const selected = this.selectedNode;
    const viewportCenter = this.getViewportCenter();
    const x = selected
      ? selected.x + 36
      : Math.round(viewportCenter.x - source.width / 2);
    const y = selected
      ? selected.y + 36
      : Math.round(viewportCenter.y - source.height / 2);

    return {
      ...this.cloneJson(source),
      id: this.createUniqueId('node'),
      x,
      y,
    };
  }

  private cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private ensureNodePreview(node: JsonCanvasNode): void {
    if (node.type === 'file') {
      this.ensureFileNodePreview(node);
      return;
    }

    if (node.type === 'link') {
      this.ensureLinkNodePreview(node);
    }
  }

  private ensureFileNodePreview(node: JsonCanvasNode): void {
    if (node.type !== 'file') return;

    const filePath = this.getStringField(node, 'file').trim();
    if (!filePath) return;

    const cacheKey = this.getPreviewCacheKey(filePath, 'file');
    if (this.previewCache.has(cacheKey)) return;

    const loadingPreview: CanvasFilePreview = {
      status: 'loading',
      kind: this.getPreviewKindFromPath(filePath),
      title: this.getFilename(filePath) || 'File',
      subtitle: 'Loading preview',
      icon: 'hourglass_empty',
      objectUrls: [],
    };
    this.previewCache.set(cacheKey, loadingPreview);
    this.syncPreviewOverlays();

    void this.loadFileNodePreview(filePath, cacheKey, loadingPreview);
  }

  private ensureLinkNodePreview(node: JsonCanvasNode): void {
    if (node.type !== 'link') return;

    const url = this.getStringField(node, 'url').trim();
    if (!this.isPreviewableWebUrl(url)) return;

    const cacheKey = this.getPreviewCacheKey(url, 'link');
    if (this.previewCache.has(cacheKey)) return;

    const loadingPreview: CanvasFilePreview = {
      status: 'loading',
      kind: 'webpage',
      title: this.getUrlHostname(url) || 'Web page',
      subtitle: 'Loading preview',
      icon: 'link',
      objectUrls: [],
    };
    this.previewCache.set(cacheKey, loadingPreview);
    this.syncPreviewOverlays();

    void this.loadLinkNodePreview(url, cacheKey, loadingPreview);
  }

  private async loadFileNodePreview(
    filePath: string,
    cacheKey: string,
    loadingPreview: CanvasFilePreview
  ): Promise<void> {
    try {
      const preview = await this.createFilePreview(filePath);
      if (this.destroyed || this.previewCache.get(cacheKey) !== loadingPreview) {
        this.revokePreviewObjectUrls(preview);
        return;
      }

      this.previewCache.set(cacheKey, preview);
    } catch (error) {
      if (this.destroyed || this.previewCache.get(cacheKey) !== loadingPreview) return;

      console.warn('[ObsidianCanvasEditor] Failed to load file preview', filePath, error);
      this.previewCache.set(cacheKey, {
        status: 'error',
        kind: 'generic',
        title: this.getFilename(filePath) || 'File',
        subtitle: 'Preview unavailable',
        icon: 'insert_drive_file',
        objectUrls: [],
      });
    }

    this.syncPreviewOverlays();
  }

  private async loadLinkNodePreview(
    url: string,
    cacheKey: string,
    loadingPreview: CanvasFilePreview
  ): Promise<void> {
    try {
      const preview = await this.createLinkPreview(url);
      if (this.destroyed || this.previewCache.get(cacheKey) !== loadingPreview) return;

      this.previewCache.set(cacheKey, preview);
    } catch (error) {
      if (this.destroyed || this.previewCache.get(cacheKey) !== loadingPreview) return;

      console.warn('[ObsidianCanvasEditor] Failed to load link preview', url, error);
      this.previewCache.set(cacheKey, this.createFallbackWebpagePreview(url));
    }

    this.syncPreviewOverlays();
  }

  private async createFilePreview(filePath: string): Promise<CanvasFilePreview> {
    const cleanPath = this.cleanVaultPath(filePath);
    const title = this.getFilename(cleanPath) || 'File';

    if (this.isExternalUrl(cleanPath)) {
      return this.createExternalPreview(cleanPath);
    }

    if (!this.serverId) {
      return {
        status: 'ready',
        kind: 'generic',
        title,
        subtitle: cleanPath,
        icon: this.getFileIcon(cleanPath),
        objectUrls: [],
      };
    }

    const resolvedPath = await this.resolveVaultPath(cleanPath, this.currentFilePath);
    if (!resolvedPath) {
      throw new Error(`Unable to resolve ${cleanPath}`);
    }

    if (this.isNotePath(resolvedPath)) {
      return this.createNotePreview(resolvedPath);
    }

    const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
    const objectUrl = URL.createObjectURL(blob);
    const objectUrls = [objectUrl];
    const subtitle = resolvedPath;

    if (this.isImagePath(resolvedPath)) {
      return {
        status: 'ready',
        kind: 'image',
        title,
        subtitle,
        icon: 'image',
        objectUrls,
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(objectUrl),
      };
    }

    if (this.isPdfPath(resolvedPath)) {
      return {
        status: 'ready',
        kind: 'pdf',
        title,
        subtitle,
        icon: 'picture_as_pdf',
        objectUrls,
        safeResourceUrl: this.sanitizer.bypassSecurityTrustResourceUrl(objectUrl),
      };
    }

    if (this.isVideoPath(resolvedPath)) {
      return {
        status: 'ready',
        kind: 'video',
        title,
        subtitle,
        icon: 'movie',
        objectUrls,
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(objectUrl),
      };
    }

    if (this.isAudioPath(resolvedPath)) {
      return {
        status: 'ready',
        kind: 'audio',
        title,
        subtitle,
        icon: 'graphic_eq',
        objectUrls,
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(objectUrl),
      };
    }

    this.revokeObjectUrl(objectUrl);
    return {
      status: 'ready',
      kind: 'generic',
      title,
      subtitle,
      icon: this.getFileIcon(resolvedPath),
      objectUrls: [],
    };
  }

  private createExternalPreview(url: string): CanvasFilePreview {
    const title = this.getFilename(url) || this.trimUrl(url);

    if (this.isImagePath(url)) {
      return {
        status: 'ready',
        kind: 'image',
        title,
        subtitle: this.trimUrl(url),
        icon: 'image',
        objectUrls: [],
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(url),
      };
    }

    if (this.isPdfPath(url)) {
      return {
        status: 'ready',
        kind: 'pdf',
        title,
        subtitle: this.trimUrl(url),
        icon: 'picture_as_pdf',
        objectUrls: [],
        safeResourceUrl: this.sanitizer.bypassSecurityTrustResourceUrl(url),
      };
    }

    if (this.isVideoPath(url)) {
      return {
        status: 'ready',
        kind: 'video',
        title,
        subtitle: this.trimUrl(url),
        icon: 'movie',
        objectUrls: [],
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(url),
      };
    }

    if (this.isAudioPath(url)) {
      return {
        status: 'ready',
        kind: 'audio',
        title,
        subtitle: this.trimUrl(url),
        icon: 'graphic_eq',
        objectUrls: [],
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(url),
      };
    }

    return {
      status: 'ready',
      kind: 'generic',
      title,
      subtitle: this.trimUrl(url),
      icon: 'link',
      objectUrls: [],
    };
  }

  private async createLinkPreview(url: string): Promise<CanvasFilePreview> {
    const videoEmbed = this.getVideoEmbedPreview(url);
    if (videoEmbed) return videoEmbed;

    const metadata = await this.fetchWebpageMetadata(url);
    if (!metadata) {
      return this.createFallbackWebpagePreview(url);
    }

    const host = this.getUrlHostname(url);
    const imageUrl = metadata.imageUrl ? this.resolveUrl(metadata.imageUrl, url) : '';
    const title = metadata.title || this.getReadableUrlTitle(url) || host || 'Web page';

    return {
      status: 'ready',
      kind: imageUrl ? 'webpage-image' : 'webpage',
      title,
      subtitle: host || this.trimUrl(url),
      text: metadata.description || this.trimUrl(url),
      siteName: metadata.siteName || host,
      faviconUrl: this.getFaviconUrl(url),
      icon: 'link',
      objectUrls: [],
      safeUrl: imageUrl ? this.sanitizer.bypassSecurityTrustUrl(imageUrl) : undefined,
    };
  }

  private getVideoEmbedPreview(url: string): CanvasFilePreview | null {
    const embed = this.getVideoEmbed(url);
    if (!embed) return null;

    return {
      status: 'ready',
      kind: 'video-embed',
      title: embed.title,
      subtitle: embed.subtitle,
      text: embed.platform,
      siteName: embed.platform,
      faviconUrl: this.getFaviconUrl(url),
      icon: 'smart_display',
      objectUrls: [],
      safeResourceUrl: this.sanitizer.bypassSecurityTrustResourceUrl(embed.embedUrl),
    };
  }

  private createFallbackWebpagePreview(url: string): CanvasFilePreview {
    const host = this.getUrlHostname(url);
    const title = this.getReadableUrlTitle(url) || host || 'Web page';

    return {
      status: 'ready',
      kind: 'webpage',
      title,
      subtitle: host || this.trimUrl(url),
      text: this.trimUrl(url),
      siteName: host,
      faviconUrl: this.getFaviconUrl(url),
      icon: 'link',
      objectUrls: [],
    };
  }

  private async fetchWebpageMetadata(url: string): Promise<{
    title: string;
    description: string;
    imageUrl: string;
    siteName: string;
  } | null> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4500);

    try {
      const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'omit',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return null;

      const html = await response.text();
      const document = new DOMParser().parseFromString(html, 'text/html');
      return {
        title: this.getDocumentMeta(document, 'og:title', 'twitter:title') || document.title.trim(),
        description: this.getDocumentMeta(
          document,
          'og:description',
          'twitter:description',
          'description'
        ),
        imageUrl: this.getDocumentMeta(document, 'og:image', 'twitter:image'),
        siteName: this.getDocumentMeta(document, 'og:site_name', 'application-name'),
      };
    } catch (error) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private getDocumentMeta(document: Document, ...names: string[]): string {
    const metaElements = Array.from(document.querySelectorAll('meta'));
    for (const name of names) {
      const element = metaElements.find(meta =>
        meta.getAttribute('property') === name || meta.getAttribute('name') === name
      );
      const value = element?.getAttribute('content')?.trim();
      if (value) return value;
    }

    return '';
  }

  private async createNotePreview(notePath: string): Promise<CanvasFilePreview> {
    const text = await this.obsidianVaultService.readFile(this.serverId, notePath);
    const noteTitle = this.getLinkedFileTitle(notePath);

    for (const imageTarget of this.findMarkdownImageTargets(text)) {
      const imagePreview = await this.createNoteImagePreview(notePath, imageTarget, noteTitle);
      if (imagePreview) return imagePreview;
    }

    return {
      status: 'ready',
      kind: 'note',
      title: noteTitle,
      subtitle: notePath,
      text: this.getNoteExcerpt(text),
      icon: 'description',
      objectUrls: [],
    };
  }

  private async createNoteImagePreview(
    notePath: string,
    imageTarget: string,
    noteTitle: string
  ): Promise<CanvasFilePreview | null> {
    const cleanTarget = this.cleanMarkdownUrl(imageTarget);
    if (this.isExternalUrl(cleanTarget)) {
      return {
        status: 'ready',
        kind: 'note-image',
        title: noteTitle,
        subtitle: cleanTarget,
        icon: 'image',
        objectUrls: [],
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(cleanTarget),
      };
    }

    const resolvedImagePath = await this.resolveVaultPath(cleanTarget, notePath, true);
    if (!resolvedImagePath || !this.isImagePath(resolvedImagePath)) return null;

    try {
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedImagePath);
      const objectUrl = URL.createObjectURL(blob);
      return {
        status: 'ready',
        kind: 'note-image',
        title: noteTitle,
        subtitle: resolvedImagePath,
        icon: 'image',
        objectUrls: [objectUrl],
        safeUrl: this.sanitizer.bypassSecurityTrustUrl(objectUrl),
      };
    } catch (error) {
      console.warn('[ObsidianCanvasEditor] Failed to load note image preview', resolvedImagePath, error);
      return null;
    }
  }

  private syncPreviewOverlays(): void {
    if (this.previewOverlayFrame !== null || this.destroyed) return;

    this.previewOverlayFrame = requestAnimationFrame(() => {
      this.previewOverlayFrame = null;
      if (this.destroyed) return;

      this.previewOverlays = this.buildPreviewOverlays();
      this.changeDetectorRef.detectChanges();
    });
  }

  private buildPreviewOverlays(): CanvasPreviewOverlay[] {
    if (!this.stage || this.parseError) return [];

    const scale = this.stage.scaleX() || 1;
    const stageX = this.stage.x();
    const stageY = this.stage.y();
    const inset = 10;
    const overlays: CanvasPreviewOverlay[] = [];

    this.nodes
      .filter(node => node.type === 'file' || node.type === 'link')
      .forEach(node => {
        const source = node.type === 'file'
          ? this.getStringField(node, 'file').trim()
          : this.getStringField(node, 'url').trim();
        if (!source) return;

        const preview = this.previewCache.get(this.getPreviewCacheKey(source, node.type));
        if (!preview) return;

        const width = Math.max(24, node.width - inset * 2);
        const height = Math.max(24, node.height - inset * 2);
        const overlay: CanvasPreviewOverlay = {
          nodeId: node.id,
          status: preview.status,
          kind: preview.kind,
          title: preview.title,
          subtitle: preview.subtitle,
          text: preview.text || '',
          siteName: preview.siteName || '',
          faviconUrl: preview.faviconUrl || '',
          icon: preview.icon,
          style: {
            left: `${stageX + (node.x + inset) * scale}px`,
            top: `${stageY + (node.y + inset) * scale}px`,
            width: `${width}px`,
            height: `${height}px`,
            transform: `scale(${scale})`,
          },
        };

        if (preview.safeUrl) {
          overlay.safeUrl = preview.safeUrl;
        }

        if (preview.safeResourceUrl) {
          overlay.safeResourceUrl = preview.safeResourceUrl;
        }

        overlays.push(overlay);
      });

    return overlays;
  }

  private clearPreviewCache(): void {
    this.previewCache.forEach(preview => this.revokePreviewObjectUrls(preview));
    this.previewCache.clear();
    this.previewOverlays = [];
  }

  private revokePreviewObjectUrls(preview: CanvasFilePreview): void {
    preview.objectUrls.forEach(url => this.revokeObjectUrl(url));
  }

  private revokeObjectUrl(url: string): void {
    URL.revokeObjectURL(url);
  }

  private addDroppedFileNode(payload: VaultFileDragPayload, clientX: number, clientY: number): void {
    const point = this.getCanvasPointFromClient(clientX, clientY) || this.getViewportCenter();
    const size = this.getDefaultFileNodeSize(payload.relativePath);
    const node: JsonCanvasNode = {
      id: this.createUniqueId('node'),
      type: 'file',
      x: Math.round(point.x - size.width / 2),
      y: Math.round(point.y - size.height / 2),
      width: size.width,
      height: size.height,
      file: payload.relativePath,
    };

    this.nodes.push(node);
    this.connectionMode = false;
    this.connectionSourceNodeId = null;
    this.selectNode(node.id);
    this.commitCanvasChange();
  }

  private canAcceptVaultFileDrop(event: DragEvent): boolean {
    if (this.readonly || this.parseError || !event.dataTransfer) return false;
    return Array.from(event.dataTransfer.types).includes(this.vaultEntryDragType);
  }

  private getVaultFileDragPayload(event: DragEvent): VaultFileDragPayload | null {
    const raw = event.dataTransfer?.getData(this.vaultEntryDragType);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<VaultFileDragPayload>;
      if (
        (parsed.kind === 'file' || parsed.kind === 'directory') &&
        typeof parsed.name === 'string' &&
        typeof parsed.relativePath === 'string'
      ) {
        return {
          kind: parsed.kind,
          name: parsed.name,
          relativePath: parsed.relativePath,
          parentPath: typeof parsed.parentPath === 'string' ? parsed.parentPath : undefined,
        };
      }
    } catch (error) {
      console.warn('[ObsidianCanvasEditor] Failed to parse dropped vault file payload', error);
    }

    return null;
  }

  private serializeCanvas(): string {
    return JSON.stringify({
      ...this.canvasDocument,
      nodes: this.nodes.map(node => ({
        ...node,
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: Math.round(node.width),
        height: Math.round(node.height),
      })),
      edges: this.edges,
    }, null, 2);
  }

  private resizeStage(): void {
    const container = this.stageContainer?.nativeElement;
    if (!this.stage || !container) return;

    this.stage.size({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    });
    this.renderCanvas();
  }

  private handleWheelZoom(event: Konva.KonvaEventObject<WheelEvent>): void {
    if (!this.stage) return;

    event.evt.preventDefault();
    const oldScale = this.stage.scaleX();
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - this.stage.x()) / oldScale,
      y: (pointer.y - this.stage.y()) / oldScale,
    };

    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const scaleBy = 1.08;
    const newScale = this.clampScale(direction > 0 ? oldScale * scaleBy : oldScale / scaleBy);

    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
    this.stage.batchDraw();
    this.updateZoomPercent();
    this.syncPreviewOverlays();
  }

  private zoomBy(multiplier: number): void {
    if (!this.stage) return;

    const oldScale = this.stage.scaleX();
    const newScale = this.clampScale(oldScale * multiplier);
    const center = {
      x: this.stage.width() / 2,
      y: this.stage.height() / 2,
    };
    const point = {
      x: (center.x - this.stage.x()) / oldScale,
      y: (center.y - this.stage.y()) / oldScale,
    };

    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({
      x: center.x - point.x * newScale,
      y: center.y - point.y * newScale,
    });
    this.stage.batchDraw();
    this.updateZoomPercent();
    this.syncPreviewOverlays();
  }

  private updateZoomPercent(): void {
    this.zoomPercent = Math.round((this.stage?.scaleX() || 1) * 100);
  }

  private getViewportCenter(): CanvasPoint {
    if (!this.stage) return { x: 0, y: 0 };
    const scale = this.stage.scaleX() || 1;
    return {
      x: (this.stage.width() / 2 - this.stage.x()) / scale,
      y: (this.stage.height() / 2 - this.stage.y()) / scale,
    };
  }

  private getCanvasPointFromClient(clientX: number, clientY: number): CanvasPoint | null {
    if (!this.stage || !this.stageContainer) return null;

    const rect = this.stageContainer.nativeElement.getBoundingClientRect();
    const scale = this.stage.scaleX() || 1;
    return {
      x: (clientX - rect.left - this.stage.x()) / scale,
      y: (clientY - rect.top - this.stage.y()) / scale,
    };
  }

  private getNodeBounds(): { x: number; y: number; width: number; height: number } {
    const left = Math.min(...this.nodes.map(node => node.x));
    const top = Math.min(...this.nodes.map(node => node.y));
    const right = Math.max(...this.nodes.map(node => node.x + node.width));
    const bottom = Math.max(...this.nodes.map(node => node.y + node.height));

    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  private resolveSide(node: JsonCanvasNode, target: JsonCanvasNode, requested?: string): JsonCanvasSide {
    if (requested === 'top' || requested === 'right' || requested === 'bottom' || requested === 'left') {
      return requested;
    }

    const nodeCenter = this.getNodeCenter(node);
    const targetCenter = this.getNodeCenter(target);
    const dx = targetCenter.x - nodeCenter.x;
    const dy = targetCenter.y - nodeCenter.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      return dx >= 0 ? 'right' : 'left';
    }

    return dy >= 0 ? 'bottom' : 'top';
  }

  private getAnchorPoint(node: JsonCanvasNode, side: JsonCanvasSide): CanvasPoint {
    if (side === 'top') return { x: node.x + node.width / 2, y: node.y };
    if (side === 'right') return { x: node.x + node.width, y: node.y + node.height / 2 };
    if (side === 'bottom') return { x: node.x + node.width / 2, y: node.y + node.height };
    return { x: node.x, y: node.y + node.height / 2 };
  }

  private getNodeCenter(node: JsonCanvasNode): CanvasPoint {
    return {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    };
  }

  private getNodeTitle(node: JsonCanvasNode): string {
    if (node.type === 'file') {
      const file = this.getStringField(node, 'file');
      return file.split('/').pop() || file || 'File';
    }

    if (node.type === 'link') {
      const url = this.getStringField(node, 'url');
      return this.trimUrl(url) || 'Link';
    }

    if (node.type === 'group') {
      return this.getStringField(node, 'label') || 'Group';
    }

    const text = this.getStringField(node, 'text').trim();
    return text.split(/\r?\n/)[0] || 'Text';
  }

  private getNodeBody(node: JsonCanvasNode): string {
    if (node.type === 'text') {
      return this.getStringField(node, 'text').split(/\r?\n/).slice(1).join('\n');
    }

    if (node.type === 'file') {
      const subpath = this.getStringField(node, 'subpath');
      return subpath || this.getStringField(node, 'file');
    }

    if (node.type === 'link') {
      return this.getStringField(node, 'url');
    }

    return '';
  }

  private getNodeFill(node: JsonCanvasNode): string {
    if (node.type === 'group') {
      return this.resolveCanvasColor(node.color, 'rgba(255, 255, 255, 0.045)', 0.2);
    }

    if (node.type === 'file' && !node.color) {
      const filePath = this.getStringField(node, 'file');
      if (this.isImagePath(filePath)) return 'rgba(34, 211, 238, 0.14)';
      if (this.isVideoPath(filePath)) return 'rgba(167, 139, 250, 0.14)';
      if (this.isAudioPath(filePath)) return 'rgba(244, 114, 182, 0.14)';
      if (this.isPdfPath(filePath)) return 'rgba(248, 113, 113, 0.14)';
    }

    return this.resolveCanvasColor(node.color, this.getThemeColor('--surface', '#1e1f22'));
  }

  private getNodeStroke(node: JsonCanvasNode): string {
    if (node.type === 'group') {
      return this.resolveCanvasColor(node.color, this.getThemeColor('--outline', 'rgba(114, 137, 218, 0.25)'));
    }

    return this.resolveCanvasColor(node.color, this.getThemeColor('--outline', 'rgba(114, 137, 218, 0.25)'));
  }

  private getNodeTextFill(node: JsonCanvasNode, muted = false): string {
    const color = typeof node.color === 'string' ? node.color.trim() : '';
    if (color && !this.isPresetCanvasColor(color) && this.isLightColor(this.resolveCanvasColor(color, '#1e1f22'))) {
      return muted ? '#304154' : '#13202c';
    }

    return muted
      ? this.getThemeColor('--on-surface-variant', 'rgba(255, 255, 255, 0.7)')
      : this.getThemeColor('--on-background', '#ffffff');
  }

  private resolveCanvasColor(color: unknown, fallback: string, alpha?: number): string {
    if (typeof color !== 'string' || !color.trim()) return fallback;
    const value = color.trim();

    const presets: Record<string, string> = {
      '1': 'rgba(248, 113, 113, 0.22)',
      '2': 'rgba(251, 146, 60, 0.22)',
      '3': 'rgba(250, 204, 21, 0.2)',
      '4': 'rgba(74, 222, 128, 0.2)',
      '5': this.getThemeRgbColor('--primary-rgb', '114, 137, 218', 0.22),
      '6': 'rgba(167, 139, 250, 0.22)',
    };

    const resolved = presets[value] || value;
    if (alpha === undefined || !/^#[0-9a-f]{6}$/i.test(resolved)) {
      return resolved;
    }

    const red = Number.parseInt(resolved.slice(1, 3), 16);
    const green = Number.parseInt(resolved.slice(3, 5), 16);
    const blue = Number.parseInt(resolved.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  private isPresetCanvasColor(color: string): boolean {
    return ['1', '2', '3', '4', '5', '6'].includes(color.trim());
  }

  private isLightColor(color: string): boolean {
    const rgb = this.parseRgbColor(color);
    if (!rgb) return false;

    const luminance = (0.2126 * rgb.red + 0.7152 * rgb.green + 0.0722 * rgb.blue) / 255;
    return luminance > 0.62;
  }

  private parseRgbColor(color: string): { red: number; green: number; blue: number } | null {
    const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      return {
        red: Number.parseInt(hex[1].slice(0, 2), 16),
        green: Number.parseInt(hex[1].slice(2, 4), 16),
        blue: Number.parseInt(hex[1].slice(4, 6), 16),
      };
    }

    const rgb = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!rgb) return null;

    return {
      red: Number(rgb[1]),
      green: Number(rgb[2]),
      blue: Number(rgb[3]),
    };
  }

  private getStringField(node: JsonCanvasNode, field: CanvasNodeField): string {
    const value = node[field];
    return typeof value === 'string' ? value : '';
  }

  private trimUrl(url: string): string {
    return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  private getColorPickerValue(color: string, fallback: string): string {
    const resolved = this.resolveCanvasColor(color, fallback);
    if (/^#[0-9a-f]{6}$/i.test(resolved)) {
      return resolved;
    }

    const shortHex = resolved.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (shortHex) {
      return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`;
    }

    return fallback;
  }

  private isColorOptionActive(currentColor: string, option: CanvasColorOption): boolean {
    const current = currentColor.trim().toLowerCase();
    if (!current) return false;

    return current === option.value || this.getColorPickerValue(current, option.hex).toLowerCase() === option.hex;
  }

  private isPreviewableWebUrl(url: string): boolean {
    if (!/^https?:\/\/\S+/i.test(url.trim())) return false;

    try {
      new URL(url);
      return true;
    } catch (error) {
      return false;
    }
  }

  private getUrlHostname(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (error) {
      return '';
    }
  }

  private getFaviconUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}/favicon.ico`;
    } catch (error) {
      return '';
    }
  }

  private getReadableUrlTitle(url: string): string {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname
        .split('/')
        .map(part => part.trim())
        .filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1] || '';
      const title = decodeURIComponent(lastPart)
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[-_+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (title) return this.toTitleCase(title);
      return parsed.hostname.replace(/^www\./i, '');
    } catch (error) {
      return this.trimUrl(url);
    }
  }

  private resolveUrl(value: string, baseUrl: string): string {
    try {
      return new URL(value, baseUrl).toString();
    } catch (error) {
      return value;
    }
  }

  private toTitleCase(value: string): string {
    return value.replace(/\b\w/g, letter => letter.toUpperCase());
  }

  private getVideoEmbed(url: string): {
    embedUrl: string;
    platform: string;
    title: string;
    subtitle: string;
  } | null {
    const youtubeId = this.getYouTubeVideoId(url);
    if (youtubeId) {
      return {
        embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(youtubeId)}`,
        platform: 'YouTube',
        title: 'YouTube video',
        subtitle: this.getUrlHostname(url),
      };
    }

    const tiktokId = this.getTikTokVideoId(url);
    if (tiktokId) {
      return {
        embedUrl: `https://www.tiktok.com/embed/v2/${encodeURIComponent(tiktokId)}`,
        platform: 'TikTok',
        title: 'TikTok video',
        subtitle: this.getUrlHostname(url),
      };
    }

    const instagramEmbedPath = this.getInstagramEmbedPath(url);
    if (instagramEmbedPath) {
      return {
        embedUrl: `https://www.instagram.com${instagramEmbedPath}/embed`,
        platform: 'Instagram',
        title: instagramEmbedPath.startsWith('/reel/') ? 'Instagram reel' : 'Instagram post',
        subtitle: this.getUrlHostname(url),
      };
    }

    return null;
  }

  private getYouTubeVideoId(url: string): string {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();

      if (hostname === 'youtu.be') {
        return parsed.pathname.split('/').filter(Boolean)[0] || '';
      }

      if (!hostname.endsWith('youtube.com')) return '';

      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v') || '';
      }

      const match = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/i);
      return match?.[1] || '';
    } catch (error) {
      return '';
    }
  }

  private getTikTokVideoId(url: string): string {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.toLowerCase().includes('tiktok.com')) return '';

      return parsed.pathname.match(/\/video\/(\d+)/i)?.[1] || '';
    } catch (error) {
      return '';
    }
  }

  private getInstagramEmbedPath(url: string): string {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.toLowerCase().includes('instagram.com')) return '';

      const match = parsed.pathname.match(/^\/(p|reel|tv)\/([^/?#]+)/i);
      return match ? `/${match[1].toLowerCase()}/${match[2]}` : '';
    } catch (error) {
      return '';
    }
  }

  private getPreviewCacheKey(filePath: string, kind = 'file'): string {
    return [
      kind,
      this.serverId || 'no-server',
      this.cleanVaultPath(this.currentFilePath || ''),
      this.cleanVaultPath(filePath),
    ].join('::');
  }

  private getPreviewKindFromPath(path: string): CanvasPreviewKind {
    if (this.isImagePath(path)) return 'image';
    if (this.isPdfPath(path)) return 'pdf';
    if (this.isVideoPath(path)) return 'video';
    if (this.isAudioPath(path)) return 'audio';
    if (this.isNotePath(path)) return 'note';
    return 'generic';
  }

  private getFileIcon(path: string): string {
    if (this.isImagePath(path)) return 'image';
    if (this.isPdfPath(path)) return 'picture_as_pdf';
    if (this.isVideoPath(path)) return 'movie';
    if (this.isAudioPath(path)) return 'graphic_eq';
    if (this.isNotePath(path)) return 'description';
    return 'insert_drive_file';
  }

  private async resolveVaultPath(
    filePath: string,
    sourceFilePath: string,
    preferImage = false
  ): Promise<string | null> {
    const cleanPath = this.cleanVaultPath(filePath);
    if (!this.serverId || !cleanPath || this.isExternalUrl(cleanPath)) return null;

    const candidates = this.getPathCandidates(cleanPath, preferImage);
    const sourceDir = this.cleanVaultPath(sourceFilePath).split('/').slice(0, -1).join('/');

    for (const candidate of candidates) {
      const directMatch = await this.tryResolveExistingVaultFile(candidate);
      if (directMatch) return directMatch;

      if (sourceDir) {
        const relativePath = this.obsidianVaultService.resolveRelativePath(sourceDir, candidate);
        const relativeMatch = await this.tryResolveExistingVaultFile(relativePath);
        if (relativeMatch) return relativeMatch;
      }

      const filename = candidate.split('/').pop();
      if (filename) {
        const foundByFilename = await this.obsidianVaultService.findFileByFilename(this.serverId, filename);
        if (foundByFilename) return foundByFilename;
      }
    }

    return null;
  }

  private async tryResolveExistingVaultFile(path: string): Promise<string | null> {
    try {
      await this.obsidianVaultService.readFileAsBlob(this.serverId, path);
      return path;
    } catch (error) {
      return null;
    }
  }

  private getPathCandidates(path: string, preferImage: boolean): string[] {
    if (this.getFileExtension(path)) return [path];

    const extensions = preferImage ? this.imageExtensions : this.noteExtensions;
    return [path, ...extensions.map(extension => `${path}.${extension}`)];
  }

  private findMarkdownImageTargets(markdown: string): string[] {
    const targets: Array<{ index: number; path: string }> = [];
    const markdownImageRegex = /!\[[^\]]*]\(([^)]+)\)/g;
    const obsidianEmbedRegex = /!\[\[([^\]]+)]]/g;

    for (const match of markdown.matchAll(markdownImageRegex)) {
      const path = this.cleanMarkdownUrl(match[1] || '');
      if (this.canBeImageTarget(path)) {
        targets.push({ index: match.index || 0, path });
      }
    }

    for (const match of markdown.matchAll(obsidianEmbedRegex)) {
      const path = this.cleanMarkdownUrl((match[1] || '').split('|')[0] || '');
      if (this.canBeImageTarget(path)) {
        targets.push({ index: match.index || 0, path });
      }
    }

    return targets
      .sort((a, b) => a.index - b.index)
      .map(target => target.path);
  }

  private canBeImageTarget(path: string): boolean {
    const extension = this.getFileExtension(path);
    return this.isExternalUrl(path) || !extension || this.imageExtensions.includes(extension);
  }

  private getLinkedFileTitle(path: string): string {
    return this.getFilename(path).replace(/\.(md|markdown)$/i, '') || 'Note';
  }

  private getNoteExcerpt(markdown: string): string {
    const withoutFrontmatter = markdown.replace(/^---\s*[\s\S]*?\n---\s*/m, '');
    const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, ' ');
    const withoutImages = withoutCode
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/!\[\[[^\]]+]]/g, ' ');
    const plainText = withoutImages
      .split(/\r?\n/)
      .map(line => this.stripMarkdownInline(line).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!plainText) return 'Empty note';
    return plainText.length > 240 ? `${plainText.slice(0, 237).trim()}...` : plainText;
  }

  private stripMarkdownInline(value: string): string {
    return value
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, target: string, alias: string) => alias || target)
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
      .replace(/[`*_~>#|-]/g, '')
      .trim();
  }

  private cleanMarkdownUrl(url: string): string {
    let value = url.trim().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\\/g, '/');
    value = value.replace(/^<+|>+$/g, '');
    value = value.replace(/^["']|["']$/g, '');
    value = value.replace(/\s+["'][^"']*["']$/g, '');

    try {
      value = decodeURI(value);
    } catch (error) {
      return value;
    }

    return value;
  }

  private cleanVaultPath(path: string): string {
    if (this.isExternalUrl(path)) return path.trim();

    return this.cleanMarkdownUrl(path)
      .replace(/^file:\/\/\//i, '')
      .replace(/^wikilink-blob:/i, '')
      .split('#')[0]
      .split('?')[0]
      .replace(/^\/+/, '');
  }

  private normalizeSearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getFilename(path: string): string {
    const cleanPath = path.split('#')[0].split('?')[0].replace(/\\/g, '/');
    return cleanPath.split('/').pop() || cleanPath;
  }

  private isExternalUrl(path: string): boolean {
    return /^https?:\/\//i.test(path.trim());
  }

  private isNotePath(path: string): boolean {
    return this.noteExtensions.includes(this.getFileExtension(path));
  }

  private getDefaultFileNodeSize(path: string): { width: number; height: number } {
    if (this.isImagePath(path)) return { width: 340, height: 220 };
    if (this.isVideoPath(path)) return { width: 340, height: 180 };
    if (this.isAudioPath(path)) return { width: 320, height: 126 };
    if (this.isPdfPath(path)) return { width: 300, height: 150 };
    if (this.isNotePath(path)) return { width: 320, height: 180 };
    return { width: 300, height: 140 };
  }

  private getFileKindLabel(path: string): string {
    if (this.isImagePath(path)) return 'IMAGE';
    if (this.isVideoPath(path)) return 'VIDEO';
    if (this.isAudioPath(path)) return 'AUDIO';
    if (this.isPdfPath(path)) return 'PDF';

    const extension = this.getFileExtension(path);
    return extension ? extension.toUpperCase() : 'FILE';
  }

  private getFileKindBadgeFill(path: string): string {
    if (this.isImagePath(path)) return '#67e8f9';
    if (this.isVideoPath(path)) return '#c4b5fd';
    if (this.isAudioPath(path)) return '#f9a8d4';
    if (this.isPdfPath(path)) return '#fca5a5';
    return '#cbd5e1';
  }

  private isImagePath(path: string): boolean {
    return this.imageExtensions.includes(this.getFileExtension(path));
  }

  private isVideoPath(path: string): boolean {
    return this.videoExtensions.includes(this.getFileExtension(path));
  }

  private isAudioPath(path: string): boolean {
    return this.audioExtensions.includes(this.getFileExtension(path));
  }

  private isPdfPath(path: string): boolean {
    return this.getFileExtension(path) === 'pdf';
  }

  private getFileExtension(path: string): string {
    const cleanPath = path.split('#')[0].split('?')[0];
    const filename = cleanPath.split('/').pop() || cleanPath;
    const dotIndex = filename.lastIndexOf('.');
    return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';
  }

  private toInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  }

  private createUniqueId(prefix: 'node' | 'edge'): string {
    const ids = new Set([
      ...this.nodes.map(node => node.id),
      ...this.edges.map(edge => edge.id),
    ]);

    let id = '';
    do {
      id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    } while (ids.has(id));

    return id;
  }

  private clampScale(scale: number): number {
    return Math.min(2.8, Math.max(0.18, scale));
  }
}

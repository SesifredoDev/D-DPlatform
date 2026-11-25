import { ApplicationRef, ComponentRef, EnvironmentInjector, Type, createComponent } from '@angular/core';
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/prose/view';
import { editorViewTimerCtx, nodeViewCtx, SchemaReady } from '@milkdown/core';
import { createTimer, type Ctx } from '@milkdown/ctx';
import { Subscription } from 'rxjs';
import { blockKindOf, blockLanguage, isStatblockLanguage } from '../../services/ObsidianVault/statblock';
import { getFileExtension, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
import { EmbedSize, formatEmbedSize, parseEmbedSize } from './embed-size';
import { NoteEmbedComponent } from '../statblock-card/note-embed.component';
import { StatblockCardComponent } from '../statblock-card/statblock-card.component';

/** What the editor's statblock and embed views need from the editor component that hosts them. */
export interface StatblockViewHost {
  appRef: ApplicationRef;
  injector: EnvironmentInjector;
  serverId(): string;
  filePath(): string;
  readonly(): boolean;
  openLink(link: string): void;
  filesAdded(): void;
  /** A link inside an embed (e.g. a map pin) is hovered: show the usual link preview. */
  linkHover(event: { target: string; rect: DOMRect } | null): void;
}

type GetPos = () => number | undefined;

/** Internal URL prefix the wikilink plugin gives `![[embeds]]`. */
const EMBED_PREFIX = 'wikilink-blob:';

/**
 * Node views for statblocks and items:
 * - ```statblock / ```item code blocks render as an editable card;
 * - `![[Note]]` embeds of notes render as a statblock card (or a link card) instead of a broken image.
 * Everything else keeps the editor's own view.
 */
export function statblockNodeViewsPlugin(host: StatblockViewHost) {
  const timer = createTimer('StatblockNodeViewsReady');
  const wrapped: Record<string, (fallback?: NodeViewConstructor) => NodeViewConstructor> = {
    code_block: fallback => (node, view, getPos, decorations, innerDecorations) =>
      isStatblockLanguage(String(node.attrs['language'] || ''))
        ? new StatblockBlockView(node, view, getPos as GetPos, host)
        : fallback
          ? fallback(node, view, getPos, decorations, innerDecorations)
          : new PlainCodeBlockView(node),
    image: fallback => embedView(host, fallback),
    'image-block': fallback => embedView(host, fallback),
  };

  return (ctx: Ctx) => {
    ctx.record(timer);
    ctx.update(editorViewTimerCtx, timers => timers.concat(timer));
    const fallbacks = new Map<string, NodeViewConstructor | undefined>();

    return async () => {
      await ctx.wait(SchemaReady);
      // Let the editor's own views (code blocks, image blocks) register first so they can be wrapped.
      await new Promise(resolve => setTimeout(resolve, 0));

      ctx.update(nodeViewCtx, views => {
        const next = views.filter(([id]) => !(id in wrapped));
        for (const [id, wrap] of Object.entries(wrapped)) {
          const fallback = [...views].reverse().find(([nodeId]) => nodeId === id)?.[1];
          fallbacks.set(id, fallback);
          next.push([id, wrap(fallback)]);
        }
        return next;
      });
      ctx.done(timer);

      return () => {
        ctx.update(nodeViewCtx, views => {
          const next = views.filter(([id]) => !(id in wrapped));
          for (const [id, fallback] of fallbacks) if (fallback) next.push([id, fallback]);
          return next;
        });
        ctx.update(editorViewTimerCtx, timers => timers.filter(existing => existing !== timer));
        ctx.clearTimer(timer);
      };
    };
  };
}

/** The embed target when an image node is really `![[Note]]`; null for images and other files. */
export function noteEmbedTarget(node: ProseMirrorNode): string | null {
  const src = String(node.attrs['src'] || '');
  if (!src.startsWith(EMBED_PREFIX)) return null;
  const target = src.slice(EMBED_PREFIX.length).trim();
  const path = target.split('#')[0].split('|')[0].trim();
  if (!path || /^[a-z]+:/i.test(path)) return null;
  // Images, PDFs and other known types keep the image view; notes (and names with dots, like
  // "Mr. Smith") and maps get the embed card.
  const extension = getFileExtension(path);
  return !extension || extension === 'md' || extension === 'map' || getVaultFileType(path).id === 'file' ? target : null;
}

function embedView(host: StatblockViewHost, fallback?: NodeViewConstructor): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => {
    const target = noteEmbedTarget(node);
    if (target !== null) return new NoteEmbedView(node, view, getPos as GetPos, target, host);
    if (node.type.name === 'image' && vaultImagePath(node)) return new ResizableImageView(node, view, getPos as GetPos, host);
    if (fallback) return fallback(node, view, getPos, decorations, innerDecorations);
    // No editor view registered for this node: render it the way its schema does.
    const spec = node.type.spec.toDOM?.(node);
    const dom = spec instanceof HTMLElement ? spec : document.createElement('img');
    if (!(spec instanceof HTMLElement)) (dom as HTMLImageElement).src = String(node.attrs['src'] || '');
    return { dom };
  };
}

/** Mounts an Angular component as a node view's DOM. */
abstract class AngularNodeView<T> implements NodeView {
  dom: HTMLElement;
  protected ref: ComponentRef<T>;
  protected readonly subscriptions = new Subscription();

  constructor(protected host: StatblockViewHost, component: Type<T>, tag: string) {
    this.dom = document.createElement(tag);
    this.dom.contentEditable = 'false';
    this.dom.classList.add('statblock-node');
    this.ref = createComponent(component, { environmentInjector: host.injector, hostElement: this.dom });
    host.appRef.attachView(this.ref.hostView);
    // The editor marks embeds (image nodes) draggable, so a drag inside one (panning an embedded map,
    // selecting text in a card) would pick up the whole embed instead. Moving a block is done with
    // the editor's block handle, which doesn't use this.
    this.dom.addEventListener('dragstart', this.cancelNativeDrag);
  }

  private readonly cancelNativeDrag = (event: DragEvent) => event.preventDefault();

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** The card handles its own clicks, typing and menus. */
  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('dragstart', this.cancelNativeDrag);
    this.subscriptions.unsubscribe();
    this.host.appRef.detachView(this.ref.hostView);
    this.ref.destroy();
  }
}

/** A ```statblock or ```item block: an editable card; edits replace the block's text. */
class StatblockBlockView extends AngularNodeView<StatblockCardComponent> {
  constructor(private node: ProseMirrorNode, private view: EditorView, private getPos: GetPos, host: StatblockViewHost) {
    super(host, StatblockCardComponent, 'div');
    this.ref.setInput('mode', 'block');
    this.ref.setInput('kind', blockKindOf(String(node.attrs['language'] || '')) ?? 'creature');
    this.ref.setInput('serverId', host.serverId());
    this.ref.setInput('notePath', host.filePath());
    this.ref.setInput('readonly', host.readonly() || !view.editable);
    this.ref.setInput('source', node.textContent);
    this.ref.changeDetectorRef.detectChanges();

    const card = this.ref.instance;
    this.subscriptions.add(card.sourceChange.subscribe(source => this.write(source)));
    this.subscriptions.add(card.openNote.subscribe(link => host.openLink(link)));
    this.subscriptions.add(card.filesAdded.subscribe(() => host.filesAdded()));
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || !isStatblockLanguage(String(node.attrs['language'] || ''))) return false;
    this.node = node;
    this.ref.setInput('kind', blockKindOf(String(node.attrs['language'] || '')) ?? 'creature');
    this.ref.setInput('source', node.textContent);
    return true;
  }

  /** Puts the card's new text into the block, renaming old block languages (`dnd-statsheet` → `statblock`). */
  private write(source: string): void {
    const pos = this.getPos();
    if (typeof pos !== 'number' || source === this.node.textContent) return;

    const { state } = this.view;
    const start = pos + 1;
    const end = pos + this.node.nodeSize - 1;
    let tr = source ? state.tr.replaceWith(start, end, state.schema.text(source)) : state.tr.delete(start, end);
    const language = blockLanguage(blockKindOf(String(this.node.attrs['language'] || '')) ?? 'creature');
    if (this.node.attrs['language'] !== language) {
      tr = tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language });
    }
    this.view.dispatch(tr);
  }
}

/** `![[Note]]`: a statblock / item card for such notes, a map for maps, a link card for other notes. */
class NoteEmbedView extends AngularNodeView<NoteEmbedComponent> {
  constructor(
    private node: ProseMirrorNode,
    private view: EditorView,
    private getPos: GetPos,
    private target: string,
    host: StatblockViewHost
  ) {
    super(host, NoteEmbedComponent, 'div');
    this.ref.setInput('serverId', host.serverId());
    this.ref.setInput('fromPath', host.filePath());
    this.ref.setInput('link', target);
    this.ref.setInput('size', embedSizeOf(node));
    this.ref.setInput('resizable', !host.readonly() && view.editable);
    this.subscriptions.add(this.ref.instance.openNote.subscribe(link => host.openLink(link)));
    this.subscriptions.add(this.ref.instance.linkHover.subscribe(event => host.linkHover(event)));
    this.subscriptions.add(this.ref.instance.resized.subscribe(size => setEmbedSize(this.view, this.getPos, size)));
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const target = noteEmbedTarget(node);
    if (target === null) return false;
    const sizeChanged = node.attrs['alt'] !== this.node.attrs['alt'];
    this.node = node;
    if (target !== this.target) {
      this.target = target;
      this.ref.setInput('link', target);
    }
    if (sizeChanged) this.ref.setInput('size', embedSizeOf(node));
    return true;
  }
}

/** The size kept in an embed's `|…` part (the image node's alt), if it is one. */
function embedSizeOf(node: ProseMirrorNode): EmbedSize | null {
  return parseEmbedSize(String(node.attrs['alt'] ?? ''));
}

/** Writes a size into the embed's `|…` part (saved as `![[x|300]]`); null removes it. */
function setEmbedSize(view: EditorView, getPos: GetPos, size: EmbedSize | null): void {
  const pos = getPos();
  if (typeof pos !== 'number' || !view.editable) return;
  view.dispatch(view.state.tr.setNodeAttribute(pos, 'alt', formatEmbedSize(size)));
}

/** The vault path of an `![[image]]` embed (or a local Markdown image); null for web images. */
function vaultImagePath(node: ProseMirrorNode): string | null {
  const src = String(node.attrs['src'] || '');
  if (!src.startsWith(EMBED_PREFIX)) return null;
  const path = src.slice(EMBED_PREFIX.length).split('#')[0].trim();
  return path && getVaultFileType(path).viewer === 'image' ? path : null;
}

/**
 * An `![[image]]` embed with a resize handle: drag the corner (aspect ratio kept), use the arrow
 * keys on it, or double-click it to go back to the natural size. The width is saved Obsidian's
 * way, as `![[map.png|300]]`. The milkdown editor fills in the image itself (see processEmbeds).
 */
class ResizableImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private handle: HTMLElement;
  private readout: HTMLElement;
  private drag: { id: number; startX: number; width: number; max: number } | null = null;
  private liveWidth: number | null = null;

  constructor(private node: ProseMirrorNode, private view: EditorView, private getPos: GetPos, private host: StatblockViewHost) {
    this.dom = document.createElement('span');
    this.dom.className = 'resizable-image';
    this.dom.contentEditable = 'false';

    this.img = document.createElement('img');
    this.img.className = 'wikilink-image';
    this.img.alt = '';
    this.img.draggable = false;
    this.img.setAttribute('data-path', vaultImagePath(node) ?? '');
    this.img.setAttribute('src', String(node.attrs['src']));

    this.handle = document.createElement('span');
    this.handle.className = 'resizable-image-handle';
    this.handle.tabIndex = 0;
    this.handle.setAttribute('role', 'separator');
    this.handle.title = 'Drag to resize. Double-click for the original size.';

    this.readout = document.createElement('span');
    this.readout.className = 'resizable-image-readout';

    this.dom.append(this.img);
    if (!host.readonly() && view.editable) this.dom.append(this.handle, this.readout);

    this.handle.addEventListener('pointerdown', this.onPointerDown);
    this.handle.addEventListener('pointermove', this.onPointerMove);
    this.handle.addEventListener('pointerup', this.onPointerUp);
    this.handle.addEventListener('pointercancel', this.onPointerUp);
    this.handle.addEventListener('dblclick', this.onReset);
    this.handle.addEventListener('keydown', this.onKeydown);
    this.dom.addEventListener('dragstart', this.cancelDrag);
    this.applyWidth();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || !vaultImagePath(node) || noteEmbedTarget(node) !== null) return false;
    const srcChanged = node.attrs['src'] !== this.node.attrs['src'];
    this.node = node;
    if (srcChanged) {
      // A different image: let the editor resolve it again.
      this.img.removeAttribute('data-resolved');
      this.img.setAttribute('data-path', vaultImagePath(node) ?? '');
      this.img.setAttribute('src', String(node.attrs['src']));
    }
    this.liveWidth = null;
    this.applyWidth();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  /** The handle is ours; everything else (selecting, deleting the image) is the editor's. */
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.handle.contains(event.target);
  }

  /** The editor swaps the image's src once it has loaded it from the vault. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.handle.removeEventListener('pointerdown', this.onPointerDown);
    this.handle.removeEventListener('pointermove', this.onPointerMove);
    this.handle.removeEventListener('pointerup', this.onPointerUp);
    this.handle.removeEventListener('pointercancel', this.onPointerUp);
    this.handle.removeEventListener('dblclick', this.onReset);
    this.handle.removeEventListener('keydown', this.onKeydown);
    this.dom.removeEventListener('dragstart', this.cancelDrag);
  }

  private get savedSize(): EmbedSize | null {
    return embedSizeOf(this.node);
  }

  private applyWidth(): void {
    const width = this.liveWidth ?? this.savedSize?.width ?? null;
    const height = this.liveWidth === null ? this.savedSize?.height ?? null : null;
    this.dom.style.width = width ? `${width}px` : '';
    this.img.style.width = width ? '100%' : '';
    this.img.style.height = height && width ? `${height}px` : '';
    this.img.style.objectFit = height && width ? 'cover' : '';
    this.dom.classList.toggle('is-sized', !!width);
    this.readout.textContent = width ? `${Math.round(width)}px` : 'Original size';
    this.handle.setAttribute('aria-label', `Image width ${width ? `${Math.round(width)}px` : 'original'}. Drag or use the arrow keys to resize; double-click for the original size.`);
  }

  private maxWidth(): number {
    return this.dom.parentElement?.clientWidth || this.view.dom.clientWidth || 1200;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    this.handle.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, startX: event.clientX, width: this.img.getBoundingClientRect().width, max: this.maxWidth() };
    this.dom.classList.add('is-resizing');
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.liveWidth = Math.round(Math.min(drag.max, Math.max(40, drag.width + event.clientX - drag.startX)));
    this.applyWidth();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    this.dom.classList.remove('is-resizing');
    if (this.liveWidth !== null) this.save({ width: this.liveWidth, height: null });
  };

  private onReset = (event: MouseEvent): void => {
    event.preventDefault();
    this.liveWidth = null;
    this.save(null);
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 100 : 20;
    const current = this.savedSize?.width ?? Math.round(this.img.getBoundingClientRect().width);
    const width = Math.min(this.maxWidth(), Math.max(40, current + (event.key === 'ArrowRight' ? step : -step)));
    this.save({ width, height: null });
  };

  private cancelDrag = (event: DragEvent): void => {
    if (this.drag) event.preventDefault();
  };

  private save(size: EmbedSize | null): void {
    setEmbedSize(this.view, this.getPos, size);
  }
}

class PlainCodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: ProseMirrorNode) {
    this.dom = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    this.dom.dataset['language'] = String(node.attrs['language'] || '');
    this.dom.append(this.contentDOM);
  }
}

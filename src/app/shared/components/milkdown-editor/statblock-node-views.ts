import { ApplicationRef, ComponentRef, EnvironmentInjector, Type, createComponent } from '@angular/core';
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/prose/view';
import { editorViewTimerCtx, nodeViewCtx, SchemaReady } from '@milkdown/core';
import { createTimer, type Ctx } from '@milkdown/ctx';
import { Subscription } from 'rxjs';
import { blockKindOf, blockLanguage, isStatblockLanguage } from '../../services/ObsidianVault/statblock';
import { getFileExtension, getVaultFileType } from '../../services/ObsidianVault/vault-file-types';
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
  // "Mr. Smith") get the embed card.
  const extension = getFileExtension(path);
  return !extension || extension === 'md' || getVaultFileType(path).id === 'file' ? target : null;
}

function embedView(host: StatblockViewHost, fallback?: NodeViewConstructor): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => {
    const target = noteEmbedTarget(node);
    if (target !== null) return new NoteEmbedView(node, target, host);
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
  }

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

/** `![[Note]]`: a statblock / item card for such notes, a link card for other notes. */
class NoteEmbedView extends AngularNodeView<NoteEmbedComponent> {
  constructor(private node: ProseMirrorNode, private target: string, host: StatblockViewHost) {
    super(host, NoteEmbedComponent, 'div');
    this.ref.setInput('serverId', host.serverId());
    this.ref.setInput('fromPath', host.filePath());
    this.ref.setInput('link', target);
    this.subscriptions.add(this.ref.instance.openNote.subscribe(link => host.openLink(link)));
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    const target = noteEmbedTarget(node);
    if (target === null) return false;
    this.node = node;
    if (target !== this.target) {
      this.target = target;
      this.ref.setInput('link', target);
    }
    return true;
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

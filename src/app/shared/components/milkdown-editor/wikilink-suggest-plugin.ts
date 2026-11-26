import { prosePluginsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { fuzzyMatch, segmentsFromIndices } from '../../services/ObsidianVault/vault-search-utils';

/** Something `[[` can link to. */
export interface WikilinkCandidate {
  /** Shown in the list, e.g. "Strahd". */
  title: string;
  /** Folder shown on the right, e.g. "NPCs/Villains". */
  folder: string;
  /** Material icon name. */
  icon: string;
  /** What goes between the brackets, e.g. "Strahd" or "NPCs/Villains/Strahd" when the name is ambiguous. */
  linkText: string;
  /** The file's type id (see vault-file-types.ts), e.g. "markdown" or "map". */
  kind?: string;
}

/** Limits the list to one kind of file, for a `[[` opened from a menu ("Map" in the + menu). */
interface SuggestFilter {
  /** Where that `[[` starts; the filter ends once that `[[` is gone. */
  from: number;
  kind: string;
  /** Shown when nothing of that kind exists. */
  emptyText: string;
}

interface SuggestMatch {
  /** Document position where `[[` (or `![[`) starts. */
  from: number;
  query: string;
  embed: boolean;
}

interface SuggestState {
  match: SuggestMatch | null;
  /** Start position of a match the user dismissed with Esc; stays closed until a new `[[`. */
  dismissedFrom: number | null;
  filter: SuggestFilter | null;
}

type SuggestMeta = { dismiss: number } | { filter: SuggestFilter };

const MAX_ITEMS = 8;
/** Text before the cursor that opens the list: `[[query` or `![[query`, no brackets/newlines inside. */
const TRIGGER = /(!?)\[\[([^[\]|#\n]*)$/;
const key = new PluginKey<SuggestState>('wikilink-suggest');

/**
 * Obsidian-style `[[` autocomplete. Typing `[[` opens a list of vault notes at the cursor; Enter/Tab
 * (or a click) inserts a link that's clickable right away and saves as `[[Note]]`. `![[` inserts an embed.
 * `getCandidates` is called whenever the list opens, so it always reflects the current vault.
 */
export function wikilinkSuggestPlugin(getCandidates: () => WikilinkCandidate[]) {
  return (ctx: Ctx) => () => {
    ctx.update(prosePluginsCtx, plugins => [...plugins, createPlugin(getCandidates)]);
  };
}

function createPlugin(getCandidates: () => WikilinkCandidate[]): Plugin<SuggestState> {
  let items: WikilinkCandidate[] = [];
  let activeIndex = 0;
  let renderedQuery: string | null = null;
  let popup: HTMLElement | null = null;

  const close = () => {
    popup?.remove();
    popup = null;
    renderedQuery = null;
  };

  const select = (view: EditorView, match: SuggestMatch, candidate: WikilinkCandidate | null) => {
    const { state } = view;
    const cursor = state.selection.from;
    const $cursor = state.selection.$from;
    // Swallow closing brackets the user already typed: `[[Str|]]` → link, not link + "]]".
    const after = $cursor.parent.textBetween($cursor.parentOffset, Math.min($cursor.parent.content.size, $cursor.parentOffset + 2));
    const to = after === ']]' ? cursor + 2 : cursor;
    const linkText = candidate?.linkText ?? match.query.trim();
    if (!linkText) return;

    let tr = state.tr;
    const linkMark = state.schema.marks['link'];
    const image = state.schema.nodes['image'];
    if (match.embed && image) {
      // The same node `![[…]]` becomes when a note loads, so the embed (a map, a statblock card, an
      // image) shows straight away instead of after reopening the note.
      tr = tr.replaceWith(match.from, to, image.create({ src: `wikilink-blob:${linkText}`, alt: '' }));
    } else if (match.embed || !linkMark) {
      tr = tr.insertText(`${match.embed ? '!' : ''}[[${linkText}]]`, match.from, to);
    } else {
      tr = tr.replaceWith(match.from, to, state.schema.text(linkText, [linkMark.create({ href: `wikilink:${linkText}` })]));
      tr = tr.removeStoredMark(linkMark);
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const render = (view: EditorView, match: SuggestMatch, filter: SuggestFilter | null) => {
    const queryKey = `${filter?.kind ?? ''}:${match.query}`;
    if (renderedQuery !== queryKey) {
      renderedQuery = queryKey;
      activeIndex = 0;
      const candidates = getCandidates();
      items = rank(filter ? candidates.filter(candidate => filter.kind.split(',').includes(candidate.kind ?? '')) : candidates, match.query);
    }

    if (!popup) {
      popup = document.createElement('div');
      popup.className = 'wikilink-suggest';
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-label', 'Link to a note');
      document.body.appendChild(popup);
    }

    popup.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'wikilink-suggest-empty';
      empty.textContent = filter && !match.query.trim()
        ? filter.emptyText
        : match.query.trim()
          ? `No ${filter ? 'maps' : 'notes'} match. Enter links to “${match.query.trim()}”.`
          : 'No notes in this vault yet.';
      popup.appendChild(empty);
    }

    items.forEach((item, index) => {
      const option = document.createElement('div');
      option.className = 'wikilink-suggest-item' + (index === activeIndex ? ' is-active' : '');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === activeIndex));

      const icon = document.createElement('span');
      icon.className = 'material-icons wikilink-suggest-icon';
      icon.textContent = item.icon;

      const title = document.createElement('span');
      title.className = 'wikilink-suggest-title';
      const matchIndices = fuzzyMatch(match.query, item.title)?.indices ?? [];
      for (const segment of segmentsFromIndices(item.title, matchIndices)) {
        const part = document.createElement('span');
        if (segment.match) part.className = 'is-match';
        part.textContent = segment.text;
        title.appendChild(part);
      }

      const folder = document.createElement('span');
      folder.className = 'wikilink-suggest-folder';
      folder.textContent = item.folder;

      option.append(icon, title, folder);
      // mousedown (not click) so the editor keeps focus and the selection doesn't move.
      option.addEventListener('mousedown', event => {
        event.preventDefault();
        select(view, match, item);
      });
      option.addEventListener('mousemove', () => {
        if (activeIndex !== index) {
          activeIndex = index;
          render(view, match, key.getState(view.state)?.filter ?? null);
        }
      });
      popup!.appendChild(option);
    });

    position(view, popup, match);
    popup.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  return new Plugin<SuggestState>({
    key,
    state: {
      init: () => ({ match: null, dismissedFrom: null, filter: null }),
      apply(tr, previous, _old, newState) {
        const meta = tr.getMeta(key) as SuggestMeta | undefined;
        const dismiss = meta && 'dismiss' in meta ? meta : undefined;
        const match = findMatch(newState);
        const dismissedFrom = dismiss ? dismiss.dismiss : match && match.from === previous.dismissedFrom ? previous.dismissedFrom : null;
        const mapped = previous.filter ? { ...previous.filter, from: tr.mapping.map(previous.filter.from) } : null;
        const candidate = meta && 'filter' in meta ? meta.filter : mapped;
        // The filter lasts as long as the `[[` it was opened with.
        const filter = candidate && match && match.from === candidate.from ? candidate : null;
        return { match: match && match.from === dismissedFrom ? null : match, dismissedFrom, filter };
      },
    },
    props: {
      handleKeyDown(view, event) {
        const match = key.getState(view.state)?.match;
        if (!match || !popup) return false;

        switch (event.key) {
          case 'ArrowDown':
          case 'ArrowUp':
            if (!items.length) return false;
            activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            render(view, match, key.getState(view.state)?.filter ?? null);
            return true;
          case 'Enter':
          case 'Tab':
            if (!items.length && !match.query.trim()) return false;
            select(view, match, items[activeIndex] ?? null);
            return true;
          case 'Escape':
            view.dispatch(view.state.tr.setMeta(key, { dismiss: match.from }));
            return true;
          default:
            return false;
        }
      },
    },
    view: () => ({
      update(view) {
        const state = key.getState(view.state);
        const match = state?.match;
        if (match && view.editable && view.hasFocus()) {
          render(view, match, state?.filter ?? null);
        } else {
          close();
        }
      },
      destroy: close,
    }),
  });
}

/**
 * Starts an embed picker limited to one kind of file (e.g. maps): puts `![[` on the current line
 * (replacing it if it's empty or a `/` command) and opens the list for that kind.
 */
export function openEmbedPicker(view: EditorView, kind: string, emptyText: string): void {
  const { state } = view;
  const $from = state.selection.$from;
  const line = $from.parent;
  const depth = $from.depth;
  const lineText = line.isTextblock ? line.textContent : '';
  let tr = state.tr;
  let from: number;

  if (line.isTextblock && !line.type.spec.code && (lineText.trim() === '' || lineText.startsWith('/'))) {
    // Reuse the empty line (or the "/map" the user typed).
    const start = $from.start(depth);
    tr = tr.insertText('![[', start, $from.end(depth));
    from = start;
  } else {
    // Start a new paragraph after the current block.
    const paragraph = state.schema.nodes['paragraph'];
    const at = depth >= 1 ? $from.after(depth) : state.selection.to;
    tr = tr.insert(at, paragraph.create(null, state.schema.text('![[')));
    from = at + 1;
  }
  tr = tr.setSelection(TextSelection.create(tr.doc, from + 3));
  tr = tr.setMeta(key, { filter: { from, kind, emptyText } } satisfies SuggestMeta).scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

function findMatch(state: EditorState): SuggestMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const $from = selection.$from;
  if ($from.parent.type.spec.code) return null;

  const textBefore = $from.parent.textBetween(Math.max(0, $from.parentOffset - 200), $from.parentOffset, undefined, '￼');
  const match = textBefore.match(TRIGGER);
  if (!match) return null;

  return {
    from: $from.pos - match[0].length,
    query: match[2],
    embed: match[1] === '!',
  };
}

function rank(candidates: WikilinkCandidate[], query: string): WikilinkCandidate[] {
  const q = query.trim();
  if (!q) return candidates.slice(0, MAX_ITEMS);

  const matchPath = q.includes('/');
  return candidates
    .map(candidate => {
      const name = fuzzyMatch(q, candidate.title);
      const path = matchPath ? fuzzyMatch(q, `${candidate.folder}/${candidate.title}`) : null;
      return { candidate, score: Math.max(name?.score ?? -Infinity, (path?.score ?? -Infinity) * 0.8) };
    })
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, MAX_ITEMS)
    .map(entry => entry.candidate);
}

/** Places the list under the cursor, flipping above it near the bottom of the window. */
function position(view: EditorView, popup: HTMLElement, match: SuggestMatch): void {
  const coords = view.coordsAtPos(match.from);
  const height = popup.offsetHeight;
  const width = popup.offsetWidth;
  const below = coords.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, coords.top - height - 6) : below;
  const left = Math.max(8, Math.min(coords.left, window.innerWidth - width - 8));
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

import { prosePluginsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
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
}

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
    if (match.embed || !linkMark) {
      tr = tr.insertText(`${match.embed ? '!' : ''}[[${linkText}]]`, match.from, to);
    } else {
      tr = tr.replaceWith(match.from, to, state.schema.text(linkText, [linkMark.create({ href: `wikilink:${linkText}` })]));
      tr = tr.removeStoredMark(linkMark);
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const render = (view: EditorView, match: SuggestMatch) => {
    if (renderedQuery !== match.query) {
      renderedQuery = match.query;
      activeIndex = 0;
      items = rank(getCandidates(), match.query);
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
      empty.textContent = match.query.trim()
        ? `No notes match. Enter links to “${match.query.trim()}”.`
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
          render(view, match);
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
      init: () => ({ match: null, dismissedFrom: null }),
      apply(tr, previous, _old, newState) {
        const dismiss = tr.getMeta(key) as { dismiss: number } | undefined;
        const match = findMatch(newState);
        const dismissedFrom = dismiss ? dismiss.dismiss : match && match.from === previous.dismissedFrom ? previous.dismissedFrom : null;
        return { match: match && match.from === dismissedFrom ? null : match, dismissedFrom };
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
            render(view, match);
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
        const match = key.getState(view.state)?.match;
        if (match && view.editable && view.hasFocus()) {
          render(view, match);
        } else {
          close();
        }
      },
      destroy: close,
    }),
  });
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

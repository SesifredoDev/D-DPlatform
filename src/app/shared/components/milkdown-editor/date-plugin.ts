import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { findInlineDates } from '../../services/ObsidianVault/inline-dates';

/** How a `[date:: …]` reads, worked out by the editor host from the vault's calendars. */
export interface DateDisplay {
  /** The date in its calendar, e.g. "15 Mirtul 1492 DR". */
  label: string;
  /** With the weekday, e.g. "Fifth-day, 15 Mirtul 1492 DR". */
  long: string;
  calendarName: string;
  calendarPath: string;
  /** "12 days ago", "in 3 days", "today". */
  relative: string | null;
  holidays: string[];
}

export interface DateHost {
  /**
   * Resolves a note's date texts in order (relative ones count from the one before): a display, null
   * when it isn't a date, or undefined while the calendars are still loading.
   */
  resolve(texts: string[]): (DateDisplay | null | undefined)[];
  /** Opens the calendar at a date. */
  open(display: DateDisplay): void;
}

interface DateMatch {
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
  text: string;
}

interface DateState {
  matches: DateMatch[];
  displays: (DateDisplay | null | undefined)[];
}

export const DATE_CLASS = 'inline-date';
const key = new PluginKey<DateState>('inline-dates');

/** Tell the date plugin to re-read the calendars (dispatch on the view). */
export const refreshDatesMeta = { key, value: 'refresh' };

/**
 * `[date:: 15 Mirtul 1492 DR]` in notes: shown as a date chip (the `[date:: ` and `]` hidden until
 * the cursor is inside it, so it can be edited like text). Relative dates ("3 days later") also
 * show the date they work out to. Hovering a chip shows its weekday, how far it is from today,
 * holidays, and "Open in calendar". The Markdown is never changed.
 */
export function datePlugin(host: DateHost) {
  let card: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;

  const hideCard = () => {
    if (showTimer) clearTimeout(showTimer);
    if (hideTimer) clearTimeout(hideTimer);
    card?.remove();
    card = null;
  };

  const scheduleHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 250);
  };

  const showCard = (element: HTMLElement, display: DateDisplay | null | undefined, text: string) => {
    hideCard();
    card = document.createElement('div');
    card.className = 'inline-date-card';
    card.setAttribute('role', 'tooltip');
    card.addEventListener('mouseenter', () => hideTimer && clearTimeout(hideTimer));
    card.addEventListener('mouseleave', scheduleHide);

    const title = document.createElement('strong');
    const meta = document.createElement('span');
    meta.className = 'inline-date-card-meta';
    card.append(title, meta);

    if (display === undefined) {
      title.textContent = text;
      meta.textContent = 'Loading calendars…';
    } else if (!display) {
      title.textContent = text;
      meta.textContent = 'Not a date in any of this vault’s calendars. Check the spelling, or name the calendar first (e.g. “Harptos 15 Mirtul 1492”).';
    } else {
      title.textContent = display.long;
      meta.textContent = [display.relative ? capitalise(display.relative) : '', display.calendarName].filter(Boolean).join(' · ');
      if (display.holidays.length) {
        const holidays = document.createElement('span');
        holidays.className = 'inline-date-card-holidays';
        holidays.textContent = display.holidays.join(', ');
        card.append(holidays);
      }
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open in calendar';
      open.addEventListener('mousedown', event => event.preventDefault());
      open.addEventListener('click', () => {
        hideCard();
        host.open(display);
      });
      card.append(open);
    }

    document.body.append(card);
    const rect = element.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const below = rect.bottom + 6 + height < window.innerHeight;
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    card.style.top = `${below ? rect.bottom + 6 : rect.top - height - 6}px`;
  };

  return $prose(() => new Plugin<DateState>({
    key,
    state: {
      init: (_, state) => compute(state.doc, host),
      apply: (tr, previous, _old, next) =>
        tr.docChanged || tr.getMeta(key) === 'refresh' ? compute(next.doc, host) : previous,
    },
    props: {
      decorations: state => decorate(state),
      handleDOMEvents: {
        mouseover: (view: EditorView, event: MouseEvent) => {
          const chip = (event.target as HTMLElement).closest<HTMLElement>(`.${DATE_CLASS}`);
          if (!chip) return false;
          if (hideTimer) clearTimeout(hideTimer);
          if (showTimer) clearTimeout(showTimer);
          const index = Number(chip.dataset['dateIndex']);
          const state = key.getState(view.state);
          const display = state?.displays[index];
          const text = state?.matches[index]?.text ?? '';
          showTimer = setTimeout(() => showCard(chip, display, text), 350);
          return false;
        },
        mouseout: (_view: EditorView, event: MouseEvent) => {
          const chip = (event.target as HTMLElement).closest(`.${DATE_CLASS}`);
          if (!chip || (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget))) return false;
          if (showTimer) clearTimeout(showTimer);
          scheduleHide();
          return false;
        },
      },
    },
    view: () => ({ destroy: hideCard }),
  }));
}

function compute(doc: ProseMirrorNode, host: DateHost): DateState {
  const matches: DateMatch[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code || node.type.name === 'code_block') return false;
    if (!node.isText || !node.text || !node.text.includes('[date::')) return true;
    if (node.marks.some(mark => mark.type.spec.code || /code/i.test(mark.type.name))) return false;
    for (const match of findInlineDates(node.text)) {
      matches.push({
        from: pos + match.index,
        to: pos + match.index + match.raw.length,
        textFrom: pos + match.textIndex,
        textTo: pos + match.textIndex + match.text.length,
        text: match.text,
      });
    }
    return false;
  });
  return { matches, displays: matches.length ? host.resolve(matches.map(match => match.text)) : [] };
}

function decorate(state: EditorState): DecorationSet {
  const data = key.getState(state);
  if (!data?.matches.length) return DecorationSet.empty;
  const { from: selFrom, to: selTo } = state.selection;
  const decorations: Decoration[] = [];

  data.matches.forEach((match, index) => {
    const display = data.displays[index];
    // The cursor is in it: show the raw `[date:: …]` so it can be edited.
    const editing = selTo >= match.from && selFrom <= match.to;
    const attrs = {
      class: `${DATE_CLASS}${display === null ? ' is-invalid' : ''}${editing ? ' is-editing' : ''}`,
      'data-date-index': String(index),
    };
    if (editing) {
      decorations.push(Decoration.inline(match.from, match.to, attrs));
      return;
    }
    decorations.push(Decoration.inline(match.from, match.textFrom, { class: 'inline-date-syntax' }));
    decorations.push(Decoration.inline(match.textFrom, match.textTo, attrs));
    decorations.push(Decoration.inline(match.textTo, match.to, { class: 'inline-date-syntax' }));
    if (display && normalise(display.label) !== normalise(match.text)) {
      // A relative or loosely written date: show what it works out to.
      decorations.push(Decoration.widget(match.to, () => {
        const span = document.createElement('span');
        span.className = 'inline-date-resolved';
        span.textContent = display.label;
        return span;
      }, { side: 1, key: `date-${index}-${display.label}` }));
    }
  });
  return DecorationSet.create(state.doc, decorations);
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

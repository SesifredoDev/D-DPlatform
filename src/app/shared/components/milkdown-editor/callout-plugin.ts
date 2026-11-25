import { prosePluginsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { findWrapping } from '@milkdown/prose/transform';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { CALLOUT_ACTION_CLASS, CALLOUT_CLASS, CALLOUT_MARKER, CALLOUT_MARKER_CLASS, resolveCalloutType } from '../../services/ObsidianVault/callouts';
import { SECRET_BLOCK_CLASS, SECRET_COMMENT_CLASS } from '../../services/ObsidianVault/secrets';

const key = new PluginKey<DecorationSet>('callouts');

/**
 * Styles Obsidian callouts and `%%comments%%` while editing, without changing the document.
 * - `> [!type] Title` blockquotes get `md-callout md-callout--<type>` and a `data-callout-label`
 *   (e.g. "Warning"); `[!secret]` ones also get the GM-only class that broadcasting removes.
 * - `%%comments%%` (inline or across paragraphs) get the GM-only comment class.
 */
export interface CalloutPluginOptions {
  /** Whether read-aloud callouts get a Broadcast button (only where broadcasting is wired up). */
  canBroadcast?: () => boolean;
  /** Called with the position of the read-aloud blockquote whose button was clicked. */
  onBroadcastBlock?: (blockPos: number) => void;
}

export const calloutPlugin = (options: CalloutPluginOptions = {}) => (ctx: Ctx) => () => {
  ctx.update(prosePluginsCtx, plugins => [
    ...plugins,
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => buildDecorations(state.doc, options),
        apply: (tr, previous) => (tr.docChanged ? buildDecorations(tr.doc, options) : previous),
      },
      props: {
        decorations: state => key.getState(state),
      },
    }),
  ]);
};

function buildDecorations(doc: ProseNode, options: CalloutPluginOptions): DecorationSet {
  const broadcastable = !!options.onBroadcastBlock && (options.canBroadcast?.() ?? true);
  const decorations: Decoration[] = [];
  let commentOpen = false;

  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild;
      const marker = first?.isTextblock ? first.textContent.match(CALLOUT_MARKER) : null;
      if (first && marker) {
        const type = resolveCalloutType(marker[1]);
        const classes = [CALLOUT_CLASS, `${CALLOUT_CLASS}--${type.id}`];
        if (type.id === 'secret') classes.push(SECRET_BLOCK_CLASS);
        decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          class: classes.join(' '),
          'data-callout-label': type.label,
        }));
        const markerStart = pos + 2; // blockquote open + paragraph open
        decorations.push(Decoration.inline(markerStart, markerStart + marker[0].length, { class: CALLOUT_MARKER_CLASS }));

        if (type.id === 'read-aloud' && broadcastable) {
          decorations.push(Decoration.widget(pos + 1, (_view, getPos) => broadcastButton(getPos, options.onBroadcastBlock!), {
            side: -1,
            key: `read-aloud-broadcast-${pos}`,
            ignoreSelection: true,
            stopEvent: () => true,
          }));
        }
      }
      return true;
    }

    if (!node.isTextblock || node.type.spec.code) return !node.isTextblock;

    // `%%` comments. Offsets in `text` map 1:1 to positions because each inline leaf is one character.
    const start = pos + 1;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    let cursor = 0;
    let openOffset: number | null = commentOpen ? 0 : null;

    while (cursor <= text.length) {
      const next = text.indexOf('%%', cursor);
      if (next < 0) break;
      if (openOffset === null) {
        openOffset = next;
      } else {
        decorations.push(Decoration.inline(start + openOffset, start + next + 2, { class: SECRET_COMMENT_CLASS }));
        openOffset = null;
      }
      cursor = next + 2;
    }

    if (openOffset !== null && text.length > openOffset) {
      // Comment continues past this paragraph.
      decorations.push(Decoration.inline(start + openOffset, start + text.length, { class: SECRET_COMMENT_CLASS }));
    }
    commentOpen = openOffset !== null;
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

/** The Broadcast button shown in the corner of read-aloud callouts. */
function broadcastButton(getPos: () => number | undefined, onBroadcast: (blockPos: number) => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${CALLOUT_ACTION_CLASS} md-callout-broadcast`;
  button.contentEditable = 'false';
  button.title = 'Broadcast this read-aloud text to your players';
  button.setAttribute('aria-label', 'Broadcast this read-aloud block');

  const icon = document.createElement('span');
  icon.className = 'material-icons';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'play_arrow';
  const label = document.createElement('span');
  label.textContent = 'Broadcast';
  button.append(icon, label);

  // Keep the editor's selection and focus where they are.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const widgetPos = getPos();
    // The widget sits just inside the blockquote, so the blockquote starts one position earlier.
    if (widgetPos !== undefined) onBroadcast(widgetPos - 1);
  });
  return button;
}

// ---------------------------------------------------------------- inserting callouts

export interface CalloutTemplate {
  /** Type as written in the marker, e.g. `secret` → `[!secret]`. */
  type: string;
  /** Optional title after the marker. */
  title?: string;
  /** Text selected after inserting, so typing replaces it. */
  placeholder: string;
}

export const SECRET_TEMPLATE: CalloutTemplate = {
  type: 'secret',
  title: 'GM only',
  placeholder: 'Only you can see this. It is left out when you broadcast.',
};

/**
 * Inserts a `> [!type]` callout.
 * - With text selected (and not from the block menu), the selected blocks are wrapped in it.
 * - Otherwise a new callout goes below the cursor (or replaces the current line when it's empty, or
 *   when called from the block menu, where the line holds the `/filter` text) and its placeholder is
 *   selected so typing replaces it.
 */
export function insertCallout(
  view: EditorView,
  template: CalloutTemplate,
  options: { replaceCurrentLine?: boolean } = {}
): void {
  const { state } = view;
  const { schema, selection } = state;
  const blockquote = schema.nodes['blockquote'];
  const paragraph = schema.nodes['paragraph'];
  const markerText = `[!${template.type}]${template.title ? ` ${template.title}` : ''}`;
  const marker = () => paragraph.create(null, schema.text(markerText));

  if (!selection.empty && !options.replaceCurrentLine) {
    const range = selection.$from.blockRange(selection.$to);
    const wrapping = range && findWrapping(range, blockquote);
    if (range && wrapping) {
      // After wrapping, the new blockquote starts at range.start; put the marker line first.
      view.dispatch(state.tr.wrap(range, wrapping).insert(range.start + 1, marker()).scrollIntoView());
      view.focus();
      return;
    }
  }

  const block = blockquote.create(null, [marker(), paragraph.create(null, schema.text(template.placeholder))]);
  const $from = selection.$from;
  const line = $from.parent;
  const depth = $from.depth;
  const lineText = line.isTextblock ? line.textContent : '';
  const replaceLine = depth >= 1 && line.isTextblock && (lineText === '' || (options.replaceCurrentLine && lineText.startsWith('/')));

  let tr = state.tr;
  let at: number;
  if (replaceLine) {
    at = $from.before(depth);
    tr = tr.replaceWith(at, $from.after(depth), block);
  } else {
    at = depth >= 1 ? $from.after(depth) : selection.from;
    tr = tr.insert(at, block);
  }

  // Select the placeholder: blockquote open + marker paragraph + paragraph open.
  const textStart = at + 1 + marker().nodeSize + 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, textStart, textStart + template.placeholder.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// ---------------------------------------------------------------- block menu entries

const svg = (path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${path}"/></svg>`;

/** Material icons used in the + / slash menu. */
export const SECRET_MENU_ICON = svg('M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z');

/** "Map" in the block menu's "Vault" group (Material "map" outline). */
export const MAP_MENU_ICON = svg('M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM10 5.47l4 1.4v11.66l-4-1.4V5.47zm-5 .99l3-1.01v11.7l-3 1.16V6.46zm14 11.08l-3 1.01V6.86l3-1.16v11.84z');

/** Callouts offered in the block menu's "Callouts" group (others still render when typed). */
export const CALLOUT_MENU_ITEMS: readonly { key: string; label: string; icon: string; template: CalloutTemplate }[] = [
  {
    key: 'callout-read-aloud',
    label: 'Read aloud',
    icon: svg('M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm6.08-7.95c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27l-1.68 1.69zM20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14z'),
    template: { type: 'read-aloud', placeholder: 'Text to read out to the players…' },
  },
  {
    key: 'callout-note',
    label: 'Note',
    icon: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z'),
    template: { type: 'note', placeholder: 'Note' },
  },
  {
    key: 'callout-tip',
    label: 'Tip',
    icon: svg('M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z'),
    template: { type: 'tip', placeholder: 'Tip' },
  },
  {
    key: 'callout-warning',
    label: 'Warning',
    icon: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
    template: { type: 'warning', placeholder: 'Warning' },
  },
  {
    key: 'callout-danger',
    label: 'Danger',
    icon: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z'),
    template: { type: 'danger', placeholder: 'Danger' },
  },
];

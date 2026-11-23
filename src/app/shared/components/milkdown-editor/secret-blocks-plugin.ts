import { prosePluginsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { findWrapping } from '@milkdown/prose/transform';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { SECRET_BLOCK_CLASS, SECRET_CALLOUT_MARKER, SECRET_COMMENT_CLASS } from '../../services/ObsidianVault/secrets';
const SECRET_MARKER_CLASS = 'md-secret-marker';

const key = new PluginKey<DecorationSet>('secret-blocks');

/**
 * Highlights GM-only content while editing, without changing the document:
 * - blockquotes whose first line starts with `[!secret]` (Obsidian callout syntax)
 * - `%%comments%%`, inline or across several paragraphs
 */
export const secretBlocksPlugin = (ctx: Ctx) => () => {
  ctx.update(prosePluginsCtx, plugins => [
    ...plugins,
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => buildDecorations(state.doc),
        apply: (tr, previous) => (tr.docChanged ? buildDecorations(tr.doc) : previous),
      },
      props: {
        decorations: state => key.getState(state),
      },
    }),
  ]);
};

function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  let commentOpenAt: number | null = null;

  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild;
      const markerMatch = first?.isTextblock ? first.textContent.match(SECRET_CALLOUT_MARKER) : null;
      if (first && markerMatch) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: SECRET_BLOCK_CLASS }));
        const markerStart = pos + 2; // blockquote open + paragraph open
        decorations.push(Decoration.inline(markerStart, markerStart + markerMatch[0].length, { class: SECRET_MARKER_CLASS }));
      }
      return true;
    }

    if (!node.isTextblock || node.type.spec.code) return !node.isTextblock;

    // `%%` comments. Offsets in `text` map 1:1 to positions because each inline leaf is one character.
    const start = pos + 1;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    let cursor = 0;
    let openOffset: number | null = commentOpenAt !== null ? 0 : null;

    while (cursor <= text.length) {
      const next = text.indexOf('%%', cursor);
      if (next < 0) break;
      if (openOffset === null) {
        openOffset = next;
      } else {
        decorations.push(Decoration.inline(start + openOffset, start + next + 2, { class: SECRET_COMMENT_CLASS }));
        openOffset = null;
        commentOpenAt = null;
      }
      cursor = next + 2;
    }

    if (openOffset !== null) {
      // Comment continues past this paragraph.
      if (text.length > openOffset) {
        decorations.push(Decoration.inline(start + openOffset, start + text.length, { class: SECRET_COMMENT_CLASS }));
      }
      commentOpenAt = commentOpenAt ?? start + openOffset;
    }
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

const SECRET_PLACEHOLDER = 'Only you can see this. It is left out when you broadcast.';

/** Icon for the block menu (Material "visibility_off"). */
export const SECRET_MENU_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
  </svg>
`;

/**
 * Inserts a GM-only `> [!secret]` callout.
 * - With text selected, the selected blocks are wrapped in it.
 * - Otherwise a new secret block goes below the cursor (or replaces the current line when it's empty,
 *   or when called from the block menu, where the line holds the `/filter` text) and its placeholder
 *   text is selected so typing replaces it.
 */
export function insertSecretBlock(view: EditorView, options: { replaceCurrentLine?: boolean } = {}): void {
  const { state } = view;
  const { schema, selection } = state;
  const blockquote = schema.nodes['blockquote'];
  const paragraph = schema.nodes['paragraph'];
  const marker = () => paragraph.create(null, schema.text('[!secret] GM only'));

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

  const block = blockquote.create(null, [marker(), paragraph.create(null, schema.text(SECRET_PLACEHOLDER))]);
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
  tr = tr.setSelection(TextSelection.create(tr.doc, textStart, textStart + SECRET_PLACEHOLDER.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

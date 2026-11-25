import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { findDiceExpressions } from '../../services/dice/dice';

/** Class on dice expressions in the editor; clicks on it are handled by MilkdownEditorComponent. */
export const DICE_CLASS = 'dice-roll';

const KEY = new PluginKey<DecorationSet>('dice');

/**
 * Marks dice expressions (`2d10+7`, `d20`, `3d6 + 2d8 + 1`…) in note text so they can be clicked to
 * roll. Only decorations: the Markdown is untouched. Code blocks and inline code are skipped.
 */
export const dicePlugin = $prose(() => new Plugin<DecorationSet>({
  key: KEY,
  state: {
    init: (_, state) => diceDecorations(state.doc),
    apply: (tr, previous) => (tr.docChanged ? diceDecorations(tr.doc) : previous),
  },
  props: {
    decorations: state => KEY.getState(state),
  },
}));

function diceDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code || node.type.name === 'code_block') return false;
    if (!node.isText || !node.text) return true;
    if (node.marks.some(mark => mark.type.spec.code || /code/i.test(mark.type.name))) return false;

    for (const match of findDiceExpressions(node.text)) {
      const from = pos + match.index;
      decorations.push(Decoration.inline(from, from + match.text.length, {
        class: DICE_CLASS,
        'data-dice': match.text,
        title: `Roll ${match.text} (Shift+click to post it to chat)`,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

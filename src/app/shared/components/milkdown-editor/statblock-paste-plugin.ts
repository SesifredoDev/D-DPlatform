import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import { closeHistory, undo } from '@milkdown/prose/history';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { STATBLOCK_LANGUAGE, pastedStatblockSource } from '../../services/ObsidianVault/statblock';

const KEY = new PluginKey('statblock-paste');
/** How long the "Converted to a statblock" chip stays up. */
const CHIP_TIMEOUT = 12000;

/**
 * Pasting a statblock copied as plain text (from a book, PDF or website) turns it into a
 * ```statblock block. A chip offers "Keep as text", which undoes the conversion and pastes the
 * original text instead; it goes away after a few seconds or on the next edit.
 *
 * `handlePaste` must be set as an editor view option (editorViewOptionsCtx), not a plugin prop:
 * the editor's clipboard plugin would otherwise take every paste first. `plugin` hides the chip.
 */
export function createStatblockPaste() {
  let chip: HTMLElement | null = null;
  let chipTimer: ReturnType<typeof setTimeout> | undefined;
  /** The document right after a conversion; any other change hides the chip. */
  let convertedDoc: ProseMirrorNode | null = null;
  let pasting = false;

  const hideChip = () => {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = undefined;
    chip?.remove();
    chip = null;
    convertedDoc = null;
  };

  const keepAsText = (view: EditorView, text: string) => {
    hideChip();
    undo(view.state, view.dispatch);
    pasting = true;
    try {
      view.pasteText(text);
    } finally {
      pasting = false;
    }
    view.focus();
  };

  const showChip = (view: EditorView, text: string) => {
    hideChip();
    convertedDoc = view.state.doc;
    const coords = view.coordsAtPos(view.state.selection.from);

    chip = document.createElement('div');
    chip.className = 'statblock-paste-chip';
    chip.setAttribute('role', 'status');
    chip.innerHTML = '<span class="material-icons" aria-hidden="true">shield</span><span>Pasted as a statblock</span>';

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Keep as text';
    keep.addEventListener('mousedown', event => event.preventDefault());
    keep.addEventListener('click', () => keepAsText(view, text));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'is-icon';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
    close.addEventListener('mousedown', event => event.preventDefault());
    close.addEventListener('click', hideChip);

    chip.append(keep, close);
    document.body.append(chip);
    const width = chip.offsetWidth;
    chip.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - width - 8))}px`;
    chip.style.top = `${Math.min(coords.bottom + 8, window.innerHeight - 48)}px`;
    chipTimer = setTimeout(hideChip, CHIP_TIMEOUT);
  };

  const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
    if (pasting || !view.editable) return false;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const source = pastedStatblockSource(text);
    const codeBlock = view.state.schema.nodes['code_block'];
    if (!source || !codeBlock) return false;

    const node = codeBlock.create({ language: STATBLOCK_LANGUAGE }, view.state.schema.text(source));
    // Its own undo step, so "Keep as text" undoes only the conversion, not typing before it.
    view.dispatch(closeHistory(view.state.tr.replaceSelectionWith(node).scrollIntoView()));
    showChip(view, text);
    return true;
  };

  const plugin = $prose(() => new Plugin({
    key: KEY,
    view: () => ({
      update(view) {
        if (convertedDoc && view.state.doc !== convertedDoc) hideChip();
      },
      destroy: hideChip,
    }),
  }));

  return { handlePaste, plugin };
}

import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import type { Node as ProseMirrorNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { wikilinkPlugin } from './wikilink-plugin';
import { embedSizeOf } from './embed-size';

/** Opens Markdown in a real Crepe editor, runs `edit`, and returns what it saves. */
async function withEditor(
  markdown: string,
  edit: (view: EditorView, embed: { node: ProseMirrorNode; pos: number }) => void = () => {}
): Promise<{ saved: string; embed: ProseMirrorNode }> {
  const root = document.createElement('div');
  document.body.append(root);
  const crepe = new Crepe({ root, defaultValue: markdown });
  crepe.editor.use(wikilinkPlugin);
  await crepe.create();
  let result!: { saved: string; embed: ProseMirrorNode };
  crepe.editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    let found: { node: ProseMirrorNode; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
      if (!found && (node.type.name === 'image' || node.type.name === 'image-block')) found = { node, pos };
    });
    if (!found) throw new Error('no embed');
    edit(view, found);
    const embed = view.state.doc.nodeAt((found as { pos: number }).pos)!;
    result = { saved: ctx.get(serializerCtx)(view.state.doc).trim(), embed };
  });
  await crepe.destroy();
  root.remove();
  return result;
}

describe('embed sizes survive reopening', () => {
  it('reads a width from an embed on its own line (not as a 300× height ratio)', async () => {
    const { embed, saved } = await withEditor('![[map.png|300]]');
    expect(embed.type.name).toBe('image-block');
    expect(embedSizeOf(embed)).toEqual({ width: 300, height: null });
    expect(saved).toBe('![[map.png|300]]');
  });

  it('keeps heights and width × height on their own line', async () => {
    const tall = await withEditor('![[Coast.map|x420]]');
    expect(embedSizeOf(tall.embed)).toEqual({ width: null, height: 420 });
    expect(tall.saved).toBe('![[Coast.map|x420]]');

    const both = await withEditor('![[map.png|640x420]]');
    expect(embedSizeOf(both.embed)).toEqual({ width: 640, height: 420 });
    expect(both.saved).toBe('![[map.png|640x420]]');
  });

  it('saves a resize of an image on its own line', async () => {
    const { saved } = await withEditor('![[map.png|300]]', (view, { pos }) => {
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'caption', '480').setNodeAttribute(pos, 'ratio', 1));
    });
    expect(saved).toBe('![[map.png|480]]');
  });

  it('keeps inline sizes, and removes them when reset', async () => {
    const inline = await withEditor('A ![[map.png|300]] b');
    expect(inline.embed.type.name).toBe('image');
    expect(embedSizeOf(inline.embed)).toEqual({ width: 300, height: null });
    expect(inline.saved).toBe('A ![[map.png|300]] b');

    const reset = await withEditor('A ![[map.png|300]] b', (view, { pos }) => {
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'alt', '').setNodeAttribute(pos, 'title', ''));
    });
    expect(reset.saved).toBe('A ![[map.png]] b');
  });

  it('keeps a caption on an embed on its own line', async () => {
    const { saved } = await withEditor('![[map.png|Harbour at dusk]]');
    expect(saved).toBe('![[map.png|Harbour at dusk]]');
  });
});

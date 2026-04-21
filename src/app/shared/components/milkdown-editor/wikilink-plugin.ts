import { remarkPluginsCtx } from '@milkdown/core';
import { Ctx } from '@milkdown/ctx';
import { visit } from 'unist-util-visit';
import { Node } from 'unist';

// The wikilinkRegex matches both ![[path]] and [[path]].
const wikilinkRegex = /(!?\[\[([^\]]+?)\]\])/g;

// The actual unified/remark plugin function (passed as `plug.plugin`).
// It receives the remark processor options (unused here) and returns
// a tree transformer — this is the standard unified plugin shape.
function remarkWikilinks() {
  return (tree: Node) => {
    // 1. Intercept standard Markdown images (![alt](url)) that point to local files.
    // Wrapping them in our custom protocol prevents the browser's "Not allowed to load local resource" block.
    visit(tree, 'image', (node: any) => {
      const url = node.url || '';
      if (url.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(url)) {
        node.url = `wikilink-blob:${url}`;
        node.data = node.data || {};
        node.data.hProperties = node.data.hProperties || {};
        node.data.hProperties['class'] = 'wikilink-image';
        node.data.hProperties['data-path'] = url;
        node.data.hProperties['src'] = `wikilink-blob:${url}`;
      }
    });

    let textNodeCount = 0;
    let wikilinkCount = 0;

    visit(tree, 'text', (node: any, index: number | null, parent: any) => {
      textNodeCount++;
      if (!node.value || !node.value.includes('[[')) return;

      const value = node.value as string;
      wikilinkRegex.lastIndex = 0;
      if (!wikilinkRegex.test(value)) return;
      wikilinkCount++;

      const children: any[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      wikilinkRegex.lastIndex = 0;
      while ((match = wikilinkRegex.exec(value)) !== null) {
        const fullMatch = match[1];
        const inner    = match[2];
        const path     =  inner.split('|')[0].trim();
        const alias    = inner.includes('|') ? inner.split('|')[1].trim() : path;
        const isEmbed  = fullMatch.startsWith('!');

        if (match.index > lastIndex) {
          children.push({ type: 'text', value: value.slice(lastIndex, match.index) });
        }

        if (isEmbed) {
          children.push({
            type: 'image',
            // We avoid "wikilink://" because "//" followed by an absolute path 
            // (like C:/) triggers "Not allowed to load local resource" in many browsers.
            url: `wikilink-blob:${path}`, 
            alt: alias,
            data: {
              hProperties: {
                class: 'wikilink-image',
                'data-path': path,
                src: `wikilink-blob:${path}`,
              },
            },
          });
        } else {
          children.push({
            type: 'link',
            url: `wikilink:${path}`,
            data: {
              hProperties: {
                class: 'wikilink',
                href: `wikilink:${path}`,
              },
            },
            children: [{ type: 'text', value: alias }],
          });
        }

        lastIndex = wikilinkRegex.lastIndex;
      }

      if (lastIndex < value.length) {
        children.push({ type: 'text', value: value.slice(lastIndex) });
      }

      if (parent && typeof index === 'number') {
        parent.children.splice(index, 1, ...children);
      }
    });
  };
}


export const wikilinkPlugin = (ctx: Ctx) => {
  return () => {
    ctx.update(remarkPluginsCtx, (prev: any[]) => [
      ...prev,
      { plugin: remarkWikilinks, options: undefined },
    ]);
  };
};

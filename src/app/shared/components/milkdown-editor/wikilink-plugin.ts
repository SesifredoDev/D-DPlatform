import { remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/core';
import { Ctx } from '@milkdown/ctx';
import { defaultHandlers, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown';
import { visit } from 'unist-util-visit';
import { Node } from 'unist';

// The wikilinkRegex matches both ![[path]] and [[path]].
const wikilinkRegex = /(!?\[\[([^\]]+?)\]\])/g;

/** URL prefixes the editor uses internally for wikilinks and embeds. They must never reach disk. */
const LINK_PREFIX = 'wikilink:';
const EMBED_PREFIX = 'wikilink-blob:';

/**
 * Remark plugin for Obsidian syntax.
 *
 * Loading: `[[note]]` / `![[embed]]` in text become link / image nodes the editor can render and click.
 * Saving: those nodes are written back as `[[note]]` / `![[embed]]`, so the file on disk keeps
 * Obsidian's syntax. Notes already saved with the old `[x](wikilink:…)` form are converted back
 * the next time they're edited.
 */
export function remarkWikilinks(this: any) {
  // Register write-side handlers (same mechanism remark-gfm uses).
  const data = this.data();
  const extensions: ToMarkdownOptions[] = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);
  extensions.push(wikilinkToMarkdown);

  return (tree: Node) => {
    // 1. Intercept standard Markdown images (![alt](url)) that point to local files.
    // Wrapping them in our custom protocol prevents the browser's "Not allowed to load local resource" block.
    visit(tree, 'image', (node: any) => {
      const url = node.url || '';
      if (isLocalFilePath(url)) {
        node.url = `${EMBED_PREFIX}${url}`;
        node.data = node.data || {};
        node.data.hProperties = node.data.hProperties || {};
        node.data.hProperties['class'] = 'wikilink-image';
        node.data.hProperties['data-path'] = url;
        node.data.hProperties['src'] = `${EMBED_PREFIX}${url}`;
      }
    });

    visit(tree, 'text', (node: any, index: number | null, parent: any) => {
      if (!node.value || !node.value.includes('[[')) return;

      const value = node.value as string;
      wikilinkRegex.lastIndex = 0;
      if (!wikilinkRegex.test(value)) return;

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
            url: `${EMBED_PREFIX}${path}`,
            alt: alias,
            data: {
              hProperties: {
                class: 'wikilink-image',
                'data-path': path,
                src: `${EMBED_PREFIX}${path}`,
              },
            },
          });
        } else {
          children.push({
            type: 'link',
            url: `${LINK_PREFIX}${path}`,
            data: {
              hProperties: {
                class: 'wikilink',
                href: `${LINK_PREFIX}${path}`,
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

/** Write-side handlers: turn the editor's internal link/image nodes back into Obsidian syntax. */
const wikilinkToMarkdown: ToMarkdownOptions = {
  handlers: {
    link(node, parent, state, info) {
      const url = node.url || '';
      if (!url.startsWith(LINK_PREFIX)) {
        return defaultHandlers.link(node, parent, state, info);
      }

      const path = url.slice(LINK_PREFIX.length);
      const alias = plainText(node).trim();
      return alias && alias !== path ? `[[${path}|${alias}]]` : `[[${path}]]`;
    },

    image(node, parent, state, info) {
      const url = node.url || '';
      if (!url.startsWith(EMBED_PREFIX)) {
        return defaultHandlers.image(node, parent, state, info);
      }

      const path = url.slice(EMBED_PREFIX.length);
      // A normal Markdown image pointing at a local file: restore the original URL.
      if (isLocalFilePath(path)) {
        return defaultHandlers.image({ ...node, url: path }, parent, state, info);
      }

      const alias = embedAlias((node.alt || '').trim(), path);
      return alias ? `![[${path}|${alias}]]` : `![[${path}]]`;
    },

    text(node, parent, state, info) {
      return restoreObsidianSyntax(defaultHandlers.text(node, parent, state, info));
    },
  },
};

/**
 * Undoes escaping that Markdown doesn't need but that breaks Obsidian syntax in plain text:
 * - `\#tag` → `#tag` (`#` followed by a non-space is never a heading)
 * - `\[\[Note]]` → `[[Note]]` (a wikilink typed straight into the editor)
 */
export function restoreObsidianSyntax(markdown: string): string {
  return markdown
    .replace(/\\#(?=[^\s#\\])/g, '#')
    .replace(/(\\?!)?\\\[\\\[([^\n]*?)\\?\]\\?\]/g, (_, bang: string | undefined, inner: string) => {
      const target = inner.replace(/\\([\\`*_{}[\]()#+\-.!|~<>&])/g, '$1');
      return `${bang ? '!' : ''}[[${target}]]`;
    });
}

/**
 * The `|…` part to write after an embed path, or '' for none.
 *
 * An embed on its own line becomes Crepe's image block, which saves its resize ratio in the alt
 * field formatted like `1.00` (and drops the original alt). Obsidian has no ratio; a number there
 * means a pixel width. So: `1.00` → no alias, a whole number like `300.00` → `300` (the original
 * width round-tripped), any other ratio → dropped.
 */
export function embedAlias(alt: string, path: string): string {
  if (!alt || alt === path) return '';

  const ratio = alt.match(/^(\d+)\.(\d{2})$/);
  if (ratio) {
    const [, whole, fraction] = ratio;
    return fraction === '00' && whole !== '1' ? whole : '';
  }

  return alt;
}

function plainText(node: any): string {
  if (typeof node?.value === 'string') return node.value;
  return Array.isArray(node?.children) ? node.children.map(plainText).join('') : '';
}

function isLocalFilePath(url: string): boolean {
  return url.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(url);
}

export const wikilinkPlugin = (ctx: Ctx) => {
  return () => {
    ctx.update(remarkPluginsCtx, (prev: any[]) => [
      ...prev,
      { plugin: remarkWikilinks, options: undefined },
    ]);

    // Milkdown passes its own `text` handler as a top-level stringify option, which takes
    // precedence over plugin extensions. Wrap it so the un-escaping still applies.
    ctx.update(remarkStringifyOptionsCtx, (prev: any) => {
      const baseText = prev?.handlers?.text ?? defaultHandlers.text;
      return {
        ...prev,
        handlers: {
          ...prev?.handlers,
          text: (node: any, parent: any, state: any, info: any) =>
            restoreObsidianSyntax(baseText(node, parent, state, info)),
        },
      };
    });
  };
};

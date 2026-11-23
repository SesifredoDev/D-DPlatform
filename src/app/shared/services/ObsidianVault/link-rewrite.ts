/**
 * Rewrites links in a note after files were renamed or moved, keeping everything else byte-for-byte.
 * Handles `[[wikilinks]]` (with `#heading`, `|alias`, `![[embeds]]`), Markdown links `[x](path.md)`,
 * and older `[x](wikilink:…)` links. Code blocks and inline code are left alone.
 */

export interface LinkRewriteContext {
  /** Path of the note being rewritten, as it was before the move (links resolve relative to it). */
  notePath: string;
  /** Path of that note after the move (for relative Markdown links). Defaults to `notePath`. */
  newNotePath?: string;
  /** Resolves a link target to a file path using the vault as it was before the move. */
  resolve: (target: string, fromPath: string) => string | null;
  /** Moved files: lower-cased old path → new path. */
  moved: Map<string, string>;
  /** Text to put inside `[[…]]` for a moved file, given what the link said before. */
  wikilinkTextFor: (newPath: string, originalTarget: string) => string;
}

export interface LinkRewriteResult {
  content: string;
  /** Number of links changed. */
  count: number;
}

export function rewriteMovedLinks(content: string, ctx: LinkRewriteContext): LinkRewriteResult {
  let count = 0;
  let inFence: string | null = null;

  const movedTarget = (target: string): string | null => {
    const resolved = ctx.resolve(target, ctx.notePath);
    return resolved ? ctx.moved.get(resolved.toLowerCase()) ?? null : null;
  };

  const rewriteText = (text: string): string =>
    text
      // [[target#heading|alias]] and ![[…]]
      .replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (whole, bang: string, inner: string) => {
        const pipe = inner.indexOf('|');
        const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
        const alias = pipe >= 0 ? inner.slice(pipe) : '';
        const hash = targetPart.indexOf('#');
        const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
        const heading = hash >= 0 ? targetPart.slice(hash) : '';
        if (!target) return whole;

        const newPath = movedTarget(target);
        if (!newPath) return whole;
        const newTarget = ctx.wikilinkTextFor(newPath, target);
        if (newTarget === target) return whole;

        count++;
        return `${bang}[[${newTarget}${heading}${alias}]]`;
      })
      // [text](target) / [text](<target>) / ![alt](…)
      .replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, open: string, rawTarget: string, close: string) => {
        const angled = rawTarget.startsWith('<');
        let target = angled ? rawTarget.slice(1, -1) : rawTarget;
        const legacy = target.match(/^(wikilink(?:-blob)?:)(.+)$/);
        if (!legacy && (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#'))) return whole;

        const hashAt = legacy ? -1 : target.indexOf('#');
        const fragment = hashAt >= 0 ? target.slice(hashAt) : '';
        target = legacy ? legacy[2] : hashAt >= 0 ? target.slice(0, hashAt) : target;
        let decoded = target;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          // keep raw
        }

        const newPath = movedTarget(decoded);
        if (!newPath) return whole;

        let newTarget: string;
        if (legacy) {
          newTarget = `${legacy[1]}${ctx.wikilinkTextFor(newPath, decoded)}`;
        } else {
          const relative = decoded.startsWith('./') || decoded.startsWith('../');
          const path = relative ? relativePath(dirname(ctx.newNotePath ?? ctx.notePath), newPath) : newPath;
          newTarget = (angled ? path : path.replace(/ /g, '%20')) + fragment;
        }
        const formatted = angled ? `<${newTarget}>` : newTarget;
        if (formatted === rawTarget) return whole;

        count++;
        return `${open}${formatted}${close}`;
      });

  const lines = content.split(/(\r?\n)/);
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
      continue;
    }
    if (inFence) continue;

    // Only rewrite outside inline code spans.
    lines[i] = line
      .split(/(`+[^`]*`+)/)
      .map((part, index) => (index % 2 === 1 ? part : rewriteText(part)))
      .join('');
  }

  return { content: lines.join(''), count };
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(0, at) : '';
}

/** Path to `target` from directory `fromDir`, using ./ and ../ like Obsidian's relative links. */
function relativePath(fromDir: string, target: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common].toLowerCase() === to[common].toLowerCase()) common++;
  const up = from.length - common;
  const rest = to.slice(common).join('/');
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
}

/**
 * GM-only content in notes, using Obsidian-compatible syntax:
 * - Secret callouts: a blockquote whose first line starts with `[!secret]` (optionally `[!secret]-`/`+`
 *   and a title). The whole callout is secret.
 * - Comments: `%%like this%%`, inline or spanning several lines (Obsidian hides these when reading).
 *
 * `stripSecrets` removes both before anything is sent to players.
 */

/** Classes the editor puts on GM-only content; broadcasting removes elements with them. */
export const SECRET_BLOCK_CLASS = 'md-secret-block';
export const SECRET_COMMENT_CLASS = 'md-secret-comment';
export const SECRET_SELECTOR = `.${SECRET_BLOCK_CLASS}, .${SECRET_COMMENT_CLASS}`;

/** Callout marker at the start of a blockquote line (after any `>` prefixes). */
export const SECRET_CALLOUT_MARKER = /^\[!secret\][+-]?/i;

export interface StripSecretsResult {
  markdown: string;
  /** How many secret callouts and comments were removed. */
  removed: number;
}

export function stripSecrets(markdown: string): StripSecretsResult {
  let removed = 0;
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];

  let fence: string | null = null;
  /** Blockquote depth of the secret callout being skipped, or 0. */
  let secretDepth = 0;
  let inComment = false;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (!inComment && !secretDepth && fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      kept.push(line);
      continue;
    }
    if (fence) {
      kept.push(line);
      continue;
    }

    const quote = line.match(/^(\s*(?:>\s?)+)(.*)$/);
    const depth = quote ? (quote[1].match(/>/g) ?? []).length : 0;

    // Inside a secret callout: skip every line quoted at least as deeply.
    if (secretDepth) {
      if (depth >= secretDepth) continue;
      secretDepth = 0;
    }

    // Start of a secret callout.
    if (quote && SECRET_CALLOUT_MARKER.test(quote[2].trim())) {
      secretDepth = depth;
      removed++;
      continue;
    }

    const result = stripComments(line, inComment);
    inComment = result.open;
    removed += result.removed;
    // Drop lines that were only a comment, rather than leaving a blank line behind.
    if (result.text.trim() === '' && line.trim() !== '') continue;
    kept.push(result.text);
  }

  const markdownOut = kept
    .join(eol)
    .replace(/(\r?\n){3,}/g, `${eol}${eol}`);
  return { markdown: markdownOut, removed };
}

/** Removes `%%…%%` from one line, outside inline code. `open` carries a multi-line comment over. */
function stripComments(line: string, open: boolean): { text: string; open: boolean; removed: number } {
  let text = '';
  let removed = 0;
  let inComment = open;
  let i = 0;

  while (i < line.length) {
    if (!inComment && line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        text += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (line.startsWith('%%', i)) {
      if (!inComment) removed++;
      inComment = !inComment;
      i += 2;
      continue;
    }

    if (!inComment) text += line[i];
    i++;
  }

  return { text: inComment || open ? text.replace(/\s+$/, '') : text, open: inComment, removed };
}

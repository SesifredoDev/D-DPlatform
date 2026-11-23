/**
 * YAML frontmatter helpers (the `---` block at the top of a note, used by Obsidian for Properties).
 *
 * These only touch the parts they need and leave every other line of the frontmatter exactly as written.
 */

export interface FrontmatterSplit {
  /** The raw frontmatter block, including delimiters and any blank lines after it; '' if none. */
  block: string;
  /** The YAML between the delimiters, or null if the note has no frontmatter. */
  yaml: string | null;
  /** Blank lines between the closing `---` and the body (kept so saving doesn't reflow the note). */
  gap: string;
  /** Everything after the frontmatter. */
  body: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)((?:[ \t]*\r?\n)*)/;

export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = content.match(FRONTMATTER);
  if (!match) return { block: '', yaml: null, gap: '', body: content };

  return {
    block: match[0],
    yaml: match[1].replace(/\r?\n$/, ''),
    gap: match[2],
    body: content.slice(match[0].length),
  };
}

/** Tags from the frontmatter `tags:` (or `tag:`) property, without '#', in the order written. */
export function readFrontmatterTags(content: string): string[] {
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return [];

  const lines = yaml.split(/\r?\n/);
  const found = findTagsProperty(lines);
  if (!found) return [];

  const values = found.inlineValue !== ''
    ? parseInlineList(found.inlineValue)
    : lines.slice(found.start + 1, found.end).map(line => line.replace(/^\s*-\s*/, ''));

  return unique(values.map(cleanTag).filter(Boolean));
}

/**
 * Returns `content` with the frontmatter `tags` property set to `tags`.
 * - Keeps the property's existing style (`tags: [a, b]` or a `- a` list); new properties use a list,
 *   like Obsidian's Properties editor.
 * - Adds frontmatter if the note has none; removes the property (and an emptied frontmatter) when
 *   `tags` is empty.
 */
export function setFrontmatterTags(content: string, tags: string[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const split = splitFrontmatter(content);
  const lines = split.yaml === null || split.yaml === '' ? [] : split.yaml.split(/\r?\n/);
  const cleanTags = unique(tags.map(cleanTag).filter(Boolean));

  const found = findTagsProperty(lines);
  const insertAt = found ? found.start : lines.length;
  const flowStyle = !!found && found.inlineValue.startsWith('[');
  if (found) {
    lines.splice(found.start, found.end - found.start);
  }

  if (cleanTags.length) {
    const property = flowStyle
      ? [`tags: [${cleanTags.join(', ')}]`]
      : ['tags:', ...cleanTags.map(tag => `  - ${tag}`)];
    lines.splice(insertAt, 0, ...property);
  }

  if (!lines.length) {
    return split.body;
  }
  return `---${eol}${lines.join(eol)}${eol}---${eol}${split.gap}${split.body}`;
}

/**
 * Normalises what someone types into a tag: strips '#', turns spaces into '-', drops characters
 * Obsidian doesn't allow. Returns null if nothing valid is left (tags can't be all digits).
 */
export function normalizeTagInput(raw: string): string | null {
  const tag = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '');

  return tag && /[^\d/]/.test(tag) ? tag : null;
}

/** Finds the `tags:`/`tag:` property: its line, the end of its list items, and any same-line value. */
function findTagsProperty(lines: string[]): { start: number; end: number; inlineValue: string } | null {
  const start = lines.findIndex(line => /^tags?\s*:/i.test(line));
  if (start < 0) return null;

  const inlineValue = lines[start].replace(/^tags?\s*:\s*/i, '').trim();
  let end = start + 1;
  if (inlineValue === '') {
    // Block list items (or other indented continuation lines) belong to the property.
    while (end < lines.length && /^(\s+\S|\s*-\s)/.test(lines[end])) end++;
  }
  return { start, end, inlineValue };
}

function parseInlineList(value: string): string[] {
  const inner = value.startsWith('[') ? value.replace(/^\[|\]$/g, '') : value;
  return inner.split(/[,\s]+/);
}

function cleanTag(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Obsidian callouts: a blockquote whose first line starts with `[!type]`, optionally followed by
 * `-`/`+` (folding) and a title, e.g. `> [!warning] Trapped door`.
 *
 * Types and aliases follow Obsidian, plus `read-aloud` for D&D boxed text and `secret` for GM-only
 * content (see secrets.ts). Unknown types render like `note`, as in Obsidian.
 */

/** Classes the editor puts on rendered callouts and their `[!type]` marker text. */
export const CALLOUT_CLASS = 'md-callout';
export const CALLOUT_MARKER_CLASS = 'md-callout-marker';
/** Buttons the editor adds inside callouts (e.g. read-aloud Broadcast); never broadcast themselves. */
export const CALLOUT_ACTION_CLASS = 'md-callout-action';

export interface CalloutType {
  id: string;
  /** Shown as the callout's label in the editor, and as its title when broadcast without one. */
  label: string;
  aliases?: readonly string[];
}

export const CALLOUT_TYPES: readonly CalloutType[] = [
  { id: 'note', label: 'Note' },
  { id: 'info', label: 'Info' },
  { id: 'todo', label: 'To do' },
  { id: 'abstract', label: 'Summary', aliases: ['summary', 'tldr'] },
  { id: 'tip', label: 'Tip', aliases: ['hint', 'important'] },
  { id: 'success', label: 'Success', aliases: ['check', 'done'] },
  { id: 'question', label: 'Question', aliases: ['help', 'faq'] },
  { id: 'warning', label: 'Warning', aliases: ['caution', 'attention'] },
  { id: 'failure', label: 'Failure', aliases: ['fail', 'missing'] },
  { id: 'danger', label: 'Danger', aliases: ['error'] },
  { id: 'bug', label: 'Bug' },
  { id: 'example', label: 'Example' },
  { id: 'quote', label: 'Quote', aliases: ['cite'] },
  { id: 'read-aloud', label: 'Read aloud', aliases: ['readaloud', 'boxed-text', 'boxed'] },
  { id: 'secret', label: 'GM only · not broadcast' },
];

const byName = new Map<string, CalloutType>(
  CALLOUT_TYPES.flatMap(type => [[type.id, type], ...(type.aliases ?? []).map(alias => [alias, type] as const)])
);

/** `[!type]` (+ optional fold marker) at the start of a callout's first line; group 1 is the type. */
export const CALLOUT_MARKER = /^\[!([\w-]+)\][+-]?/;

/** The callout type for a name as written (case-insensitive, aliases resolved); unknown → a note-like type. */
export function resolveCalloutType(name: string): CalloutType {
  const lower = name.toLowerCase();
  return byName.get(lower) ?? { id: lower, label: toTitle(lower) };
}

/**
 * Rewrites callout header lines into plain Markdown for players: `> [!warning] Trap` → `> **Trap**`,
 * `> [!read-aloud]` → `> **Read aloud**`. Run after `stripSecrets`. Code blocks are left alone.
 */
export function formatCalloutsForBroadcast(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split(/(\r?\n)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const fenceMatch = part.match(/^\s*(```+|~~~+)/);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = null;
        return part;
      }
      if (fence) return part;

      const header = part.match(/^(\s*(?:>\s?)+)\[!([\w-]+)\][+-]?[ \t]*(.*)$/);
      if (!header) return part;
      const [, prefix, type, title] = header;
      return `${prefix}**${title.trim() || resolveCalloutType(type).label}**`;
    })
    .join('');
}

function toTitle(value: string): string {
  const words = value.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Note';
}

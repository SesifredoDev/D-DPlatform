/**
 * Dates written inside notes, as Dataview inline fields: `[date:: 15 Mirtul 1492 DR]`.
 * They can sit mid-sentence ("We left on [date:: 15 Mirtul 1492 DR] at dawn"), and can be relative
 * to the date before them ("[date:: 3 days later]"). A calendar can be named first
 * ("[date:: Harptos 15 Mirtul 1492]"); otherwise it's worked out from the text, then the note's
 * `calendar` property, then the vault's default calendar.
 *
 * Pure functions, no Angular.
 */

/** `[date:: …]`, not inside a wikilink. */
export const INLINE_DATE = /\[date::\s*([^\]\n]+?)\s*\]/gi;

export interface InlineDateMatch {
  /** The whole `[date:: …]`. */
  raw: string;
  /** What's written inside, e.g. "15 Mirtul 1492 DR". */
  text: string;
  /** Offset of `raw` in the searched text. */
  index: number;
  /** Offset of `text` in the searched text. */
  textIndex: number;
}

export function findInlineDates(text: string): InlineDateMatch[] {
  const matches: InlineDateMatch[] = [];
  for (const match of text.matchAll(INLINE_DATE)) {
    const index = match.index ?? 0;
    matches.push({ raw: match[0], text: match[1], index, textIndex: index + match[0].indexOf(match[1]) });
  }
  return matches;
}

/** The `[date:: …]` texts of a note, in order (code blocks skipped). */
export function extractInlineDates(markdown: string): string[] {
  const withoutCode = markdown.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
  return findInlineDates(withoutCode).map(match => match.text);
}

/** A date text to put in a note. */
export function inlineDate(text: string): string {
  return `[date:: ${text.trim()}]`;
}

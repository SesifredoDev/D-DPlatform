/** Helpers for searching and highlighting in the vault view. Pure functions, no Angular. */

export interface TextSegment {
  text: string;
  match: boolean;
}

export interface FuzzyMatch {
  score: number;
  /** Indices in the candidate text of the matched characters. */
  indices: number[];
}

const WORD_BOUNDARY = /[\s\-_/.()[\]]/;

/**
 * Fuzzy-matches `query` against `text` (case-insensitive): every query character must appear in
 * order. Scores favour contiguous runs, word starts and prefixes, so "ses2" ranks "Session 2"
 * above "Sessions/Bestiary 2". Returns null when the query doesn't match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const t = text.toLowerCase();

  // Exact substring: strongest signal, and highlight it as one run.
  const substringAt = t.indexOf(q);
  if (substringAt >= 0) {
    const atWordStart = substringAt === 0 || WORD_BOUNDARY.test(t[substringAt - 1]);
    const score = 100 + (substringAt === 0 ? 40 : atWordStart ? 20 : 0) + q.length * 4 - t.length * 0.1;
    return { score, indices: range(substringAt, substringAt + q.length) };
  }

  const indices: number[] = [];
  let score = 0;
  let searchFrom = 0;
  let previous = -2;

  for (const char of q) {
    if (char === ' ') continue;
    const found = t.indexOf(char, searchFrom);
    if (found < 0) return null;

    if (found === previous + 1) {
      score += 8;
    } else if (found === 0 || WORD_BOUNDARY.test(t[found - 1])) {
      score += 6;
    } else {
      score += 1;
    }
    score -= Math.min(found - searchFrom, 10) * 0.5;

    indices.push(found);
    previous = found;
    searchFrom = found + 1;
  }

  return { score: score - t.length * 0.1, indices };
}

/** Splits text into matched / unmatched runs for the given character indices. */
export function segmentsFromIndices(text: string, indices: number[]): TextSegment[] {
  if (!indices.length) return text ? [{ text, match: false }] : [];

  const marked = new Set(indices);
  const segments: TextSegment[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) {
      last.text += text[i];
    } else {
      segments.push({ text: text[i], match });
    }
  }
  return segments;
}

/**
 * Highlights every occurrence of each search term (words of the query, case-insensitive) in text.
 * Used for content-search snippets.
 */
export function highlightTerms(text: string, query: string): TextSegment[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length > 0);
  if (!terms.length || !text) return text ? [{ text, match: false }] : [];

  const lower = text.toLowerCase();
  const indices: number[] = [];
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at >= 0) {
      indices.push(...range(at, at + term.length));
      at = lower.indexOf(term, at + term.length);
    }
  }
  return segmentsFromIndices(text, indices);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

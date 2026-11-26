import { restoreObsidianSyntax } from '../../components/milkdown-editor/wikilink-plugin';
import { extractInlineDates, findInlineDates, inlineDate } from './inline-dates';

describe('inline dates', () => {
  it('finds [date:: …] mid-sentence, with positions', () => {
    const text = 'We left on [date:: 15 Mirtul 1492 DR] and arrived [date::3 days later].';
    const matches = findInlineDates(text);
    expect(matches.map(m => m.text)).toEqual(['15 Mirtul 1492 DR', '3 days later']);
    expect(text.slice(matches[0].textIndex, matches[0].textIndex + matches[0].text.length)).toBe('15 Mirtul 1492 DR');
    expect(text.slice(matches[1].index, matches[1].index + matches[1].raw.length)).toBe('[date::3 days later]');
  });

  it('skips code when indexing a note', () => {
    expect(extractInlineDates('A [date:: 1 Hammer 1492 DR]\n```\n[date:: 2 Hammer 1492 DR]\n```\n`[date:: x]`')).toEqual(['1 Hammer 1492 DR']);
  });

  it('writes the syntax and survives the editor’s Markdown escaping', () => {
    expect(inlineDate(' 15 Mirtul 1492 DR ')).toBe('[date:: 15 Mirtul 1492 DR]');
    expect(restoreObsidianSyntax('We left on \[date:: 15 Mirtul 1492 DR] at dawn')).toBe('We left on [date:: 15 Mirtul 1492 DR] at dawn');
  });
});

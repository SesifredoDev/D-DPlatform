import { fuzzyMatch, highlightTerms, segmentsFromIndices } from './vault-search-utils';

const rank = (query: string, candidates: string[]) =>
  candidates
    .map(text => ({ text, match: fuzzyMatch(query, text) }))
    .filter(c => c.match)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map(c => c.text);

describe('fuzzyMatch', () => {
  it('matches characters in order, case-insensitively', () => {
    expect(fuzzyMatch('strd', 'Strahd')).not.toBeNull();
    expect(fuzzyMatch('dstr', 'Strahd')).toBeNull();
  });

  it('ranks prefixes, then word starts, then scattered matches', () => {
    expect(rank('bar', ['Rebar notes', 'Barovia', 'Old Barovia'])).toEqual(['Barovia', 'Old Barovia', 'Rebar notes']);
    expect(rank('ses2', ['Sessions Bestiary 2', 'Session 2'])[0]).toBe('Session 2');
  });

  it('ignores spaces in the query and returns matched indices', () => {
    const match = fuzzyMatch('s 1', 'Session 1');
    expect(match).not.toBeNull();
    expect(match!.indices).toEqual([0, 8]);
  });

  it('treats an empty query as a match with no highlights', () => {
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, indices: [] });
  });
});

describe('segmentsFromIndices', () => {
  it('groups adjacent characters into runs', () => {
    expect(segmentsFromIndices('Strahd', [0, 1, 5])).toEqual([
      { text: 'St', match: true },
      { text: 'rah', match: false },
      { text: 'd', match: true },
    ]);
  });
});

describe('highlightTerms', () => {
  it('highlights every occurrence of every query word', () => {
    expect(highlightTerms('The lord of Barovia rules barovia.', 'barovia lord')).toEqual([
      { text: 'The ', match: false },
      { text: 'lord', match: true },
      { text: ' of ', match: false },
      { text: 'Barovia', match: true },
      { text: ' rules ', match: false },
      { text: 'barovia', match: true },
      { text: '.', match: false },
    ]);
  });

  it('returns the text unhighlighted when nothing matches', () => {
    expect(highlightTerms('Nothing here', 'zzz')).toEqual([{ text: 'Nothing here', match: false }]);
  });
});

import { formatCalloutsForBroadcast, resolveCalloutType } from './callouts';

describe('resolveCalloutType', () => {
  it('resolves ids and Obsidian aliases case-insensitively', () => {
    expect(resolveCalloutType('WARNING').id).toBe('warning');
    expect(resolveCalloutType('caution').id).toBe('warning');
    expect(resolveCalloutType('tldr').id).toBe('abstract');
    expect(resolveCalloutType('Read-Aloud').label).toBe('Read aloud');
  });

  it('treats unknown types as their own name', () => {
    expect(resolveCalloutType('lore_drop')).toEqual({ id: 'lore_drop', label: 'Lore drop' });
  });
});

describe('formatCalloutsForBroadcast', () => {
  it('turns callout headers into bold titles', () => {
    expect(formatCalloutsForBroadcast('> [!warning]- Trapped door\n> DC 15 to spot.'))
      .toBe('> **Trapped door**\n> DC 15 to spot.');
    expect(formatCalloutsForBroadcast('> [!read-aloud]\n>\n> The mist parts.'))
      .toBe('> **Read aloud**\n>\n> The mist parts.');
  });

  it('handles nested callouts and keeps CRLF', () => {
    expect(formatCalloutsForBroadcast('> Quote\r\n> > [!tip] Hint\r\n> > text'))
      .toBe('> Quote\r\n> > **Hint**\r\n> > text');
  });

  it('leaves plain quotes, other text and code untouched', () => {
    const content = '> Just a quote\n[!note] not in a quote\n```\n> [!note] code\n```';
    expect(formatCalloutsForBroadcast(content)).toBe(content);
  });
});

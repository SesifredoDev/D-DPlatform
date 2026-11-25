import { embedAlias } from './wikilink-plugin';
import { formatEmbedSize, parseEmbedSize } from './embed-size';

describe('embed sizes', () => {
  it('reads Obsidian widths, width × height and height-only sizes', () => {
    expect(parseEmbedSize('300')).toEqual({ width: 300, height: null });
    expect(parseEmbedSize('300x200')).toEqual({ width: 300, height: 200 });
    expect(parseEmbedSize('x420')).toEqual({ width: null, height: 420 });
    expect(parseEmbedSize(' 640 x 360 ')).toEqual({ width: 640, height: 360 });
  });

  it('treats captions and nonsense as no size', () => {
    expect(parseEmbedSize('A ruined keep')).toBeNull();
    expect(parseEmbedSize('')).toBeNull();
    expect(parseEmbedSize('0')).toBeNull();
    expect(parseEmbedSize('x0')).toBeNull();
    expect(parseEmbedSize('1.00')).toBeNull();
  });

  it('writes sizes back, and they survive saving as ![[…|size]]', () => {
    expect(formatEmbedSize({ width: 300.4, height: null })).toBe('300');
    expect(formatEmbedSize({ width: 300, height: 200 })).toBe('300x200');
    expect(formatEmbedSize({ width: null, height: 420 })).toBe('x420');
    expect(formatEmbedSize(null)).toBe('');
    for (const alias of ['300', '300x200', 'x420']) {
      expect(embedAlias(alias, 'Maps/coast.png')).toBe(alias);
    }
  });
});

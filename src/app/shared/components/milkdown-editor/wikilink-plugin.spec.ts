import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { embedAlias, remarkWikilinks, restoreObsidianSyntax } from './wikilink-plugin';

/** Load + save, the way the editor does: parse, run the wikilink transform, stringify. */
function roundTrip(markdown: string): string {
  const processor = unified().use(remarkParse).use(remarkStringify).use(remarkWikilinks);
  return String(processor.processSync(markdown)).trimEnd();
}

describe('wikilink plugin round trip', () => {
  it.each([
    ['plain wikilink', 'Start with [[Session 1]] today.'],
    ['aliased wikilink', 'They fled from [[NPCs/Villains/Strahd|the Count]].'],
    ['heading link', 'See [[Strahd#Lair Actions]].'],
    ['embed', '![[map.png]]'],
    ['embed with size', '![[map.png|300]]'],
    ['line-start tags', '#campaign #handout'],
    ['nested tag', '#quest/main'],
    ['normal link', '[Open5e](https://open5e.com)'],
    ['real heading', '# Session 1'],
  ])('keeps %s unchanged', (_, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('keeps a local-file image as a normal Markdown image', () => {
    expect(roundTrip('![map](file:///C:/maps/barovia.png)')).toBe('![map](file:///C:/maps/barovia.png)');
  });

  it('keeps text that would otherwise become a heading escaped', () => {
    expect(roundTrip('\\# not a heading')).toBe('\\# not a heading');
  });

  it('repairs notes saved in the old broken format', () => {
    expect(roundTrip('Start with [Session 1](<wikilink:Session 1>) or [the Count](wikilink:Strahd).'))
      .toBe('Start with [[Session 1]] or [[Strahd|the Count]].');
    expect(roundTrip('![map.png](wikilink-blob:map.png)')).toBe('![[map.png]]');
    expect(roundTrip('\\#campaign')).toBe('#campaign');
  });
});

describe('embedAlias (Crepe image-block ratios)', () => {
  it.each([
    ['', ''],
    ['map.png', ''],
    ['1.00', ''],
    ['300.00', '300'],
    ['0.75', ''],
    ['300', '300'],
    ['Old map of Barovia', 'Old map of Barovia'],
  ])('alt %j -> alias %j', (alt, expected) => {
    expect(embedAlias(alt, 'map.png')).toBe(expected);
  });
});

describe('restoreObsidianSyntax', () => {
  it('unescapes wikilinks typed straight into the editor', () => {
    expect(restoreObsidianSyntax('see \\[\\[Barovia]] and \\!\\[\\[map.png]]')).toBe('see [[Barovia]] and ![[map.png]]');
    expect(restoreObsidianSyntax('\\[\\[my\\_note|Alias]]')).toBe('[[my_note|Alias]]');
  });

  it('only unescapes # when it cannot start a heading', () => {
    expect(restoreObsidianSyntax('\\#tag')).toBe('#tag');
    expect(restoreObsidianSyntax('\\# heading text')).toBe('\\# heading text');
  });
});

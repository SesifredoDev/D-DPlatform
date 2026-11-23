import { normalizeTagInput, readFrontmatterTags, setFrontmatterTags, splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('splits the block, YAML, gap and body', () => {
    const split = splitFrontmatter('---\ntags: [npc]\nfaction: Harpers\n---\n\n# Aldric\nText');
    expect(split.yaml).toBe('tags: [npc]\nfaction: Harpers');
    expect(split.gap).toBe('\n');
    expect(split.body).toBe('# Aldric\nText');
    expect(split.block + split.body).toBe('---\ntags: [npc]\nfaction: Harpers\n---\n\n# Aldric\nText');
  });

  it('handles empty frontmatter, CRLF and notes without frontmatter', () => {
    expect(splitFrontmatter('---\n---\nBody').yaml).toBe('');
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nBody').body).toBe('Body');
    expect(splitFrontmatter('# Title\n---\n').yaml).toBeNull();
  });

  it('does not treat a horizontal rule later in the note as frontmatter', () => {
    expect(splitFrontmatter('Intro\n---\nmore').yaml).toBeNull();
  });
});

describe('readFrontmatterTags', () => {
  it.each([
    ['flow list', '---\ntags: [npc, "ally"]\n---\n', ['npc', 'ally']],
    ['block list', '---\ntags:\n  - npc\n  - "#faction/harpers"\n---\n', ['npc', 'faction/harpers']],
    ['comma scalar', '---\ntags: npc, villain\n---\n', ['npc', 'villain']],
    ['singular key', '---\ntag: npc\n---\n', ['npc']],
    ['no tags', '---\nfaction: x\n---\n', []],
    ['no frontmatter', '# Note #inline', []],
  ])('%s', (_, content, expected) => {
    expect(readFrontmatterTags(content)).toEqual(expected);
  });
});

describe('setFrontmatterTags', () => {
  it('adds frontmatter with a tags list when there is none', () => {
    expect(setFrontmatterTags('# Strahd\nText', ['npc', 'villain']))
      .toBe('---\ntags:\n  - npc\n  - villain\n---\n# Strahd\nText');
  });

  it('keeps flow style and every other property untouched', () => {
    const before = '---\nfaction: Harpers\ntags: [npc]\nstatus: alive\n---\n\n# Aldric';
    expect(setFrontmatterTags(before, ['npc', 'ally']))
      .toBe('---\nfaction: Harpers\ntags: [npc, ally]\nstatus: alive\n---\n\n# Aldric');
  });

  it('replaces a block list in place', () => {
    const before = '---\ntags:\n  - npc\nstatus: alive\n---\nBody';
    expect(setFrontmatterTags(before, ['npc', 'undead'])).toBe('---\ntags:\n  - npc\n  - undead\nstatus: alive\n---\nBody');
  });

  it('removes the property, and the frontmatter when nothing else is left', () => {
    expect(setFrontmatterTags('---\ntags: [npc]\nstatus: alive\n---\nBody', [])).toBe('---\nstatus: alive\n---\nBody');
    expect(setFrontmatterTags('---\ntags:\n  - npc\n---\nBody', [])).toBe('Body');
  });

  it('keeps CRLF line endings and drops duplicate tags', () => {
    expect(setFrontmatterTags('---\r\na: 1\r\n---\r\nBody', ['npc', 'NPC', '#npc']))
      .toBe('---\r\na: 1\r\ntags:\r\n  - npc\r\n---\r\nBody');
  });

  it('round-trips with readFrontmatterTags', () => {
    const content = setFrontmatterTags('Body', ['quest/main', 'npc']);
    expect(readFrontmatterTags(content)).toEqual(['quest/main', 'npc']);
  });
});

describe('normalizeTagInput', () => {
  it.each([
    ['#npc', 'npc'],
    ['  Big Bad  ', 'Big-Bad'],
    ['faction//harpers/', 'faction/harpers'],
    ['quest!?', 'quest'],
    ['1984', null],
    ['#', null],
    ['   ', null],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeTagInput(raw)).toBe(expected);
  });
});

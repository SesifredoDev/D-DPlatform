import { stripSecrets } from './secrets';

describe('stripSecrets', () => {
  it('removes a secret callout and keeps the rest', () => {
    const result = stripSecrets([
      '# Strahd',
      '',
      'The lord of Barovia.',
      '',
      '> [!secret] GM only',
      '> He is a vampire.',
      '>',
      '> Weak to sunlight.',
      '',
      'Lives in the castle.',
    ].join('\n'));
    expect(result.markdown).toBe('# Strahd\n\nThe lord of Barovia.\n\nLives in the castle.');
    expect(result.removed).toBe(1);
  });

  it('handles foldable markers, case and callouts nested in a quote', () => {
    expect(stripSecrets('> [!SECRET]- Hidden\n> text\nafter').markdown).toBe('after');
    expect(stripSecrets('> Public quote\n> > [!secret]\n> > hidden\n> still public').markdown)
      .toBe('> Public quote\n> still public');
  });

  it('keeps other callouts and plain quotes', () => {
    const content = '> [!note] Read aloud\n> The mist parts.\n\n> A quote';
    expect(stripSecrets(content)).toEqual({ markdown: content, removed: 0 });
  });

  it('removes inline and multi-line %% comments', () => {
    expect(stripSecrets('Aldric %%is a spy%% runs the inn.').markdown).toBe('Aldric  runs the inn.');
    expect(stripSecrets('Before\n%%\nsecret plan\nmore\n%%\nAfter').markdown).toBe('Before\nAfter');
    expect(stripSecrets('Start %%hidden\nstill hidden%% end').markdown).toBe('Start\n end');
  });

  it('leaves code alone', () => {
    const content = 'Use `%%` for comments.\n\n```\n> [!secret]\n%%not a comment%%\n```';
    expect(stripSecrets(content)).toEqual({ markdown: content, removed: 0 });
  });

  it('counts every secret removed', () => {
    expect(stripSecrets('a %%x%% b %%y%%\n\n> [!secret]\n> z').removed).toBe(3);
  });

  it('keeps CRLF line endings', () => {
    expect(stripSecrets('One\r\n> [!secret]\r\n> hidden\r\nTwo').markdown).toBe('One\r\nTwo');
  });
});

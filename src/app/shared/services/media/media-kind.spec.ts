import { mediaKindOf } from './media-playback.service';
import { getVaultFileType } from '../ObsidianVault/vault-file-types';

describe('mediaKindOf', () => {
  it('reads the content type first', () => {
    expect(mediaKindOf('clip.webm', 'audio/webm')).toBe('audio');
    expect(mediaKindOf('song.mp3', 'video/mp4')).toBe('video');
  });

  it('falls back to the extension', () => {
    expect(mediaKindOf('Tavern Theme.MP3')).toBe('audio');
    expect(mediaKindOf('battle.opus', '')).toBe('audio');
    expect(mediaKindOf('intro.mp4')).toBe('video');
    expect(mediaKindOf('intro.webm')).toBe('video');
    expect(mediaKindOf('notes.md')).toBeNull();
  });

  it('matches the vault file types that open in the player', () => {
    for (const name of ['a.mp3', 'a.ogg', 'a.flac', 'a.m4a', 'a.wav', 'a.mp4', 'a.webm', 'a.mov']) {
      expect(getVaultFileType(name).viewer).toBe('media');
      expect(mediaKindOf(name)).not.toBeNull();
    }
  });
});

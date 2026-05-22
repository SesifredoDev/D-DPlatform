import type { RecordedSpotifyState } from '../../../shared/models/pages/dashboard/call/call.model';

export function createRecordedSpotifyStateFromCurrent(
  track: any,
  isPaused: boolean,
  shuffle: boolean,
  volumePercent: number,
  position: number = 0
): RecordedSpotifyState | null {
  if (!track?.uri) {
    return null;
  }

  return createRecordedSpotifyState({
    uri: track.uri,
    name: track.name,
    artist: getSpotifyTrackArtist(track),
    image: getSpotifyTrackImage(track),
    position,
    playing: !isPaused,
    paused: isPaused,
    contextUri: null,
    shuffle,
    volumePercent
  }, volumePercent);
}

export function createRecordedSpotifyStateFromSyncPayload(
  payload: any,
  currentTrack: any,
  fallbackIsPaused: boolean,
  fallbackVolumePercent: number
): RecordedSpotifyState | null {
  const uri = payload?.uri ?? currentTrack?.uri ?? null;
  if (!uri) {
    return null;
  }

  const payloadTrack = {
    uri,
    name: payload?.name,
    artist: payload?.artist,
    image: payload?.image,
    album: payload?.album,
    artists: payload?.artists
  };

  return createRecordedSpotifyState({
    uri,
    name: payloadTrack.name ?? currentTrack?.name,
    artist: getSpotifyTrackArtist(payloadTrack) || getSpotifyTrackArtist(currentTrack),
    image: getSpotifyTrackImage(payloadTrack) || getSpotifyTrackImage(currentTrack),
    position: payload?.position,
    playing: getSpotifyPlayingFromPayload(payload, fallbackIsPaused),
    paused: getSpotifyPausedFromPayload(payload, fallbackIsPaused),
    contextUri: payload?.contextUri ?? null,
    shuffle: payload?.shuffle,
    volumePercent: payload?.volumePercent ?? fallbackVolumePercent
  }, fallbackVolumePercent);
}

export function createRecordedSpotifyStateFromPlaybackState(
  playbackState: any,
  volumePercent: number
): RecordedSpotifyState | null {
  const track = playbackState?.track_window?.current_track;
  if (!track?.uri) {
    return null;
  }

  return createRecordedSpotifyState({
    uri: track.uri,
    name: track.name,
    artist: getSpotifyTrackArtist(track),
    image: getSpotifyTrackImage(track),
    position: playbackState.position,
    playing: !playbackState.paused,
    paused: playbackState.paused,
    contextUri: playbackState.context?.uri ?? null,
    shuffle: playbackState.shuffle_state,
    volumePercent
  }, volumePercent);
}

export function createRecordedSpotifyState(
  state: Partial<RecordedSpotifyState>,
  fallbackVolumePercent: number
): RecordedSpotifyState {
  const paused = state.paused === undefined
    ? state.playing === undefined ? true : !state.playing
    : !!state.paused;

  return {
    uri: state.uri ?? null,
    name: state.name ?? 'Spotify',
    artist: state.artist ?? '',
    image: state.image ?? '',
    position: Math.max(0, Number(state.position) || 0),
    playing: !paused,
    paused,
    contextUri: state.contextUri ?? null,
    shuffle: !!state.shuffle,
    volumePercent: normalizeSpotifyVolume(state.volumePercent ?? fallbackVolumePercent)
  };
}

export function normalizeSpotifyVolume(value: number | string | null | undefined): number {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

export function cloneSpotifyRequests(requests: any[] | null | undefined): any[] {
  return Array.isArray(requests)
    ? requests.map(request => ({ ...request }))
    : [];
}

function getSpotifyTrackArtist(track: any): string {
  if (!track) {
    return '';
  }

  if (track.artist) {
    return track.artist;
  }

  if (Array.isArray(track.artists)) {
    return track.artists.map((artist: any) => artist?.name).filter(Boolean).join(', ');
  }

  return '';
}

function getSpotifyTrackImage(track: any): string {
  return track?.image
    ?? track?.album?.images?.[0]?.url
    ?? track?.images?.[0]?.url
    ?? '';
}

function getSpotifyPausedFromPayload(payload: any, fallbackIsPaused: boolean): boolean {
  if (payload?.paused !== undefined) {
    return !!payload.paused;
  }

  if (payload?.playing !== undefined) {
    return !payload.playing;
  }

  if (payload?.isPlaying !== undefined) {
    return !payload.isPlaying;
  }

  return fallbackIsPaused;
}

function getSpotifyPlayingFromPayload(payload: any, fallbackIsPaused: boolean): boolean {
  return !getSpotifyPausedFromPayload(payload, fallbackIsPaused);
}

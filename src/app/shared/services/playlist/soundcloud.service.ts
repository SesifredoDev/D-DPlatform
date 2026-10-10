import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { SharedWindowStateService } from '../window-state/shared-window-state.service';
import { PlaylistService, Song, Tag } from './playlist-service';
import type {
  SoundCloudSearchResult,
  SoundCloudDevice,
  SoundCloudSyncEvent,
  SoundCloudPlaylistImportResult,
  SoundCloudMusicListExport,
  SoundCloudMusicListImportResult
} from '../../models/playlist/soundcloud.service.model';
export type {
  SoundCloudSearchResult,
  SoundCloudDevice,
  SoundCloudSyncEvent,
  SoundCloudPlaylistImportResult,
  SoundCloudMusicListExport,
  SoundCloudMusicListImportResult
} from '../../models/playlist/soundcloud.service.model';

export interface SoundCloudLivestreamPlaybackState {
  title: string;
  artist: string;
  image: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  volumePercent: number;
  audioStream: MediaStream | null;
  canCaptureAudio: boolean;
  audioStreamIsPostVolume?: boolean;
  captureSource?: 'native' | 'output-capture' | 'none';
}

export interface SoundCloudLivestreamOutputCaptureState {
  active: boolean;
  error: string;
  status: string;
  trackCount: number;
}

@Injectable({ providedIn: 'root' })
export class SoundCloudService {
  private static readonly savedItemsStateKey = 'music:saved-items';
  private static readonly pinnedItemsStateKey = 'music:pinned-items';
  private static readonly browserDeviceId = 'music-player';
  private static readonly defaultVolumePercent = 25;

  private readonly audio = new Audio();
  private mediaCaptureStream: MediaStream | null = null;
  private streamUrlByUri = new Map<string, string>();
  private localQueue: SoundCloudSearchResult[] = [];
  private queueIndex = -1;
  private allSongs: SoundCloudSearchResult[] = [];
  private currentPositionMs = 0;
  private currentDurationMs = 0;
  private volumePercent = SoundCloudService.defaultVolumePercent;
  private lastContextUri: string | null = null;
  private livestreamOutputCaptureStream: MediaStream | null = null;

  public isReady$ = new BehaviorSubject<boolean>(true);
  public currentTrack$ = new BehaviorSubject<SoundCloudSearchResult | null>(null);
  public isPaused$ = new BehaviorSubject<boolean>(true);
  public shuffleState$ = new BehaviorSubject<boolean>(false);
  public queue$ = new BehaviorSubject<SoundCloudSearchResult[]>([]);
  public isAuthorized$ = new BehaviorSubject<boolean>(true);
  public error$ = new BehaviorSubject<string | null>(null);
  public devices$ = new BehaviorSubject<SoundCloudDevice[]>([]);
  public volumePercent$ = new BehaviorSubject<number>(SoundCloudService.defaultVolumePercent);
  public playbackPositionMs$ = new BehaviorSubject<number>(0);
  public playbackDurationMs$ = new BehaviorSubject<number>(0);
  public activeDeviceId$ = new BehaviorSubject<string | null>(SoundCloudService.browserDeviceId);
  public livestreamOutputCaptureState$ = new BehaviorSubject<SoundCloudLivestreamOutputCaptureState>({
    active: false,
    error: '',
    status: 'Not connected',
    trackCount: 0
  });
  public savedItems$ = new BehaviorSubject<SoundCloudSearchResult[]>([]);
  public savedPlaylists$ = new BehaviorSubject<any[]>([]);
  public recentPlays$ = new BehaviorSubject<any[]>([]);
  public pinnedItems$ = new BehaviorSubject<any[]>([]);
  public syncAction$ = new Subject<SoundCloudSyncEvent>();

  public lastActionTime = 0;

  constructor(
    _sharedWindowState: SharedWindowStateService,
    private playlistService: PlaylistService
  ) {
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';
    this.attachAudioListeners();

    this.devices$.next([this.getBrowserDevice()]);
    this.loadSavedItems();
    this.loadPinned();
    this.setVolumePercent(this.volumePercent, true);
    this.loadCatalogSongs();
  }

  getAccessToken(): string | null {
    return null;
  }

  setTokens(_accessToken?: string, _refreshToken?: string) {
    this.isAuthorized$.next(true);
  }

  login() {
    this.isAuthorized$.next(true);
  }

  logout() {
    this.isAuthorized$.next(true);
  }

  async search(query: string): Promise<SoundCloudSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const items = this.savedItems$.value;
    if (!normalizedQuery) {
      return [...items];
    }

    return items.filter(item => {
      const metadata = [
        item.name,
        item.artist,
        item.fileName,
        ...(item.moods ?? []).map(tag => tag.name),
        ...(item.atmosphere ?? []).map(tag => tag.name)
      ].join(' ').toLowerCase();

      return metadata.includes(normalizedQuery);
    });
  }

  async addSavedItemFromUrl(url: string, type: 'track' | 'playlist' = 'track'): Promise<SoundCloudSearchResult> {
    const uri = this.normalizeExternalUri(url);
    const existing = this.findSavedItem(uri);
    if (existing) {
      return existing;
    }

    const item = this.createExternalTrack(uri, type);
    this.setSavedItems([item, ...this.savedItems$.value]);
    await this.loadSavedPlaylists();
    await this.loadRecentPlays();
    return item;
  }

  getSavedItemFromUrl(url: string): SoundCloudSearchResult | undefined {
    return this.findSavedItem(this.normalizeExternalUri(url));
  }

  isUserPlaylistSourceUrl(_url: string): boolean {
    return false;
  }

  async addUserPlaylistsFromUrl(_url: string): Promise<SoundCloudPlaylistImportResult> {
    return {
      added: [],
      duplicates: [],
      discoveredCount: 0
    };
  }

  exportMusicList(): SoundCloudMusicListExport {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      savedItems: this.savedItems$.value.map(item => ({ ...item })),
      pinnedItems: this.pinnedItems$.value.map(item => ({ ...item }))
    };
  }

  importMusicListFromJson(json: string): SoundCloudMusicListImportResult {
    let data: unknown;
    try {
      data = JSON.parse(json) as unknown;
    } catch {
      throw new Error('Invalid music list JSON.');
    }

    const parsed = data as Partial<SoundCloudMusicListExport>;
    const nextSaved = Array.isArray(parsed.savedItems) ? parsed.savedItems : [];
    const nextPinned = Array.isArray(parsed.pinnedItems) ? parsed.pinnedItems : [];
    const currentByUri = new Set(this.savedItems$.value.map(item => item.uri));
    const addedCount = nextSaved.filter(item => item?.uri && !currentByUri.has(item.uri)).length;
    const duplicateCount = nextSaved.filter(item => item?.uri && currentByUri.has(item.uri)).length;

    this.setSavedItems(this.uniqueSavedItemsByUri([...this.savedItems$.value, ...nextSaved]));
    this.setPinnedItems(this.uniquePinnedItemsByUri([...this.pinnedItems$.value, ...nextPinned]));
    void this.loadSavedPlaylists();
    void this.loadRecentPlays();

    return {
      addedCount,
      duplicateCount,
      pinnedAddedCount: nextPinned.length,
      totalSavedItems: this.savedItems$.value.length
    };
  }

  removeSavedItem(uri: string) {
    this.setSavedItems(this.savedItems$.value.filter(item => item.uri !== uri));
    if (this.isPinned(uri)) {
      this.togglePin({ uri });
    }
    void this.loadSavedPlaylists();
    void this.loadRecentPlays();
  }

  async refreshSavedThumbnails(): Promise<number> {
    return this.savedItems$.value.filter(item => !!item.image).length;
  }

  async loadSavedPlaylists() {
    this.savedPlaylists$.next(this.savedItems$.value.filter(item => item.type === 'playlist'));
  }

  async loadRecentPlays() {
    this.recentPlays$.next(
      this.savedItems$.value
        .filter(item => item.type === 'track')
        .map(track => ({ track }))
    );
  }

  async loadQueue() {
    this.queue$.next(this.localQueue.slice(Math.max(this.queueIndex + 1, 0)));
  }

  async getUserPlaylists(_userId?: string): Promise<SoundCloudSearchResult[]> {
    return [];
  }

  async getArtistAlbums(_artistId?: string): Promise<SoundCloudSearchResult[]> {
    return [];
  }

  async getUser(_userId?: string): Promise<any> {
    return null;
  }

  async getArtist(_artistId?: string): Promise<any> {
    return null;
  }

  togglePin(item: any) {
    const uri = item?.uri;
    if (!uri) return;

    const current = this.pinnedItems$.value;
    const isPinned = current.some(p => p.uri === uri);
    const updated = isPinned
      ? current.filter(p => p.uri !== uri)
      : [...current, this.toPinnedItem(item)];
    this.setPinnedItems(updated);
  }

  isPinned(uri: string): boolean {
    return this.pinnedItems$.value.some(item => item.uri === uri);
  }

  async play(
    uri?: string,
    positionMs: number = 0,
    skipSync: boolean = false,
    contextUri?: string,
    metadata?: Partial<SoundCloudSearchResult>
  ): Promise<any> {
    const track = this.resolveTrack(uri, metadata);
    if (!track) return null;

    const streamUrl = this.resolveTrackStreamUrl(track);
    this.error$.next(null);
    if (!skipSync) {
      this.lastActionTime = Date.now();
    }

    try {
      if (this.audio.src !== streamUrl) {
        this.audio.src = streamUrl;
      }

      this.currentTrack$.next(track);
      this.lastContextUri = contextUri ?? track.uri;
      this.updatePlaybackPosition(positionMs);
      this.seekNativeAudio(positionMs);
      await this.audio.play();
      this.isPaused$.next(false);
      this.updateSavedMetadata(track);

      if (!skipSync) {
        this.syncAction$.next({
          command: 'play',
          data: this.createSyncPayload(track, positionMs, false, contextUri ?? track.uri),
          source: 'manual'
        });
      }

      return track;
    } catch (error) {
      this.isPaused$.next(true);
      this.error$.next(this.getPlaybackErrorMessage(error));
      throw error;
    }
  }

  async addToQueue(uri: string): Promise<any> {
    const item = this.resolveTrack(uri) ?? this.createExternalTrack(uri, 'track');
    this.localQueue.push(item);
    await this.loadQueue();
    return item;
  }

  async clearCurrentPlayback(skipSync: boolean = true) {
    await this.pause(skipSync).catch(() => null);
    this.currentTrack$.next(null);
    this.lastContextUri = null;
    this.updatePlaybackPosition(0);
    this.updatePlaybackDuration(0);
  }

  async pause(skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();
    this.audio.pause();
    this.isPaused$.next(true);
    const state = await this.getPlaybackState();

    if (!skipSync) {
      this.syncAction$.next({
        command: 'pause',
        data: this.createSyncPayload(state?.track_window?.current_track, state?.position || 0, true, state?.context?.uri ?? null),
        source: 'manual'
      });
    }

    return state;
  }

  async togglePlay(skipSync: boolean = false) {
    if (this.isPaused$.value) {
      return this.play(this.currentTrack$.value?.uri, this.currentPositionMs, skipSync, this.lastContextUri ?? undefined);
    }
    return this.pause(skipSync);
  }

  async seek(positionMs: number, skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();
    this.seekNativeAudio(positionMs);
    this.updatePlaybackPosition(positionMs);

    if (!skipSync) {
      const state = await this.getPlaybackState();
      this.syncAction$.next({
        command: 'seek',
        data: this.createSyncPayload(state?.track_window?.current_track, this.currentPositionMs, state?.paused ?? true, state?.context?.uri ?? null),
        source: 'manual'
      });
    }
  }

  async nextTrack(skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();

    const nextQueueIndex = this.queueIndex + 1;
    if (nextQueueIndex < this.localQueue.length) {
      this.queueIndex = nextQueueIndex;
      const next = this.localQueue[this.queueIndex];
      await this.loadQueue();
      await this.play(next.uri, 0, true);
    } else if (this.shuffleState$.value && this.savedItems$.value.length) {
      const randomIndex = Math.floor(Math.random() * this.savedItems$.value.length);
      const randomTrack = this.savedItems$.value[randomIndex];
      await this.play(randomTrack.uri, 0, true);
    } else {
      await this.pause(true);
      this.updatePlaybackPosition(0);
    }

    if (!skipSync) {
      const state = await this.getPlaybackState();
      this.syncAction$.next({
        command: 'next',
        data: this.createSyncPayload(state?.track_window?.current_track, state?.position || 0, state?.paused ?? true, state?.context?.uri ?? null),
        source: 'manual'
      });
    }
  }

  async previousTrack(skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();

    if (this.queueIndex > 0) {
      this.queueIndex -= 1;
      const previous = this.localQueue[this.queueIndex];
      await this.loadQueue();
      await this.play(previous.uri, 0, true);
    } else {
      this.seekNativeAudio(0);
      this.updatePlaybackPosition(0);
    }

    if (!skipSync) {
      const state = await this.getPlaybackState();
      this.syncAction$.next({
        command: 'previous',
        data: this.createSyncPayload(state?.track_window?.current_track, state?.position || 0, state?.paused ?? true, state?.context?.uri ?? null),
        source: 'manual'
      });
    }
  }

  async toggleShuffle(state: boolean, skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();
    this.shuffleState$.next(state);

    if (!skipSync) {
      const playback = await this.getPlaybackState();
      this.syncAction$.next({
        command: 'shuffle',
        data: this.createSyncPayload(playback?.track_window?.current_track, playback?.position || 0, playback?.paused ?? true, playback?.context?.uri ?? null),
        source: 'manual'
      });
    }
  }

  async transferPlayback(deviceId: string, shouldPlay: boolean = true) {
    this.activeDeviceId$.next(deviceId);
    this.devices$.next([this.getBrowserDevice(deviceId)]);
    if (shouldPlay && this.currentTrack$.value && this.isPaused$.value) {
      await this.togglePlay(true);
    }
  }

  getVolumePercent(): number {
    return this.volumePercent;
  }

  async setVolumePercent(value: number | string, skipSync: boolean = false) {
    const nextVolume = this.normalizeVolumePercent(value);
    this.volumePercent = nextVolume;
    this.audio.volume = nextVolume / 100;
    this.volumePercent$.next(nextVolume);

    if (!skipSync) {
      this.syncAction$.next({
        command: 'volume',
        data: this.createSyncPayload(this.currentTrack$.value, this.currentPositionMs, this.isPaused$.value, this.lastContextUri),
        source: 'manual'
      });
    }
  }

  async getPlaybackState(): Promise<any> {
    const currentTrack = this.currentTrack$.value;
    return {
      position: this.currentPositionMs,
      paused: this.isPaused$.value,
      shuffle_state: this.shuffleState$.value,
      track_window: {
        current_track: currentTrack
      },
      context: {
        uri: this.lastContextUri
      }
    };
  }

  getLivestreamPlaybackState(): SoundCloudLivestreamPlaybackState | null {
    const track = this.currentTrack$.value;
    if (!track) {
      return null;
    }

    const audioStream = this.getLivestreamAudioStream();
    return {
      title: track.name || 'Music',
      artist: track.artist || '',
      image: track.image || null,
      positionMs: this.currentPositionMs,
      durationMs: this.currentDurationMs || track.duration || 0,
      paused: this.isPaused$.value,
      volumePercent: this.volumePercent,
      audioStream,
      canCaptureAudio: !!audioStream,
      audioStreamIsPostVolume: false,
      captureSource: audioStream ? 'native' : 'none'
    };
  }

  getLivestreamAudioStream(): MediaStream | null {
    const captureAudio = this.audio as HTMLAudioElement & { captureStream?: () => MediaStream };
    if (typeof captureAudio.captureStream !== 'function') {
      return this.livestreamOutputCaptureStream;
    }

    if (!this.mediaCaptureStream) {
      try {
        this.mediaCaptureStream = captureAudio.captureStream();
      } catch {
        this.mediaCaptureStream = null;
      }
    }

    return this.mediaCaptureStream || this.livestreamOutputCaptureStream;
  }

  async ensureLivestreamAudioCapture(): Promise<boolean> {
    return !!this.getLivestreamAudioStream();
  }

  async startLivestreamOutputCapture(): Promise<boolean> {
    this.livestreamOutputCaptureState$.next({
      active: false,
      error: 'Output capture is not required for the custom player.',
      status: 'Unavailable',
      trackCount: 0
    });
    return false;
  }

  stopLivestreamOutputCapture() {
    this.livestreamOutputCaptureStream?.getTracks().forEach(track => track.stop());
    this.livestreamOutputCaptureStream = null;
    this.livestreamOutputCaptureState$.next({
      active: false,
      error: '',
      status: 'Not connected',
      trackCount: 0
    });
  }

  private attachAudioListeners() {
    this.audio.addEventListener('loadedmetadata', () => {
      this.updatePlaybackDuration((this.audio.duration || 0) * 1000);
    });
    this.audio.addEventListener('timeupdate', () => {
      this.updatePlaybackPosition(this.audio.currentTime * 1000);
    });
    this.audio.addEventListener('play', () => {
      this.isPaused$.next(false);
    });
    this.audio.addEventListener('pause', () => {
      this.isPaused$.next(true);
    });
    this.audio.addEventListener('ended', () => {
      void this.nextTrack(true);
    });
    this.audio.addEventListener('error', () => {
      this.error$.next('Playback failed. Verify the stream URL returned by your music service.');
    });
  }

  private loadCatalogSongs() {
    this.playlistService.getSongs().subscribe({
      next: songs => {
        this.allSongs = songs.map(song => this.toSearchResult(song));
        const persisted = this.savedItems$.value.filter(item => item.source !== 'service');
        this.setSavedItems(this.uniqueSavedItemsByUri([...this.allSongs, ...persisted]));
        void this.loadSavedPlaylists();
        void this.loadRecentPlays();
      },
      error: () => {
        this.error$.next('Could not load songs from your music service.');
      }
    });
  }

  private toSearchResult(song: Song): SoundCloudSearchResult {
    const uri = this.getSongUri(song.fileName);
    this.streamUrlByUri.set(uri, this.playlistService.getSongStreamUrl(song.fileName));
    return {
      id: uri,
      uri,
      type: 'track',
      source: 'service',
      name: this.getNameFromFileName(song.fileName),
      artist: this.getTagOwner(song.moods, song.atmosphere),
      owner: this.getTagOwner(song.moods, song.atmosphere),
      image: song.cover || 'assets/spotify-placeholder.png',
      album: { images: [{ url: song.cover || 'assets/spotify-placeholder.png' }] },
      artists: [{ name: this.getTagOwner(song.moods, song.atmosphere) }],
      images: [{ url: song.cover || 'assets/spotify-placeholder.png' }],
      fileName: song.fileName,
      cover: song.cover,
      attribution: song.attribution || '',
      moods: song.moods ?? [],
      atmosphere: song.atmosphere ?? []
    };
  }

  private resolveTrack(uri?: string, metadata?: Partial<SoundCloudSearchResult>): SoundCloudSearchResult | null {
    const candidateUri = uri || metadata?.uri || this.currentTrack$.value?.uri;
    if (!candidateUri) {
      return null;
    }

    const normalizedUri = this.normalizeExternalUri(candidateUri);
    const savedItem = this.findSavedItem(normalizedUri);
    if (savedItem) {
      return {
        ...savedItem,
        ...metadata,
        uri: savedItem.uri
      };
    }

    return this.createExternalTrack(normalizedUri, 'track', metadata);
  }

  private resolveTrackStreamUrl(track: SoundCloudSearchResult): string {
    if (track.uri.startsWith('song:')) {
      return this.streamUrlByUri.get(track.uri) ?? this.playlistService.getSongStreamUrl(track.fileName || track.uri.replace(/^song:/, ''));
    }
    return track.uri;
  }

  private createExternalTrack(
    uri: string,
    type: 'track' | 'playlist',
    metadata: Partial<SoundCloudSearchResult> = {}
  ): SoundCloudSearchResult {
    const name = metadata.name || this.getNameFromFileName(uri) || 'Custom track';
    const image = metadata.image || 'assets/spotify-placeholder.png';
    const artist = metadata.artist || metadata.owner || 'Custom source';
    return {
      id: metadata.id || uri,
      uri,
      type,
      source: 'external',
      name,
      artist,
      owner: artist,
      image,
      album: { images: [{ url: image }] },
      artists: [{ name: artist }],
      images: [{ url: image }],
      fileName: metadata.fileName,
      cover: metadata.cover,
      attribution: metadata.attribution,
      moods: metadata.moods ?? [],
      atmosphere: metadata.atmosphere ?? []
    };
  }

  private getSongUri(fileName: string): string {
    return `song:${fileName}`;
  }

  private getNameFromFileName(fileName: string): string {
    const raw = fileName.split('/').pop() || fileName;
    return decodeURIComponent(raw).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  }

  private getTagOwner(moods?: Tag[], atmosphere?: Tag[]): string {
    const mood = (moods ?? [])[0]?.name;
    const air = (atmosphere ?? [])[0]?.name;
    if (mood && air) return `${mood} • ${air}`;
    return mood || air || 'Custom source';
  }

  private createSyncPayload(track: any, position: number, paused: boolean, contextUri: string | null) {
    return {
      uri: track?.uri ?? this.currentTrack$.value?.uri ?? null,
      name: track?.name ?? this.currentTrack$.value?.name,
      artist: track?.artist ?? this.currentTrack$.value?.artist ?? '',
      image: track?.image ?? this.currentTrack$.value?.image ?? '',
      duration: track?.duration ?? this.currentDurationMs,
      position,
      paused,
      playing: !paused,
      contextUri,
      shuffle: this.shuffleState$.value,
      volumePercent: this.volumePercent
    };
  }

  private getBrowserDevice(deviceId: string = SoundCloudService.browserDeviceId): SoundCloudDevice {
    return {
      id: deviceId,
      is_active: true,
      is_private_session: false,
      is_restricted: false,
      name: 'Custom Music Player',
      type: 'Computer',
      volume_percent: this.volumePercent
    };
  }

  private seekNativeAudio(positionMs: number) {
    const bounded = this.normalizePlaybackPosition(positionMs);
    this.audio.currentTime = bounded / 1000;
    this.updatePlaybackPosition(bounded);
  }

  private updatePlaybackPosition(value: number | string | null | undefined) {
    const positionMs = this.normalizePlaybackPosition(value);
    this.currentPositionMs = positionMs;
    this.playbackPositionMs$.next(positionMs);
  }

  private updatePlaybackDuration(value: number | string | null | undefined) {
    const numericValue = typeof value === 'number' ? value : Number(value);
    const durationMs = Number.isFinite(numericValue)
      ? Math.max(0, Math.round(numericValue))
      : 0;
    this.currentDurationMs = durationMs;
    this.playbackDurationMs$.next(durationMs);
  }

  private normalizePlaybackPosition(value: number | string | null | undefined): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.currentPositionMs;
    }
    const rounded = Math.max(0, Math.round(numericValue));
    return this.currentDurationMs > 0 ? Math.min(this.currentDurationMs, rounded) : rounded;
  }

  private normalizeVolumePercent(value: number | string): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.volumePercent;
    }
    return Math.max(0, Math.min(100, Math.round(numericValue)));
  }

  private updateSavedMetadata(track: SoundCloudSearchResult) {
    const index = this.savedItems$.value.findIndex(item => item.uri === track.uri);
    if (index < 0) return;
    const next = [...this.savedItems$.value];
    next[index] = {
      ...next[index],
      ...track
    };
    this.setSavedItems(next);
  }

  private uniqueSavedItemsByUri(items: SoundCloudSearchResult[]): SoundCloudSearchResult[] {
    const seen = new Set<string>();
    const unique: SoundCloudSearchResult[] = [];
    for (const item of items) {
      if (!item?.uri) continue;
      const uri = this.normalizeExternalUri(item.uri);
      if (seen.has(uri)) continue;
      seen.add(uri);
      unique.push({ ...item, uri });
    }
    return unique;
  }

  private uniquePinnedItemsByUri(items: any[]): any[] {
    const seen = new Set<string>();
    const unique: any[] = [];
    for (const item of items) {
      if (!item?.uri || seen.has(item.uri)) continue;
      seen.add(item.uri);
      unique.push(item);
    }
    return unique;
  }

  private findSavedItem(uri: string): SoundCloudSearchResult | undefined {
    return this.savedItems$.value.find(item => item.uri === uri || item.id === uri);
  }

  private toPinnedItem(item: any): any {
    const uri = item.uri;
    const savedItem = this.findSavedItem(uri);
    return {
      uri,
      name: item.name || savedItem?.name || 'Music item',
      type: item.type || savedItem?.type || 'track',
      id: item.id || savedItem?.id || uri,
      image: item.image || savedItem?.image || 'assets/spotify-placeholder.png',
      owner: item.owner || item.artist || savedItem?.owner || savedItem?.artist || 'Unknown'
    };
  }

  private normalizeExternalUri(value: string): string {
    const trimmed = String(value || '').trim();
    if (!/^https?:\/\//i.test(trimmed) || trimmed.startsWith('song:')) {
      return trimmed;
    }
    try {
      return new URL(trimmed).toString();
    } catch {
      return trimmed;
    }
  }

  private loadSavedItems() {
    try {
      const raw = localStorage.getItem(SoundCloudService.savedItemsStateKey);
      const parsed = raw ? JSON.parse(raw) as SoundCloudSearchResult[] : [];
      this.savedItems$.next(Array.isArray(parsed) ? this.uniqueSavedItemsByUri(parsed) : []);
    } catch {
      this.savedItems$.next([]);
    }
  }

  private setSavedItems(items: SoundCloudSearchResult[]) {
    const uniqueItems = this.uniqueSavedItemsByUri(items);
    this.savedItems$.next(uniqueItems);
    try {
      localStorage.setItem(SoundCloudService.savedItemsStateKey, JSON.stringify(uniqueItems));
    } catch {
      // Best effort persistence.
    }
  }

  private loadPinned() {
    try {
      const raw = localStorage.getItem(SoundCloudService.pinnedItemsStateKey);
      const parsed = raw ? JSON.parse(raw) as any[] : [];
      this.pinnedItems$.next(Array.isArray(parsed) ? this.uniquePinnedItemsByUri(parsed) : []);
    } catch {
      this.pinnedItems$.next([]);
    }
  }

  private setPinnedItems(items: any[]) {
    const uniqueItems = this.uniquePinnedItemsByUri(items);
    this.pinnedItems$.next(uniqueItems);
    try {
      localStorage.setItem(SoundCloudService.pinnedItemsStateKey, JSON.stringify(uniqueItems));
    } catch {
      // Best effort persistence.
    }
  }

  private getPlaybackErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return 'Could not start playback.';
  }
}

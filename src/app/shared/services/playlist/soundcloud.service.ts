import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';
import type {
  SoundCloudSearchResult,
  SoundCloudDevice,
  SoundCloudSyncEvent,
  SoundCloudPlaylistImportResult,
  SoundCloudOEmbedResponse,
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

@Injectable({ providedIn: 'root' })
export class SoundCloudService {
  private static readonly savedItemsStateKey = 'soundcloud:saved-items';
  private static readonly pinnedItemsStateKey = 'soundcloud:pinned-items';
  private static readonly browserDeviceId = 'soundcloud-widget';
  private static readonly widgetIframeAllow = 'autoplay; encrypted-media';
  private static readonly defaultVolumePercent = 25;

  private widget: any = null;
  private widgetScriptPromise: Promise<void> | null = null;
  private currentWidgetUrl: string | null = null;
  private nativeAudioElement: HTMLAudioElement | null = null;
  private currentNativeAudioUrl: string | null = null;
  private nativeAudioTrack: SoundCloudSearchResult | null = null;
  private volumePercent = SoundCloudService.defaultVolumePercent;
  private currentPositionMs = 0;
  private currentDurationMs = 0;
  private lastContextUri: string | null = null;
  private localQueue: SoundCloudSearchResult[] = [];
  private queueIndex = -1;

  public isReady$ = new BehaviorSubject<boolean>(false);
  public currentTrack$ = new BehaviorSubject<any>(null);
  public isPaused$ = new BehaviorSubject<boolean>(true);
  public shuffleState$ = new BehaviorSubject<boolean>(false);
  public queue$ = new BehaviorSubject<any[]>([]);
  public isAuthorized$ = new BehaviorSubject<boolean>(true);
  public error$ = new BehaviorSubject<string | null>(null);
  public devices$ = new BehaviorSubject<SoundCloudDevice[]>([]);
  public volumePercent$ = new BehaviorSubject<number>(SoundCloudService.defaultVolumePercent);
  public playbackPositionMs$ = new BehaviorSubject<number>(0);
  public playbackDurationMs$ = new BehaviorSubject<number>(0);
  public activeDeviceId$ = new BehaviorSubject<string | null>(SoundCloudService.browserDeviceId);
  public savedItems$ = new BehaviorSubject<SoundCloudSearchResult[]>([]);
  public savedPlaylists$ = new BehaviorSubject<any[]>([]);
  public recentPlays$ = new BehaviorSubject<any[]>([]);
  public pinnedItems$ = new BehaviorSubject<any[]>([]);
  public syncAction$ = new Subject<SoundCloudSyncEvent>();

  public lastActionTime = 0;

  constructor(private sharedWindowState: SharedWindowStateService) {
    this.devices$.next([this.getBrowserDevice()]);
    this.loadSavedItems();
    this.loadPinned();
    this.setupSharedWindowState();
    void this.enrichSavedItemsMissingMetadata();
    void this.loadWidgetScript().catch(() => undefined);
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

    return items.filter(item => [
      item.name,
      item.artist,
      item.owner,
      item.type,
      item.uri
    ].some(value => String(value ?? '').toLowerCase().includes(normalizedQuery)));
  }

  async addSavedItemFromUrl(url: string, type?: 'track' | 'playlist'): Promise<SoundCloudSearchResult> {
    const item = this.createSavedItem(url, type);
    const current = this.savedItems$.value;
    const existing = current.find(saved => saved.uri === item.uri);
    if (existing) {
      if (!this.needsMetadataRefresh(existing)) {
        return existing;
      }

      return this.enrichSavedItem(existing).catch(() => existing);
    }

    this.setSavedItems([item, ...current]);
    return this.enrichSavedItem(item).catch(() => item);
  }

  getSavedItemFromUrl(url: string): SoundCloudSearchResult | undefined {
    return this.findSavedItem(url);
  }

  isUserPlaylistSourceUrl(url: string): boolean {
    const parts = this.getSoundCloudPathParts(url);
    if (!parts.length) return false;

    return parts.length === 1
      || (parts.length === 2 && ['sets', 'albums', 'tracks'].includes(parts[1].toLowerCase()));
  }

  async addUserPlaylistsFromUrl(url: string): Promise<SoundCloudPlaylistImportResult> {
    const playlists = await this.fetchUserPlaylistsFromUrl(url);
    const added: SoundCloudSearchResult[] = [];
    const duplicates: SoundCloudSearchResult[] = [];

    for (const playlist of playlists) {
      const existing = this.findSavedItem(playlist.uri);
      if (existing) {
        duplicates.push(existing);
        continue;
      }

      this.setSavedItems([playlist, ...this.savedItems$.value]);
      added.push(playlist);
    }

    return {
      added,
      duplicates,
      discoveredCount: playlists.length
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
      throw new Error('Invalid SoundCloud music list JSON.');
    }

    return this.importMusicList(data);
  }

  removeSavedItem(uri: string) {
    this.setSavedItems(this.savedItems$.value.filter(item => item.uri !== uri));
    if (this.isPinned(uri)) {
      this.togglePin({ uri });
    }
  }

  async refreshSavedThumbnails(): Promise<number> {
    const items = [...this.savedItems$.value];
    let refreshedCount = 0;

    for (const item of items) {
      const currentItem = this.findSavedItem(item.uri) ?? item;
      const refreshedItem = await this.enrichSavedItem(currentItem).catch(() => null);
      if (refreshedItem) {
        refreshedCount += 1;
      }
    }

    return refreshedCount;
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
    const current = this.pinnedItems$.value;
    const uri = item.uri || item.permalink_url;
    if (!uri) return;

    const isPinned = current.some(p => p.uri === uri);
    const updated = isPinned
      ? current.filter(p => p.uri !== uri)
      : [...current, this.toPinnedItem(item)];

    this.setPinnedItems(updated);
  }

  isPinned(uri: string): boolean {
    return this.pinnedItems$.value.some(p => p.uri === uri);
  }

  async play(
    uri?: string,
    positionMs: number = 0,
    skipSync: boolean = false,
    contextUri?: string,
    metadata?: Partial<SoundCloudSearchResult>
  ): Promise<any> {
    const resolvedContextUri = this.resolvePlayableUrl(contextUri);
    const targetUrl = resolvedContextUri
      ?? this.resolvePlayableUrl(uri)
      ?? this.resolvePlayableUrl(this.currentTrack$.value?.uri)
      ?? this.resolvePlayableUrl(this.currentWidgetUrl);
    if (!targetUrl) return null;

    if (!skipSync) {
      this.lastActionTime = Date.now();
    }

    const track = this.shouldUseNativeAudio(targetUrl)
      ? await this.playNativeAudio(targetUrl, positionMs, metadata)
      : await this.playWidgetAudio(targetUrl, positionMs);

    this.isPaused$.next(false);
    this.lastContextUri = resolvedContextUri ?? null;

    if (!skipSync) {
      this.syncAction$.next({
        command: 'play',
        data: this.createSyncPayload(track, positionMs, false, resolvedContextUri),
        source: 'manual'
      });
    }

    return track;
  }

  async addToQueue(uri: string): Promise<any> {
    const playableUrl = this.resolvePlayableUrl(uri);
    if (!playableUrl) return null;

    const item = this.findSavedItem(playableUrl) ?? this.createSavedItem(playableUrl);
    this.localQueue.push(item);
    await this.loadQueue();
    return item;
  }

  async clearCurrentPlayback(skipSync: boolean = true) {
    await this.pause(skipSync).catch(() => null);
    this.currentTrack$.next(null);
    this.updatePlaybackPosition(0);
    this.updatePlaybackDuration(0);
    this.lastContextUri = null;
  }

  async pause(skipSync: boolean = false) {
    if (!this.widget && !this.nativeAudioElement) return null;
    if (!skipSync) this.lastActionTime = Date.now();

    if (this.isCurrentNativeAudio()) {
      this.nativeAudioElement?.pause();
    } else {
      this.widget?.pause();
    }

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

  async seek(positionMs: number, skipSync: boolean = false) {
    if (!this.widget && !this.nativeAudioElement) return;
    if (!skipSync) this.lastActionTime = Date.now();

    const nextPositionMs = this.normalizePlaybackPosition(positionMs);
    if (this.isCurrentNativeAudio()) {
      this.seekNativeAudio(nextPositionMs);
    } else {
      this.widget?.seekTo(nextPositionMs);
    }
    this.updatePlaybackPosition(nextPositionMs);

    if (!skipSync) {
      const state = await this.getPlaybackState();
      this.syncAction$.next({
        command: 'seek',
        data: this.createSyncPayload(state?.track_window?.current_track, nextPositionMs, state?.paused ?? true, state?.context?.uri ?? null),
        source: 'manual'
      });
    }
  }

  async nextTrack(skipSync: boolean = false) {
    if (!skipSync) this.lastActionTime = Date.now();

    const nextQueueIndex = this.queueIndex + 1;
    if (nextQueueIndex < this.localQueue.length) {
      this.queueIndex = nextQueueIndex;
      const item = this.localQueue[this.queueIndex];
      await this.loadQueue();
      await this.play(item.uri, 0, true);
    } else if (!this.isCurrentNativeAudio() && this.widget) {
      this.widget.next();
      await this.delay(300);
      this.applyWidgetVolume();
      await this.syncCurrentSound();
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
      const item = this.localQueue[this.queueIndex];
      await this.loadQueue();
      await this.play(item.uri, 0, true);
    } else if (!this.isCurrentNativeAudio() && this.widget) {
      this.widget.prev();
      await this.delay(300);
      this.applyWidgetVolume();
      await this.syncCurrentSound();
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

  getVolumePercent(): number {
    return this.volumePercent;
  }

  async setVolume(v: number | string, skipSync: boolean = false) {
    const numericValue = Number(v);
    const ratio = Number.isFinite(numericValue) ? numericValue : this.volumePercent / 100;
    await this.setVolumePercent(ratio * 100, skipSync);
  }

  async setVolumePercent(v: number | string, skipSync: boolean = false) {
    this.volumePercent = this.normalizeVolumePercent(v);
    this.volumePercent$.next(this.volumePercent);
    this.devices$.next([this.getBrowserDevice()]);
    this.applyWidgetVolume();
    this.applyNativeAudioVolume();

    if (!skipSync) {
      this.lastActionTime = Date.now();
      const state = await this.getPlaybackState().catch(() => null);
      this.syncAction$.next({
        command: 'volume',
        data: this.createSyncPayload(
          state?.track_window?.current_track,
          state?.position || 0,
          state?.paused ?? this.isPaused$.value,
          state?.context?.uri ?? null
        ),
        source: 'manual'
      });
    }
  }

  async togglePlay(skipSync: boolean = false) {
    if (this.isPaused$.value) {
      await this.play(undefined, this.currentPositionMs, skipSync, this.lastContextUri ?? undefined);
      return;
    }

    await this.pause(skipSync);
  }

  async getPlaybackState() {
    const currentTrack = await this.syncCurrentSound().catch(() => this.currentTrack$.value);
    const position = this.isCurrentNativeAudio()
      ? this.getNativeAudioPositionMs()
      : await this.getWidgetValue<number>('getPosition').catch(() => this.currentPositionMs);
    const duration = this.isCurrentNativeAudio()
      ? this.getNativeAudioDurationMs()
      : await this.getWidgetValue<number>('getDuration').catch(() => currentTrack?.duration ?? this.currentDurationMs);
    this.updatePlaybackPosition(position ?? this.currentPositionMs);
    this.updatePlaybackDuration(duration ?? currentTrack?.duration ?? this.currentDurationMs);

    return {
      paused: this.isPaused$.value,
      position: position ?? this.currentPositionMs,
      duration: this.currentDurationMs,
      shuffle_state: this.shuffleState$.value,
      track_window: { current_track: currentTrack },
      context: { uri: this.lastContextUri }
    };
  }

  async getDevices(): Promise<SoundCloudDevice[]> {
    return [this.getBrowserDevice()];
  }

  async transferPlayback(deviceId: string, play: boolean = false) {
    this.activeDeviceId$.next(deviceId);
    if (play && this.isPaused$.value) {
      await this.togglePlay();
    }
  }

  private loadSavedItems() {
    const sharedItems = this.sharedWindowState.getSnapshot<SoundCloudSearchResult[]>(
      SoundCloudService.savedItemsStateKey,
      null
    );
    const storedItems = localStorage.getItem('soundcloud_saved_items');
    const items = sharedItems ?? JSON.parse(storedItems || '[]');
    this.applySavedItems(Array.isArray(items) ? items : []);
    if (!sharedItems && storedItems) {
      this.sharedWindowState.publish(SoundCloudService.savedItemsStateKey, items);
    }
  }

  private loadPinned() {
    const sharedPinned = this.sharedWindowState.getSnapshot<any[]>(SoundCloudService.pinnedItemsStateKey, null);
    const storedPinned = localStorage.getItem('soundcloud_pinned_items');
    const pinned = sharedPinned ?? JSON.parse(storedPinned || '[]');
    this.pinnedItems$.next(Array.isArray(pinned) ? pinned : []);
    if (!sharedPinned && storedPinned) {
      this.sharedWindowState.publish(SoundCloudService.pinnedItemsStateKey, pinned);
    }
  }

  private setupSharedWindowState() {
    this.sharedWindowState.observe<SoundCloudSearchResult[]>(
      SoundCloudService.savedItemsStateKey,
      this.savedItems$.value
    ).subscribe(items => {
      const nextItems = Array.isArray(items) ? items : [];
      if (JSON.stringify(this.savedItems$.value) === JSON.stringify(nextItems)) {
        return;
      }

      this.applySavedItems(nextItems);
      localStorage.setItem('soundcloud_saved_items', JSON.stringify(nextItems));
    });

    this.sharedWindowState.observe<any[]>(SoundCloudService.pinnedItemsStateKey, this.pinnedItems$.value)
      .subscribe(items => {
        const nextItems = items ?? [];
        if (JSON.stringify(this.pinnedItems$.value) === JSON.stringify(nextItems)) {
          return;
        }

        this.pinnedItems$.next(nextItems);
        localStorage.setItem('soundcloud_pinned_items', JSON.stringify(nextItems));
      });
  }

  private setSavedItems(items: SoundCloudSearchResult[]) {
    this.applySavedItems(items);
    localStorage.setItem('soundcloud_saved_items', JSON.stringify(items));
    this.sharedWindowState.publish(SoundCloudService.savedItemsStateKey, items);
  }

  private setPinnedItems(items: any[]) {
    this.pinnedItems$.next(items);
    localStorage.setItem('soundcloud_pinned_items', JSON.stringify(items));
    this.sharedWindowState.publish(SoundCloudService.pinnedItemsStateKey, items);
  }

  private applySavedItems(items: SoundCloudSearchResult[]) {
    this.savedItems$.next(items);
    this.savedPlaylists$.next(items.filter(item => item.type === 'playlist'));
    this.recentPlays$.next(items.filter(item => item.type === 'track').map(track => ({ track })));
  }

  private importMusicList(data: unknown): SoundCloudMusicListImportResult {
    const importedItems = this.uniqueSavedItemsByUri(
      this.getImportArray(data, 'savedItems', 'items', 'musicList')
        .map(item => this.normalizeImportedSavedItem(item))
        .filter((item): item is SoundCloudSearchResult => !!item)
    );

    if (!importedItems.length) {
      throw new Error('The SoundCloud music list does not contain any saved items.');
    }

    const existingUris = new Set(
      this.savedItems$.value.map(item => this.normalizeSoundCloudUrl(item.uri))
    );
    const addedItems: SoundCloudSearchResult[] = [];

    for (const item of importedItems) {
      const normalizedUri = this.normalizeSoundCloudUrl(item.uri);
      if (existingUris.has(normalizedUri)) {
        continue;
      }

      existingUris.add(normalizedUri);
      addedItems.push({ ...item, id: item.id || normalizedUri, uri: normalizedUri });
    }

    const mergedItems = addedItems.length
      ? [...addedItems, ...this.savedItems$.value]
      : this.savedItems$.value;
    if (addedItems.length) {
      this.setSavedItems(mergedItems);
    }

    const pinnedAddedCount = this.importPinnedItems(data, mergedItems);

    return {
      addedCount: addedItems.length,
      duplicateCount: importedItems.length - addedItems.length,
      pinnedAddedCount,
      totalSavedItems: mergedItems.length
    };
  }

  private importPinnedItems(data: unknown, savedItems: SoundCloudSearchResult[]): number {
    const importedPinnedItems = this.getImportArray(data, 'pinnedItems')
      .map(item => this.normalizeImportedPinnedItem(item, savedItems))
      .filter((item): item is any => !!item);

    if (!importedPinnedItems.length) {
      return 0;
    }

    const pinnedUris = new Set(
      this.pinnedItems$.value
        .map(item => this.getItemUri(item))
        .filter((uri): uri is string => !!uri)
        .map(uri => this.normalizeSoundCloudUrl(uri))
    );
    const addedPinnedItems: any[] = [];

    for (const pinnedItem of importedPinnedItems) {
      const normalizedUri = this.normalizeSoundCloudUrl(pinnedItem.uri);
      if (pinnedUris.has(normalizedUri)) {
        continue;
      }

      pinnedUris.add(normalizedUri);
      addedPinnedItems.push({ ...pinnedItem, uri: normalizedUri });
    }

    if (addedPinnedItems.length) {
      this.setPinnedItems([...this.pinnedItems$.value, ...addedPinnedItems]);
    }

    return addedPinnedItems.length;
  }

  private normalizeImportedSavedItem(item: unknown): SoundCloudSearchResult | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    const rawUri = this.getStringValue(record, 'uri')
      ?? this.getStringValue(record, 'permalink_url')
      ?? this.getStringValue(record, 'url');
    if (!rawUri) {
      return null;
    }

    const uri = this.normalizeSoundCloudUrl(rawUri);
    const rawType = this.getStringValue(record, 'type');
    const type = rawType === 'track' || rawType === 'playlist'
      ? rawType
      : this.inferItemType(uri);
    const fallbackItem = this.createSavedItem(uri, type);
    const image = this.getStringValue(record, 'image')
      ?? this.getFirstImageUrl(record, 'images')
      ?? this.getFirstImageUrl(record, 'album', 'images')
      ?? fallbackItem.image;
    const owner = this.getStringValue(record, 'owner')
      ?? this.getStringValue(record, 'artist')
      ?? this.getStringValue(record, 'publisher')
      ?? fallbackItem.owner;

    return this.mergeSavedItemMetadata(fallbackItem, {
      id: this.getStringValue(record, 'id') ?? uri,
      name: this.getStringValue(record, 'name') ?? fallbackItem.name,
      artist: type === 'track' ? owner : this.getStringValue(record, 'artist'),
      artistId: this.getStringValue(record, 'artistId'),
      owner,
      ownerId: this.getStringValue(record, 'ownerId'),
      publisher: type === 'track' ? owner : this.getStringValue(record, 'publisher'),
      image,
      duration: this.getNumberValue(record, 'duration')
    });
  }

  private normalizeImportedPinnedItem(item: unknown, savedItems: SoundCloudSearchResult[]): any | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    const rawUri = this.getStringValue(record, 'uri') ?? this.getStringValue(record, 'permalink_url');
    if (!rawUri) {
      return null;
    }

    const uri = this.normalizeSoundCloudUrl(rawUri);
    const savedItem = savedItems.find(saved => this.normalizeSoundCloudUrl(saved.uri) === uri);
    if (!savedItem) {
      return null;
    }

    return {
      uri,
      name: this.getStringValue(record, 'name') ?? savedItem.name,
      type: this.getStringValue(record, 'type') ?? savedItem.type,
      id: this.getStringValue(record, 'id') ?? savedItem.id ?? uri,
      image: this.getStringValue(record, 'image') ?? savedItem.image ?? this.getFallbackImage(savedItem.type),
      owner: this.getStringValue(record, 'owner') ?? savedItem.owner ?? savedItem.artist ?? 'Unknown'
    };
  }

  private getImportArray(data: unknown, ...keys: string[]): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }

    if (!data || typeof data !== 'object') {
      return [];
    }

    const record = data as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }

    return [];
  }

  private getStringValue(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private getNumberValue(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private getFirstImageUrl(record: Record<string, unknown>, key: string, nestedKey?: string): string | undefined {
    const source = record[key];
    const imageList = nestedKey && source && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>)[nestedKey]
      : source;

    if (!Array.isArray(imageList)) {
      return undefined;
    }

    const image = imageList.find(item => !!item && typeof item === 'object' && !Array.isArray(item)) as
      | Record<string, unknown>
      | undefined;

    return image ? this.getStringValue(image, 'url') : undefined;
  }

  private getItemUri(item: any): string | null {
    const uri = item?.uri || item?.permalink_url || item?.track?.uri || item?.track?.permalink_url;
    return typeof uri === 'string' && uri ? uri : null;
  }

  private async fetchUserPlaylistsFromUrl(url: string): Promise<SoundCloudSearchResult[]> {
    const profileUrl = this.normalizeUserProfileUrl(url);
    if (!profileUrl) {
      return [];
    }

    try {
      const apiPlaylists = await this.fetchUserPlaylistsFromApi(profileUrl);
      if (apiPlaylists.length) {
        return this.uniqueSavedItemsByUri(apiPlaylists);
      }
    } catch {
      // Fall through to the widget-backed resolver below; SoundCloud rotates public widget credentials.
    }

    const widgetPlaylistUrls = await this.fetchUserPlaylistUrlsFromWidget(profileUrl);

    try {
      const retriedApiPlaylists = await this.fetchUserPlaylistsFromApi(profileUrl);
      if (retriedApiPlaylists.length) {
        return this.uniqueSavedItemsByUri(retriedApiPlaylists);
      }
    } catch {
      // The widget URL fallback is still enough to save playable playlist links.
    }

    return this.uniqueSavedItemsByUri(
      widgetPlaylistUrls.map(playlistUrl => this.createSavedItem(playlistUrl, 'playlist'))
    );
  }

  private async fetchUserPlaylistsFromApi(profileUrl: string): Promise<SoundCloudSearchResult[]> {
    const endpoint = new URL('spotify/soundcloud/user-playlists', environment.apiURL);
    endpoint.searchParams.set('url', profileUrl);

    const response = await fetch(endpoint.toString(), {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`SoundCloud playlist proxy request failed: ${response.status}`);
    }

    const data = await response.json() as { playlists?: SoundCloudSearchResult[] };
    return Array.isArray(data.playlists) ? data.playlists : [];
  }

  private async fetchUserPlaylistUrlsFromWidget(profileUrl: string): Promise<string[]> {
    const candidateUrls = [`${profileUrl}/sets`];
    const playlistUrls: string[] = [];

    for (const candidateUrl of candidateUrls) {
      const sounds = await this.fetchWidgetSounds(candidateUrl).catch(() => []);
      for (const sound of sounds) {
        const playlistUrl = this.getPlaylistUrlFromWidgetItem(sound);
        if (playlistUrl) {
          playlistUrls.push(playlistUrl);
        }
      }
    }

    return Array.from(new Set(playlistUrls.map(item => this.normalizeSoundCloudUrl(item))));
  }

  private async fetchWidgetSounds(url: string): Promise<any[]> {
    await this.loadWidgetScript();

    const iframe = document.createElement('iframe');
    iframe.id = `soundcloud-list-widget-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    iframe.width = '1';
    iframe.height = '1';
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.opacity = '0';
    iframe.allow = SoundCloudService.widgetIframeAllow;
    iframe.src = this.getWidgetIframeSource(url, false);

    document.body.appendChild(iframe);
    const listWidget = window.SC.Widget(iframe);

    try {
      await this.waitForWidgetReady(listWidget);
      const sounds = await this.getWidgetValueFrom<any[]>(listWidget, 'getSounds');
      if (Array.isArray(sounds)) {
        return sounds;
      }

      const sound = await this.getWidgetValueFrom<any>(listWidget, 'getCurrentSound');
      return sound ? [sound] : [];
    } finally {
      iframe.remove();
    }
  }

  private getPlaylistUrlFromWidgetItem(item: any): string | null {
    const uri = item?.permalink_url || item?.uri || item?.url;
    if (typeof uri === 'string' && /\/sets\//i.test(uri)) {
      return uri;
    }

    const playlistUri = item?.playlist?.permalink_url || item?.set?.permalink_url;
    if (typeof playlistUri === 'string' && /\/sets\//i.test(playlistUri)) {
      return playlistUri;
    }

    return null;
  }

  private async enrichSavedItemsMissingMetadata() {
    for (const item of this.savedItems$.value) {
      if (this.needsMetadataRefresh(item)) {
        await this.enrichSavedItem(item).catch(() => undefined);
      }
    }
  }

  private async enrichSavedItem(item: SoundCloudSearchResult): Promise<SoundCloudSearchResult> {
    const type = item.type === 'playlist' ? 'playlist' : 'track';
    const [oEmbedResult, widgetResult] = await Promise.allSettled([
      this.fetchOEmbedMetadata(item.uri, type),
      this.fetchWidgetMetadata(item.uri, type)
    ]);
    const oEmbedMetadata = oEmbedResult.status === 'fulfilled' ? oEmbedResult.value : null;
    const widgetMetadata = widgetResult.status === 'fulfilled' ? widgetResult.value : null;
    const metadata = type === 'playlist'
      ? this.mergePartialMetadata(widgetMetadata, oEmbedMetadata)
      : this.mergePartialMetadata(oEmbedMetadata, widgetMetadata);

    if (!metadata) {
      return item;
    }

    const currentItem = this.findSavedItem(item.uri) ?? item;
    const enrichedItem = this.mergeSavedItemMetadata(currentItem, metadata);
    this.replaceSavedItem(enrichedItem);
    return enrichedItem;
  }

  private async fetchOEmbedMetadata(
    uri: string,
    type: 'track' | 'playlist'
  ): Promise<Partial<SoundCloudSearchResult> | null> {
    const endpoint = new URL('https://soundcloud.com/oembed');
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('url', uri);

    const response = await fetch(endpoint.toString(), {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`SoundCloud oEmbed request failed: ${response.status}`);
    }

    const data = await response.json() as SoundCloudOEmbedResponse;
    const titleParts = this.parseOEmbedTitle(data.title, data.author_name);
    const image = this.normalizeImageUrl(data.thumbnail_url);

    return {
      name: titleParts.name || undefined,
      artist: type === 'track' ? titleParts.owner || undefined : undefined,
      owner: titleParts.owner || undefined,
      publisher: type === 'track' ? titleParts.owner || undefined : undefined,
      image: image || undefined,
      album: image ? { images: [{ url: image }] } : undefined,
      artists: titleParts.owner ? [{ name: titleParts.owner }] : undefined,
      images: image ? [{ url: image }] : undefined
    };
  }

  private async fetchWidgetMetadata(
    uri: string,
    type: 'track' | 'playlist'
  ): Promise<Partial<SoundCloudSearchResult> | null> {
    await this.loadWidgetScript();

    const iframe = document.createElement('iframe');
    iframe.id = `soundcloud-metadata-widget-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    iframe.width = '1';
    iframe.height = '1';
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.opacity = '0';
    iframe.allow = SoundCloudService.widgetIframeAllow;
    iframe.src = this.getWidgetIframeSource(uri, false);

    document.body.appendChild(iframe);
    const metadataWidget = window.SC.Widget(iframe);

    try {
      await this.waitForWidgetReady(metadataWidget);
      const sound = await this.getWidgetValueFrom<any>(metadataWidget, 'getCurrentSound');
      const sounds = type === 'playlist'
        ? await this.getWidgetValueFrom<any[]>(metadataWidget, 'getSounds')
        : null;
      const firstSound = Array.isArray(sounds) ? sounds.find(item => !!item) : null;
      const source = sound || firstSound;

      if (!source) {
        return null;
      }

      return this.createMetadataFromWidgetSound(source, type);
    } finally {
      iframe.remove();
    }
  }

  private mergePartialMetadata(
    ...metadataItems: Array<Partial<SoundCloudSearchResult> | null>
  ): Partial<SoundCloudSearchResult> | null {
    const merged = metadataItems.reduce<Partial<SoundCloudSearchResult>>((acc, metadata) => {
      if (!metadata) {
        return acc;
      }

      Object.entries(metadata).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          (acc as any)[key] = value;
        }
      });

      return acc;
    }, {});

    return Object.keys(merged).length ? merged : null;
  }

  private mergeSavedItemMetadata(
    item: SoundCloudSearchResult,
    metadata: Partial<SoundCloudSearchResult>
  ): SoundCloudSearchResult {
    const image = metadata.image || item.image || this.getFallbackImage(item.type);
    const owner = metadata.owner || item.owner || metadata.artist || item.artist || '';
    const name = metadata.name || item.name;
    const artist = item.type === 'track' ? owner : item.artist;

    return {
      ...item,
      ...metadata,
      name,
      type: item.type,
      image,
      artist,
      owner,
      publisher: item.type === 'track' ? owner : item.publisher,
      album: { images: [{ url: image }] },
      artists: owner ? [{ id: item.artistId || item.ownerId, name: owner }] : item.artists ?? [],
      images: [{ url: image }]
    };
  }

  private replaceSavedItem(updatedItem: SoundCloudSearchResult) {
    const normalizedUri = this.normalizeSoundCloudUrl(updatedItem.uri);
    const current = this.savedItems$.value;
    const index = current.findIndex(item => item.uri === normalizedUri || item.id === normalizedUri);
    const next = [...current];

    if (index >= 0) {
      next[index] = updatedItem;
    } else {
      next.unshift(updatedItem);
    }

    if (JSON.stringify(current) === JSON.stringify(next)) {
      return;
    }

    this.setSavedItems(next);
    this.updatePinnedMetadata(updatedItem);
  }

  private updatePinnedMetadata(item: SoundCloudSearchResult) {
    const normalizedUri = this.normalizeSoundCloudUrl(item.uri);
    let didChange = false;
    const nextPinnedItems = this.pinnedItems$.value.map(pinnedItem => {
      const pinnedUri = this.normalizeSoundCloudUrl(pinnedItem.uri || pinnedItem.permalink_url || '');
      if (pinnedUri !== normalizedUri) {
        return pinnedItem;
      }

      didChange = true;
      return {
        ...pinnedItem,
        id: item.id || pinnedItem.id,
        name: item.name || pinnedItem.name,
        type: item.type || pinnedItem.type,
        image: item.image || pinnedItem.image,
        owner: item.owner || item.artist || pinnedItem.owner
      };
    });

    if (!didChange) {
      return;
    }

    this.pinnedItems$.next(nextPinnedItems);
    localStorage.setItem('soundcloud_pinned_items', JSON.stringify(nextPinnedItems));
    this.sharedWindowState.publish(SoundCloudService.pinnedItemsStateKey, nextPinnedItems);
  }

  private needsMetadataRefresh(item: SoundCloudSearchResult): boolean {
    return this.isPlaceholderImage(item.image)
      || this.isPlaceholderImage(item.images?.[0]?.url)
      || this.isPlaceholderImage(item.album?.images?.[0]?.url)
      || !item.owner;
  }

  private isPlaceholderImage(image?: string | null): boolean {
    return !image
      || image.includes('spotify-placeholder')
      || image.includes('playlist-placeholder');
  }

  private resolvePlayableUrl(uri?: string | null): string | null {
    if (!uri) return null;
    if (this.isWidgetPlayableUrl(uri)) {
      return this.isSoundCloudUrl(uri)
        ? this.normalizeSoundCloudUrl(uri)
        : this.normalizeExternalUrl(uri);
    }
    return this.findSavedItem(uri)?.uri ?? null;
  }

  private async playWidgetAudio(url: string, positionMs: number): Promise<any> {
    this.pauseNativeAudioForSourceSwitch();
    await this.loadWidgetSource(url, true);
    if (positionMs > 0) {
      await this.seek(positionMs, true);
    }

    return this.syncCurrentSound(url);
  }

  private async playNativeAudio(
    url: string,
    positionMs: number,
    metadata?: Partial<SoundCloudSearchResult>
  ): Promise<SoundCloudSearchResult> {
    const audio = this.ensureNativeAudioElement();
    this.pauseWidgetForSourceSwitch();

    if (this.currentNativeAudioUrl !== url) {
      audio.pause();
      audio.src = url;
      audio.preload = 'auto';
      audio.load();
      this.currentNativeAudioUrl = url;
      this.currentWidgetUrl = url;
      this.updatePlaybackPosition(0);
      this.updatePlaybackDuration(0);
    }

    this.nativeAudioTrack = this.createNativeAudioTrack(url, metadata);
    this.currentTrack$.next(this.nativeAudioTrack);
    this.applyNativeAudioVolume();

    if (positionMs > 0) {
      this.seekNativeAudioWhenReady(positionMs);
    }

    await audio.play();
    this.isPaused$.next(false);
    return this.nativeAudioTrack;
  }

  private ensureNativeAudioElement(): HTMLAudioElement {
    if (this.nativeAudioElement) {
      return this.nativeAudioElement;
    }

    const audio = document.createElement('audio');
    audio.id = 'soundcloud-native-audio';
    audio.preload = 'auto';
    audio.style.position = 'fixed';
    audio.style.left = '-9999px';
    audio.style.top = '-9999px';
    audio.style.width = '1px';
    audio.style.height = '1px';

    audio.addEventListener('loadedmetadata', () => {
      this.updatePlaybackDuration(this.getNativeAudioDurationMs());
    });
    audio.addEventListener('timeupdate', () => {
      this.updatePlaybackPosition(this.getNativeAudioPositionMs());
    });
    audio.addEventListener('play', () => {
      this.isPaused$.next(false);
      this.error$.next(null);
    });
    audio.addEventListener('pause', () => {
      this.isPaused$.next(true);
    });
    audio.addEventListener('ended', () => {
      this.isPaused$.next(true);
      this.updatePlaybackPosition(this.currentDurationMs);
      void this.nextTrack(true);
    });
    audio.addEventListener('error', () => {
      this.isPaused$.next(true);
      this.error$.next('Unable to play that audio file.');
    });

    document.body.appendChild(audio);
    this.nativeAudioElement = audio;
    this.applyNativeAudioVolume();
    return audio;
  }

  private pauseNativeAudioForSourceSwitch() {
    if (this.nativeAudioElement) {
      this.nativeAudioElement.pause();
    }
    this.currentNativeAudioUrl = null;
    this.nativeAudioTrack = null;
  }

  private pauseWidgetForSourceSwitch() {
    if (this.widget && !this.isCurrentNativeAudio()) {
      this.widget.pause();
    }
  }

  private isCurrentNativeAudio(): boolean {
    return !!this.currentNativeAudioUrl && this.currentWidgetUrl === this.currentNativeAudioUrl;
  }

  private seekNativeAudio(positionMs: number) {
    const audio = this.nativeAudioElement;
    if (!audio) return;

    try {
      audio.currentTime = positionMs / 1000;
      this.updatePlaybackPosition(positionMs);
    } catch {
      // Some browsers reject seeking before metadata is ready.
    }
  }

  private seekNativeAudioWhenReady(positionMs: number) {
    const audio = this.nativeAudioElement;
    if (!audio) return;

    if (audio.readyState >= 1) {
      this.seekNativeAudio(positionMs);
      return;
    }

    audio.addEventListener('loadedmetadata', () => this.seekNativeAudio(positionMs), { once: true });
  }

  private getNativeAudioPositionMs(): number {
    const position = this.nativeAudioElement?.currentTime ?? NaN;
    return Number.isFinite(position) ? Math.max(0, Math.round(position * 1000)) : this.currentPositionMs;
  }

  private getNativeAudioDurationMs(): number {
    const duration = this.nativeAudioElement?.duration ?? NaN;
    return Number.isFinite(duration) ? Math.max(0, Math.round(duration * 1000)) : this.currentDurationMs;
  }

  private async loadWidgetScript(): Promise<void> {
    if (window.SC?.Widget) {
      this.isReady$.next(true);
      return;
    }

    if (this.widgetScriptPromise) {
      return this.widgetScriptPromise;
    }

    this.widgetScriptPromise = new Promise((resolve, reject) => {
      const existingScript = document.getElementById('soundcloud-widget-script') as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener('load', () => {
          this.isReady$.next(true);
          resolve();
        }, { once: true });
        existingScript.addEventListener('error', () => reject(new Error('Failed to load SoundCloud widget SDK')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.id = 'soundcloud-widget-script';
      script.src = 'https://w.soundcloud.com/player/api.js';
      script.async = true;
      script.onload = () => {
        this.isReady$.next(true);
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load SoundCloud widget SDK'));
      document.body.appendChild(script);
    });

    return this.widgetScriptPromise;
  }

  private async ensureWidget(initialUrl: string): Promise<any> {
    await this.loadWidgetScript();

    if (this.widget) {
      return this.widget;
    }

    const iframe = document.createElement('iframe');
    iframe.id = 'soundcloud-hidden-widget';
    iframe.allow = SoundCloudService.widgetIframeAllow;
    iframe.width = '1';
    iframe.height = '1';
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.opacity = '0';
    iframe.src = this.getWidgetIframeSource(initialUrl, false);

    document.body.appendChild(iframe);
    this.widget = window.SC.Widget(iframe);
    this.bindWidgetEvents();
    return this.widget;
  }

  private async loadWidgetSource(url: string, autoPlay: boolean) {
    const widget = await this.ensureWidget(url);
    if (this.currentWidgetUrl === url) {
      if (autoPlay) {
        widget.play();
      }
      this.applyWidgetVolume();
      return;
    }

    await new Promise<void>(resolve => {
      widget.load(url, {
        auto_play: autoPlay,
        callback: () => {
          this.applyWidgetVolume();
          resolve();
        }
      });
      setTimeout(resolve, 1500);
    });
    this.currentWidgetUrl = url;
    this.applyWidgetVolume();
    this.updatePlaybackPosition(0);
  }

  private getWidgetIframeSource(url: string, autoPlay: boolean): string {
    return `https://w.soundcloud.com/player/?${new URLSearchParams({
      url,
      auto_play: String(autoPlay),
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'true',
      show_reposts: 'false',
      visual: 'false'
    }).toString()}`;
  }

  private bindWidgetEvents() {
    const events = window.SC?.Widget?.Events;
    if (!this.widget || !events) return;

    this.widget.bind(events.READY, () => {
      this.isReady$.next(true);
      void this.syncCurrentSound();
      this.applyWidgetVolume();
    });
    this.widget.bind(events.PLAY, () => {
      this.isPaused$.next(false);
      this.applyWidgetVolume();
      void this.syncCurrentSound();
    });
    this.widget.bind(events.PAUSE, () => {
      this.isPaused$.next(true);
    });
    this.widget.bind(events.PLAY_PROGRESS, (progress: any) => {
      this.updatePlaybackPosition(progress?.currentPosition);
    });
    this.widget.bind(events.FINISH, () => {
      this.isPaused$.next(true);
      void this.nextTrack(true);
    });
  }

  private async syncCurrentSound(fallbackUrl?: string | null): Promise<any> {
    if (this.isCurrentNativeAudio()) {
      const track = this.nativeAudioTrack ?? this.createNativeAudioTrack(
        this.currentNativeAudioUrl || fallbackUrl || this.currentWidgetUrl || ''
      );
      this.nativeAudioTrack = {
        ...track,
        duration: this.getNativeAudioDurationMs() || track.duration
      };
      this.currentTrack$.next(this.nativeAudioTrack);
      return this.nativeAudioTrack;
    }

    if (!this.widget) {
      return this.currentTrack$.value;
    }

    const sound = await this.getWidgetValue<any>('getCurrentSound');
    if (!sound) {
      return this.currentTrack$.value;
    }

    const track = this.normalizeTrack({
      ...sound,
      permalink_url: this.getPlayableSoundUrl(sound.permalink_url, fallbackUrl, this.currentWidgetUrl)
        ?? sound.permalink_url
    });
    this.currentTrack$.next(track);
    this.updatePlaybackDuration(track.duration);
    this.updateSavedMetadata(track);
    return track;
  }

  private getWidgetValue<T>(methodName: string): Promise<T | null> {
    return this.getWidgetValueFrom<T>(this.widget, methodName);
  }

  private getWidgetValueFrom<T>(widget: any, methodName: string): Promise<T | null> {
    return new Promise(resolve => {
      if (!widget || typeof widget[methodName] !== 'function') {
        resolve(null);
        return;
      }

      widget[methodName]((value: T) => resolve(value));
    });
  }

  private waitForWidgetReady(widget: any): Promise<void> {
    return new Promise(resolve => {
      const events = window.SC?.Widget?.Events;
      let resolved = false;
      const finish = () => {
        if (resolved) return;

        resolved = true;
        resolve();
      };

      if (events?.READY && typeof widget?.bind === 'function') {
        widget.bind(events.READY, finish);
      }

      setTimeout(finish, 2500);
    });
  }

  private createSyncPayload(track: any, position: number, paused: boolean, contextUri: string | null) {
    const playableUri = this.getPlayableSoundUrl(
      track?.uri,
      track?.permalink_url,
      track?.url,
      this.currentWidgetUrl
    );
    const playableContextUri = this.getPlayableSoundUrl(contextUri);
    const uri = playableUri ?? playableContextUri ?? this.currentWidgetUrl;

    return {
      uri,
      name: track?.name ?? track?.title,
      artist: this.getTrackArtist(track),
      image: this.getTrackImage(track),
      duration: track?.duration ?? this.currentDurationMs,
      position,
      paused,
      playing: !paused,
      contextUri: playableContextUri,
      shuffle: this.shuffleState$.value,
      volumePercent: this.volumePercent
    };
  }

  private getBrowserDevice(): SoundCloudDevice {
    return {
      id: SoundCloudService.browserDeviceId,
      is_active: true,
      is_private_session: false,
      is_restricted: false,
      name: 'SoundCloud Web Player',
      type: 'Computer',
      volume_percent: this.volumePercent
    };
  }

  private applyWidgetVolume() {
    const widget = this.widget;
    if (!widget || typeof widget.setVolume !== 'function') {
      return;
    }

    widget.setVolume(this.volumePercent);
    setTimeout(() => {
      if (this.widget === widget) {
        widget.setVolume(this.volumePercent);
      }
    }, 250);
  }

  private applyNativeAudioVolume() {
    if (!this.nativeAudioElement) {
      return;
    }

    this.nativeAudioElement.volume = this.volumePercent / 100;
  }

  private normalizeVolumePercent(value: number | string): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.volumePercent;
    }

    return Math.max(0, Math.min(100, Math.round(numericValue)));
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

    if (durationMs > 0 && this.currentPositionMs > durationMs) {
      this.updatePlaybackPosition(durationMs);
    }
  }

  private normalizePlaybackPosition(value: number | string | null | undefined): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.currentPositionMs;
    }

    const roundedValue = Math.max(0, Math.round(numericValue));
    return this.currentDurationMs > 0
      ? Math.min(this.currentDurationMs, roundedValue)
      : roundedValue;
  }

  private createSavedItem(url: string, type?: 'track' | 'playlist'): SoundCloudSearchResult {
    const uri = this.normalizeSoundCloudUrl(url);
    const inferredType = type ?? this.inferItemType(uri);
    const { owner, title } = this.getNamesFromUrl(uri, inferredType);
    const image = this.getFallbackImage(inferredType);

    return {
      id: uri,
      name: title,
      uri,
      type: inferredType,
      image,
      artist: inferredType === 'track' ? owner : undefined,
      owner,
      album: { images: [{ url: image }] },
      artists: owner ? [{ name: owner }] : [],
      images: [{ url: image }]
    };
  }

  private createNativeAudioTrack(
    url: string,
    metadata: Partial<SoundCloudSearchResult> = {}
  ): SoundCloudSearchResult {
    const uri = this.normalizeExternalUrl(metadata.uri || url);
    const savedItem = this.findSavedItem(uri);
    const image = metadata.image || savedItem?.image || 'assets/spotify-placeholder.png';
    const artist = metadata.artist || metadata.owner || savedItem?.artist || savedItem?.owner || 'Broadcast audio';
    const name = metadata.name || savedItem?.name || this.getFileNameFromUrl(uri) || 'Broadcast audio';

    return {
      id: metadata.id || savedItem?.id || uri,
      name,
      uri,
      type: 'track',
      image,
      artist,
      owner: artist,
      album: { images: [{ url: image }] },
      artists: artist ? [{ name: artist }] : [],
      images: [{ url: image }],
      duration: metadata.duration ?? savedItem?.duration ?? this.getNativeAudioDurationMs()
    };
  }

  private normalizeTrack(item: any): SoundCloudSearchResult {
    const uri = this.getPlayableSoundUrl(
      item?.permalink_url,
      item?.url,
      item?.uri,
      this.currentWidgetUrl
    ) ?? this.normalizeSoundCloudUrl(item?.permalink_url || item?.url || item?.uri || this.currentWidgetUrl || '');
    const image = this.normalizeImageUrl(
      item?.artwork_url || item?.user?.avatar_url || item?.image || this.findSavedItem(uri)?.image
    ) || 'assets/spotify-placeholder.png';
    const artist = item?.user?.username || item?.artist || item?.publisher || this.findSavedItem(uri)?.owner || '';
    const artistId = item?.user?.id ?? item?.user_id ?? item?.artistId;

    return {
      id: String(item?.id ?? uri),
      name: item?.title || item?.name || this.findSavedItem(uri)?.name || 'Untitled track',
      uri,
      type: 'track',
      image,
      artist,
      artistId: artistId ? String(artistId) : undefined,
      owner: artist,
      ownerId: artistId ? String(artistId) : undefined,
      publisher: artist,
      album: { images: [{ url: image }] },
      artists: artist ? [{ id: artistId ? String(artistId) : undefined, name: artist }] : [],
      images: [{ url: image }],
      duration: item?.duration
    };
  }

  private toPinnedItem(item: any): any {
    const uri = item.uri || item.permalink_url;
    const savedItem = this.findSavedItem(uri);
    return {
      uri,
      name: item.name || item.title || item.display_name || savedItem?.name || 'SoundCloud item',
      type: item.type || item.kind || savedItem?.type || 'track',
      id: item.id || savedItem?.id || uri,
      image: this.normalizeImageUrl(item.images?.[0]?.url || item.image || item.artwork_url || item.avatar_url || savedItem?.image)
        || 'assets/spotify-placeholder.png',
      owner: item.owner?.display_name || item.artist || item.owner || item.user?.username || savedItem?.owner || 'Unknown'
    };
  }

  private uniqueSavedItemsByUri(items: SoundCloudSearchResult[]): SoundCloudSearchResult[] {
    const seenUris = new Set<string>();
    return items.filter(item => {
      const normalizedUri = this.normalizeSoundCloudUrl(item.uri);
      if (seenUris.has(normalizedUri)) {
        return false;
      }

      seenUris.add(normalizedUri);
      return true;
    });
  }

  private findSavedItem(uri: string): SoundCloudSearchResult | undefined {
    const normalizedUri = this.normalizeSoundCloudUrl(uri);
    return this.savedItems$.value.find(item => item.uri === normalizedUri || item.id === normalizedUri);
  }

  private updateSavedMetadata(track: SoundCloudSearchResult) {
    const current = this.savedItems$.value;
    const index = current.findIndex(item => item.uri === track.uri);
    if (index < 0) return;

    const next = [...current];
    const updatedTrack = {
      ...next[index],
      ...track,
      type: next[index].type
    };
    next[index] = updatedTrack;
    this.replaceSavedItem(updatedTrack);
  }

  private normalizeSoundCloudUrl(value: string): string {
    const trimmedValue = value.trim();
    const absoluteValue = /^(www\.)?soundcloud\.com\//i.test(trimmedValue)
      ? `https://${trimmedValue}`
      : trimmedValue;

    if (!/^https?:\/\//i.test(absoluteValue)) {
      return absoluteValue;
    }

    try {
      const url = new URL(absoluteValue);
      const secretToken = url.searchParams.get('secret_token');
      url.hash = '';
      url.search = '';
      if (secretToken) {
        url.searchParams.set('secret_token', secretToken);
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      return absoluteValue;
    }
  }

  private normalizeExternalUrl(value: string): string {
    const trimmedValue = value.trim();
    if (!/^https?:\/\//i.test(trimmedValue)) {
      return trimmedValue;
    }

    try {
      return new URL(trimmedValue).toString();
    } catch {
      return trimmedValue;
    }
  }

  private getPlayableSoundUrl(...candidates: Array<string | null | undefined>): string | null {
    for (const candidate of candidates) {
      const playableUrl = this.resolvePlayableUrl(candidate);
      if (playableUrl) {
        return playableUrl;
      }
    }

    return null;
  }

  private isWidgetPlayableUrl(value: string): boolean {
    return /^https?:\/\//i.test(value.trim());
  }

  private shouldUseNativeAudio(url: string): boolean {
    return !this.isSoundCloudUrl(url);
  }

  private isSoundCloudUrl(value: string): boolean {
    try {
      const hostname = new URL(this.normalizeExternalUrl(value)).hostname.toLowerCase();
      return hostname === 'soundcloud.com'
        || hostname.endsWith('.soundcloud.com')
        || hostname === 'snd.sc'
        || hostname.endsWith('.snd.sc');
    } catch {
      return false;
    }
  }

  private getFileNameFromUrl(value: string): string {
    try {
      const pathname = new URL(value).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(lastSegment).replace(/\.[a-z0-9]+$/i, '').trim();
    } catch {
      const lastSegment = value.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(lastSegment.split('?')[0] || '').replace(/\.[a-z0-9]+$/i, '').trim();
    }
  }

  private normalizeUserProfileUrl(value: string): string | null {
    try {
      const url = new URL(this.normalizeSoundCloudUrl(value));
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts.length) return null;

      url.pathname = `/${parts[0]}`;
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  private getSoundCloudPathParts(value: string): string[] {
    try {
      const url = new URL(this.normalizeSoundCloudUrl(value));
      if (!/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
        return [];
      }

      return url.pathname.split('/').filter(Boolean);
    } catch {
      return [];
    }
  }

  private inferItemType(url: string): 'track' | 'playlist' {
    return /\/sets\//i.test(url) ? 'playlist' : 'track';
  }

  private getFallbackImage(type: SoundCloudSearchResult['type']): string {
    return type === 'playlist' ? 'assets/playlist-placeholder.png' : 'assets/spotify-placeholder.png';
  }

  private parseOEmbedTitle(title?: string, authorName?: string): { name: string; owner: string } {
    let name = (title || '').trim();
    let owner = (authorName || '').trim();

    if (name && owner && name.toLowerCase().endsWith(` by ${owner}`.toLowerCase())) {
      name = name.slice(0, -(owner.length + 4)).trim();
    }

    if (name && !owner) {
      const titleMatch = name.match(/^(.*?)\s+by\s+(.+)$/i);
      if (titleMatch) {
        name = titleMatch[1].trim();
        owner = titleMatch[2].trim();
      }
    }

    return { name, owner };
  }

  private createMetadataFromWidgetSound(
    sound: any,
    type: 'track' | 'playlist'
  ): Partial<SoundCloudSearchResult> | null {
    const image = this.normalizeImageUrl(sound?.artwork_url || sound?.user?.avatar_url || sound?.image);
    const owner = sound?.user?.username || sound?.artist || sound?.publisher || '';
    const name = type === 'track'
      ? sound?.title || sound?.name || ''
      : '';

    if (!image && !owner && !name) {
      return null;
    }

    return {
      name: name || undefined,
      artist: type === 'track' ? owner || undefined : undefined,
      owner: owner || undefined,
      publisher: type === 'track' ? owner || undefined : undefined,
      image: image || undefined,
      album: image ? { images: [{ url: image }] } : undefined,
      artists: owner ? [{ id: sound?.user?.id ? String(sound.user.id) : undefined, name: owner }] : undefined,
      images: image ? [{ url: image }] : undefined,
      duration: sound?.duration
    };
  }

  private normalizeImageUrl(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value);
      if (url.protocol === 'http:') {
        url.protocol = 'https:';
      }

      return url.toString()
        .replace('-large.', '-t500x500.')
        .replace('-t300x300.', '-t500x500.')
        .replace('-t200x200.', '-t500x500.');
    } catch {
      return value
        .replace('-large.', '-t500x500.')
        .replace('-t300x300.', '-t500x500.')
        .replace('-t200x200.', '-t500x500.');
    }
  }

  private getNamesFromUrl(url: string, type: 'track' | 'playlist'): { owner: string; title: string } {
    try {
      const parsedUrl = new URL(url);
      const parts = parsedUrl.pathname.split('/').filter(Boolean);
      const setIndex = parts.findIndex(part => part.toLowerCase() === 'sets');
      const ownerSlug = parts[0] ?? '';
      const titleSlug = type === 'playlist' && setIndex >= 0
        ? parts[setIndex + 1] ?? ''
        : parts[parts.length - 1] ?? '';

      return {
        owner: this.unslug(ownerSlug) || 'SoundCloud',
        title: this.unslug(titleSlug) || (type === 'playlist' ? 'SoundCloud playlist' : 'SoundCloud track')
      };
    } catch {
      return {
        owner: 'SoundCloud',
        title: type === 'playlist' ? 'SoundCloud playlist' : 'SoundCloud track'
      };
    }
  }

  private unslug(value: string): string {
    return decodeURIComponent(value)
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, character => character.toUpperCase());
  }

  private getTrackArtist(track: any): string {
    if (!track) return '';
    if (track.artist) return track.artist;
    if (track.user?.username) return track.user.username;
    if (Array.isArray(track.artists)) {
      return track.artists.map((artist: any) => artist?.name).filter(Boolean).join(', ');
    }
    return '';
  }

  private getTrackImage(track: any): string {
    return this.normalizeImageUrl(track?.image
      ?? track?.artwork_url
      ?? track?.album?.images?.[0]?.url
      ?? track?.images?.[0]?.url
      ?? '') ?? '';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, interval, Subscription, of, Subject } from 'rxjs';
import { startWith, switchMap, catchError } from 'rxjs/operators';

import {environment} from '../../../../environments/environment';

declare global {
  interface Window { onSpotifyWebPlaybackSDKReady: () => void; Spotify: any; }
}

export interface SpotifySearchResult {
  id: string;
  name: string;
  uri: string;
  type: 'track' | 'playlist' | 'album' | 'artist' | 'show' | 'episode' | 'audiobook' | 'user';
  image: string;
  artist?: string;
  artistId?: string;
  owner?: string;
  ownerId?: string;
  publisher?: string;
}

export interface SpotifyDevice {
  id: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number;
}

@Injectable({ providedIn: 'root' })
export class SpotifyService {
  private player: any;
  private sdkDeviceId: string | null = null;
  private accessToken: string | null = null;
  private pollingSub: Subscription | null = null;

  public isReady$ = new BehaviorSubject<boolean>(false);
  public currentTrack$ = new BehaviorSubject<any>(null);
  public isPaused$ = new BehaviorSubject<boolean>(true);
  public shuffleState$ = new BehaviorSubject<boolean>(false);
  public queue$ = new BehaviorSubject<any[]>([]);
  public isAuthorized$ = new BehaviorSubject<boolean>(false);
  public error$ = new BehaviorSubject<string | null>(null);
  public devices$ = new BehaviorSubject<SpotifyDevice[]>([]);
  public activeDeviceId$ = new BehaviorSubject<string | null>(null);
  public savedPlaylists$ = new BehaviorSubject<any[]>([]);
  public recentPlays$ = new BehaviorSubject<any[]>([]);
  public pinnedItems$ = new BehaviorSubject<any[]>([]);

  // Event emitted when local user takes an action that should be synced
  public syncAction$ = new Subject<{ command: string, data: any }>();

  // Track the last state we synced to avoid loops and detect external changes
  private lastSyncedUri: string | null = null;
  private lastSyncedPaused: boolean | null = null;
  private lastSyncedPosition: number = 0;
  private lastCheckTime: number = 0;
  private isFirstPoll: boolean = true;

  private readonly API_BASE = 'https://api.spotify.com/v1';
  // Use the VPS IP for the backend API
  private readonly BACKEND_API = `${environment.apiURL}`;

  constructor(private http: HttpClient) {
    this.accessToken = localStorage.getItem('spotify_access_token');
    this.loadPinned();
    if (this.accessToken) {
      this.isAuthorized$.next(true);
      this.initSDK();
      this.startPolling();
      this.loadUserData();
    }
  }

  setTokens(access: string, refresh: string) {
    this.accessToken = access;
    localStorage.setItem('spotify_access_token', access);
    localStorage.setItem('spotify_refresh_token', refresh);
    this.isAuthorized$.next(true);
    this.error$.next(null);
    this.initSDK();
    this.startPolling();
    this.loadUserData();
  }

  private loadUserData() {
    this.loadSavedPlaylists();
    this.loadRecentPlays();
    this.loadQueue();
  }

  logout() {
    this.stopPolling();
    this.killPlayer();
    this.accessToken = null;
    localStorage.removeItem('spotify_access_token');
    localStorage.removeItem('spotify_refresh_token');
    this.isAuthorized$.next(false);
    this.isReady$.next(false);
    this.error$.next(null);
    this.devices$.next([]);
    this.activeDeviceId$.next(null);
    this.savedPlaylists$.next([]);
    this.recentPlays$.next([]);
    this.queue$.next([]);
  }

  private startPolling() {
    this.stopPolling();
    this.pollingSub = interval(5000)
      .pipe(
        startWith(0),
        switchMap(() => this.getPlaybackState()),
        catchError(() => of(null))
      )
      .subscribe(state => {
        if (state) {
          this.checkAndEmitSync(state);
          this.isPaused$.next(state.paused);
          this.shuffleState$.next(state.shuffle_state);
          this.currentTrack$.next(state.track_window?.current_track);
        }
        this.getDevices().then(devices => {
          this.devices$.next(devices);
          const active = devices.find(d => d.is_active);
          if (active) {
            this.activeDeviceId$.next(active.id);
          }
        });
      });
  }

  private stopPolling() {
    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
      this.pollingSub = null;
    }
  }

  private checkAndEmitSync(state: any) {
    if (!state) return;
    const now = Date.now();
    const newUri = state.track_window?.current_track?.uri;
    const newPaused = state.paused;
    const newPosition = state.position;
    const newContextUri = state.context?.uri;

    let isSeeked = false;
    // Only detect seeks if we are playing and were playing before
    if (newUri && this.lastSyncedUri === newUri && !newPaused && !this.lastSyncedPaused) {
        const expectedPosition = this.lastSyncedPosition + (now - this.lastCheckTime);
        if (Math.abs(newPosition - expectedPosition) > 10000) { // 10s threshold
            isSeeked = true;
        }
    }

    const hasChanged = newUri && (newUri !== this.lastSyncedUri || newPaused !== this.lastSyncedPaused || isSeeked);

    if (hasChanged) {
      // Don't emit on the very first poll to avoid blasting current state upon app load
      if (!this.isFirstPoll) {
        this.syncAction$.next({
          command: isSeeked ? 'seek' : 'sync',
          data: { uri: newUri, position: newPosition, paused: newPaused, contextUri: newContextUri }
        });
      }
      this.lastSyncedUri = newUri;
      this.lastSyncedPaused = newPaused;
      this.lastSyncedPosition = newPosition;
      this.lastCheckTime = now;
    } else if (newUri) {
        // Keep tracking position even if no change emitted
        this.lastSyncedPosition = newPosition;
        this.lastCheckTime = now;
    }
    this.isFirstPoll = false;
  }

  async loadSavedPlaylists() {
    if (!this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/playlists?limit=50`, { headers }));
      this.savedPlaylists$.next(res.items || []);
    } catch (err) {
      console.error('[Spotify] Failed to load playlists:', err);
    }
  }

  async loadRecentPlays() {
    if (!this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/player/recently-played?limit=12`, { headers }));
      this.recentPlays$.next(res.items || []);
    } catch (err) {
      console.error('[Spotify] Failed to load recent plays:', err);
    }
  }

  async loadQueue() {
    if (!this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/player/queue`, { headers }));
      this.queue$.next(res.queue || []);
    } catch (err) {
      console.error('[Spotify] Failed to load queue:', err);
    }
  }

  // Pinned Logic (Local to app)
  private loadPinned() {
    const pinned = JSON.parse(localStorage.getItem('spotify_pinned_items') || '[]');
    this.pinnedItems$.next(pinned);
  }

  togglePin(item: any) {
    const current = this.pinnedItems$.value;
    const isPinned = current.some(p => p.uri === item.uri);
    let updated;
    if (isPinned) {
      updated = current.filter(p => p.uri !== item.uri);
    } else {
      updated = [...current, {
        uri: item.uri,
        name: item.name || item.display_name,
        type: item.type,
        id: item.id || item.uri.split(':').pop(),
        image: item.images?.[0]?.url || item.image || 'assets/spotify-placeholder.png',
        owner: item.owner?.display_name || item.artist || item.owner || 'Unknown'
      }];
    }
    this.pinnedItems$.next(updated);
    localStorage.setItem('spotify_pinned_items', JSON.stringify(updated));
  }

  isPinned(uri: string): boolean {
    return this.pinnedItems$.value.some(p => p.uri === uri);
  }

  async killPlayer() {
    if (this.player) {
      try {
        await this.player.pause();
        this.player.disconnect();
      } catch (e) {
        console.error('[Spotify] Error killing player:', e);
      } finally {
        this.player = null;
        this.sdkDeviceId = null;
        this.isReady$.next(false);
        this.currentTrack$.next(null);
        this.isPaused$.next(true);
      }
    }
  }

  private initSDK() {
    if (window.Spotify) {
      this.setupPlayer();
      return;
    }
    if (!document.getElementById('spotify-player-script')) {
      const script = document.createElement('script');
      script.id = 'spotify-player-script';
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);
    }
    window.onSpotifyWebPlaybackSDKReady = () => this.setupPlayer();
  }

  private setupPlayer() {
    if (this.player || !this.accessToken) return;
    this.player = new window.Spotify.Player({
      name: 'D&D Platform Player',
      getOAuthToken: (cb: any) => cb(this.accessToken),
      volume: 0.5
    });

    this.player.addListener('ready', ({ device_id }: any) => {
      this.sdkDeviceId = device_id;
      this.isReady$.next(true);
      this.getDevices().then(devices => {
        if (!devices.some(d => d.is_active)) {
          this.transferPlayback(device_id);
        }
      });
    });

    this.player.addListener('player_state_changed', (state: any) => {
      if (!state) return;

      // Normalize SDK state for checkAndEmitSync
      const normalizedState = {
          paused: state.paused,
          position: state.position,
          track_window: state.track_window,
          context: state.context
      };
      this.checkAndEmitSync(normalizedState);

      this.currentTrack$.next(state.track_window.current_track);
      this.isPaused$.next(state.paused);
      this.shuffleState$.next(state.shuffle);
      this.loadQueue(); // Refresh queue when state changes
    });

    this.player.connect();
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    if (!this.accessToken) return [];
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/player/devices`, { headers }));
      return res.devices || [];
    } catch (err) {
      return [];
    }
  }

  async transferPlayback(deviceId: string, play: boolean = false) {
    if (!this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      await firstValueFrom(this.http.put(`${this.API_BASE}/me/player`, { device_ids: [deviceId], play }, { headers }));
      this.activeDeviceId$.next(deviceId);
    } catch (err) {}
  }

  async search(query: string): Promise<SpotifySearchResult[]> {
    if (!this.accessToken) return [];
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const params = new HttpParams()
      .set('q', query)
      .set('type', 'track,playlist,album,artist,show,episode')
      .set('limit', '20');

    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/search`, { headers, params }));
      let results: SpotifySearchResult[] = [];

      if (res.tracks) {
        results = results.concat(res.tracks.items.filter((i:any) => i).map((i: any) => ({
          id: i.id, name: i.name, uri: i.uri, type: 'track', image: i.album?.images?.[0]?.url || '', artist: i.artists?.[0]?.name, artistId: i.artists?.[0]?.id
        })));
      }
      if (res.playlists) {
        results = results.concat(res.playlists.items.filter((i:any) => i).map((i: any) => ({
          id: i.id, name: i.name, uri: i.uri, type: 'playlist', image: i.images?.[0]?.url || '', owner: i.owner?.display_name, ownerId: i.owner?.id
        })));
      }
      if (res.albums) {
        results = results.concat(res.albums.items.filter((i:any) => i).map((i: any) => ({
          id: i.id, name: i.name, uri: i.uri, type: 'album', image: i.images?.[0]?.url || '', artist: i.artists?.[0]?.name, artistId: i.artists?.[0]?.id
        })));
      }
      if (res.artists) {
        results = results.concat(res.artists.items.filter((i:any) => i).map((i: any) => ({
          id: i.id, name: i.name, uri: i.uri, type: 'artist', image: i.images?.[0]?.url || ''
        })));
      }
      return results;
    } catch (err) {
      return [];
    }
  }

  async getUserPlaylists(userId: string): Promise<SpotifySearchResult[]> {
    if (!this.accessToken) return [];
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/users/${userId}/playlists?limit=20`, { headers }));
      return (res.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'playlist', image: i.images?.[0]?.url || '', owner: i.owner?.display_name, ownerId: i.owner?.id
      }));
    } catch (err) { return []; }
  }

  async getArtistAlbums(artistId: string): Promise<SpotifySearchResult[]> {
    if (!this.accessToken) return [];
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/artists/${artistId}/albums?limit=20&include_groups=album,single`, { headers }));
      return (res.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'album', image: i.images?.[0]?.url || '', artist: i.artists?.[0]?.name, artistId: i.artists?.[0]?.id
      }));
    } catch (err) { return []; }
  }

  async getUser(userId: string): Promise<any> {
    if (!this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      return await firstValueFrom(this.http.get(`${this.API_BASE}/users/${userId}`, { headers }));
    } catch (err) { return null; }
  }

  async getArtist(artistId: string): Promise<any> {
    if (!this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      return await firstValueFrom(this.http.get(`${this.API_BASE}/artists/${artistId}`, { headers }));
    } catch (err) { return null; }
  }

  async play(uri?: string, positionMs: number = 0, skipSync: boolean = false, contextUri?: string): Promise<any> {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    let body: any = { position_ms: positionMs };

    if (contextUri) {
        body.context_uri = contextUri;
        if (uri && uri !== contextUri) {
            body.offset = { uri: uri };
        }
    } else if (uri) {
      if (uri.includes(':track:') || uri.includes(':episode:')) body.uris = [uri];
      else body.context_uri = uri;
    }

    try {
      const res = await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/play?device_id=${targetId}`, body, { headers }));
      setTimeout(() => this.loadQueue(), 1000);

      const effectiveUri = uri || this.currentTrack$.value?.uri;
      this.lastSyncedUri = effectiveUri;
      this.lastSyncedPaused = false;
      this.lastSyncedPosition = positionMs;
      this.lastCheckTime = Date.now();

      if (!skipSync) {
        this.syncAction$.next({
          command: 'play',
          data: { uri: effectiveUri, position: positionMs, paused: false, contextUri: contextUri || (effectiveUri?.includes(':track:') ? undefined : effectiveUri) }
        });
      }

      return res;
    } catch (err) { return null; }
  }

  async pause(skipSync: boolean = false) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const res = await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/pause?device_id=${targetId}`, {}, { headers }));

    this.lastSyncedPaused = true;
    const state = await this.getPlaybackState();
    this.lastSyncedPosition = state?.position || 0;
    this.lastCheckTime = Date.now();

    if (!skipSync) {
        this.lastSyncedUri = state?.track_window?.current_track?.uri;
        this.syncAction$.next({
            command: 'pause',
            data: { uri: this.lastSyncedUri, position: this.lastSyncedPosition, paused: true, contextUri: state?.context?.uri }
        });
    }

    return res;
  }

  async seek(positionMs: number, skipSync: boolean = false) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/seek?position_ms=${positionMs}&device_id=${targetId}`, {}, { headers }));

      this.lastSyncedPosition = positionMs;
      this.lastCheckTime = Date.now();

      if (!skipSync) {
        const state = await this.getPlaybackState();
        this.syncAction$.next({
          command: 'seek',
          data: { uri: state?.track_window?.current_track?.uri, position: positionMs, paused: state?.paused, contextUri: state?.context?.uri }
        });
      }
    } catch (err) {}
  }

  async nextTrack(skipSync: boolean = false) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const res = await firstValueFrom(this.http.post(`${this.API_BASE}/me/player/next?device_id=${targetId}`, {}, { headers }));
    setTimeout(() => this.loadQueue(), 1000);

    setTimeout(async () => {
        const state = await this.getPlaybackState();
        this.lastSyncedUri = state?.track_window?.current_track?.uri;
        this.lastSyncedPaused = state?.paused;
        this.lastSyncedPosition = state?.position || 0;
        this.lastCheckTime = Date.now();
        if (!skipSync) {
            this.syncAction$.next({
                command: 'next',
                data: { uri: this.lastSyncedUri, position: 0, paused: false, contextUri: state?.context?.uri }
            });
        }
    }, 500);

    return res;
  }

  async previousTrack(skipSync: boolean = false) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const res = await firstValueFrom(this.http.post(`${this.API_BASE}/me/player/previous?device_id=${targetId}`, {}, { headers }));
    setTimeout(() => this.loadQueue(), 1000);

    setTimeout(async () => {
        const state = await this.getPlaybackState();
        this.lastSyncedUri = state?.track_window?.current_track?.uri;
        this.lastSyncedPaused = state?.paused;
        this.lastSyncedPosition = state?.position || 0;
        this.lastCheckTime = Date.now();
        if (!skipSync) {
            this.syncAction$.next({
                command: 'previous',
                data: { uri: this.lastSyncedUri, position: 0, paused: false, contextUri: state?.context?.uri }
            });
        }
    }, 500);

    return res;
  }

  async toggleShuffle(state: boolean) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/shuffle?state=${state}&device_id=${targetId}`, {}, { headers }));
    this.shuffleState$.next(state);
  }

  async setVolume(v: number) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const volumePercent = Math.round(v * 100);
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.put(`${this.API_BASE}/me/player/volume?device_id=${targetId}&volume_percent=${volumePercent}`, {}, { headers }));
  }

  async togglePlay(skipSync: boolean = false) {
    const state = await this.getPlaybackState();
    if (state && !state.paused) {
      await this.pause(skipSync);
    } else {
      await this.play(undefined, state?.position || 0, skipSync);
    }
  }

  async getPlaybackState() {
    if (this.activeDeviceId$.value === this.sdkDeviceId && this.player) {
      const state = await this.player.getCurrentState();
      if (state) {
        return {
          paused: state.paused,
          position: state.position,
          shuffle_state: state.shuffle,
          track_window: state.track_window,
          context: state.context
        };
      }
    }
    if (!this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const state: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/player`, { headers }));
      if (!state) return null;
      return {
        paused: !state.is_playing,
        position: state.progress_ms,
        shuffle_state: state.shuffle_state,
        track_window: { current_track: state.item ? { uri: state.item.uri, name: state.item.name, album: state.item.album, artists: state.item.artists } : null },
        context: state.context
      };
    } catch (e) { return null; }
  }

  login() {
    if (!this.accessToken) {
      window.location.href = `${this.BACKEND_API}/spotify/login`;
    } else {
      this.initSDK();
    }
  }
}

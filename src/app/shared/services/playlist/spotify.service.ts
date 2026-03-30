import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, interval, Subscription } from 'rxjs';
import { startWith, switchMap, catchError, of } from 'rxjs';

declare global {
  interface Window { onSpotifyWebPlaybackSDKReady: () => void; Spotify: any; }
}

export interface SpotifySearchResult {
  id: string;
  name: string;
  uri: string;
  type: 'track' | 'playlist' | 'album' | 'artist' | 'show' | 'episode' | 'audiobook';
  image: string;
  artist?: string;
  owner?: string;
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
  public isAuthorized$ = new BehaviorSubject<boolean>(false);
  public error$ = new BehaviorSubject<string | null>(null);
  public devices$ = new BehaviorSubject<SpotifyDevice[]>([]);
  public activeDeviceId$ = new BehaviorSubject<string | null>(null);

  private readonly API_BASE = 'https://api.spotify.com/v1';

  constructor(private http: HttpClient) {
    this.accessToken = localStorage.getItem('spotify_access_token');
    if (this.accessToken) {
      this.isAuthorized$.next(true);
      this.initSDK();
      this.startPolling();
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
  }

  login() {
    if (!this.accessToken) {
      window.location.href = `http://127.0.0.1:5000/spotify/login`;
    } else {
      this.initSDK();
    }
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
  }

  private startPolling() {
    this.stopPolling();
    this.pollingSub = interval(5000)
      .pipe(
        startWith(0),
        switchMap(() => this.getDevices()),
        catchError(() => of([]))
      )
      .subscribe(devices => {
        this.devices$.next(devices);
        const active = devices.find(d => d.is_active);
        if (active) {
          this.activeDeviceId$.next(active.id);
        } else if (this.sdkDeviceId && !this.activeDeviceId$.value) {
           // If no active device but SDK is ready, we might want to default to it later
        }
      });
  }

  private stopPolling() {
    if (this.pollingSub) {
      this.pollingSub.unsubscribe();
      this.pollingSub = null;
    }
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
      console.log('[Spotify SDK] Ready with Device ID:', device_id);
      this.sdkDeviceId = device_id;
      this.isReady$.next(true);
      this.error$.next(null);
      // Don't auto-transfer anymore, let user decide or check if something else is active
      this.getDevices().then(devices => {
        if (!devices.some(d => d.is_active)) {
          this.transferPlayback(device_id);
        }
      });
    });

    this.player.addListener('player_state_changed', (state: any) => {
      if (!state) return;
      this.currentTrack$.next(state.track_window.current_track);
      this.isPaused$.next(state.paused);
    });

    this.player.addListener('initialization_error', ({ message }: any) => {
      this.error$.next(`DRM Error: ${message}. Please ensure Widevine/Protected Content is enabled in your browser settings.`);
    });
    this.player.addListener('authentication_error', () => {
      this.error$.next('Authentication failed. Please re-login.');
      this.logout();
    });
    this.player.addListener('account_error', () => {
      this.error$.next('Spotify Premium is required for the Web Player.');
    });
    this.player.addListener('playback_error', ({ message }: any) => {
      console.error('[Spotify SDK] Playback Error:', message);
      this.error$.next(`Playback Error: ${message}. This is likely a DRM/License issue.`);
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
      this.handleApiError(err);
      return [];
    }
  }

  async transferPlayback(deviceId: string, play: boolean = false) {
    if (!this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      await firstValueFrom(this.http.put(`${this.API_BASE}/me/player`, { device_ids: [deviceId], play }, { headers }));
      this.activeDeviceId$.next(deviceId);
    } catch (err) {
      console.error('[Spotify Service] Failed to transfer playback:', err);
    }
  }

  async search(query: string): Promise<SpotifySearchResult[]> {
    if (!this.accessToken) return [];
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const params = new HttpParams()
      .set('q', query)
      .set('type', 'track,playlist,album,artist,show,episode,audiobook')
      .set('limit', '20');

    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/search`, { headers, params }));
      let results: SpotifySearchResult[] = [];

      results = results.concat((res.tracks?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'track', image: i.album?.images?.[0]?.url || '', artist: i.artists?.[0]?.name
      })));
      results = results.concat((res.playlists?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'playlist', image: i.images?.[0]?.url || '', owner: i.owner?.display_name
      })));
      results = results.concat((res.albums?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'album', image: i.images?.[0]?.url || '', artist: i.artists?.[0]?.name
      })));
      results = results.concat((res.artists?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'artist', image: i.images?.[0]?.url || ''
      })));
      results = results.concat((res.shows?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'show', image: i.images?.[0]?.url || '', publisher: i.publisher
      })));
      results = results.concat((res.episodes?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'episode', image: i.images?.[0]?.url || '', publisher: i.show?.publisher
      })));
      results = results.concat((res.audiobooks?.items || []).filter((i: any) => i).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'audiobook', image: i.images?.[0]?.url || '', publisher: i.publisher
      })));

      return results;
    } catch (err) {
      this.handleApiError(err);
      return [];
    }
  }

  async play(uri?: string, positionMs: number = 0): Promise<any> {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);

    let body: any = { position_ms: positionMs };
    if (uri) {
      if (uri.includes(':track:')) {
        body.uris = [uri];
      } else {
        body.context_uri = uri;
      }
    }

    try {
      return await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/play?device_id=${targetId}`, body, { headers }));
    } catch (err) {
      this.handleApiError(err);
      return null;
    }
  }

  async pause() {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.put(`${this.API_BASE}/me/player/pause?device_id=${targetId}`, {}, { headers })).catch(e => this.handleApiError(e));
  }

  async nextTrack() {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.post(`${this.API_BASE}/me/player/next?device_id=${targetId}`, {}, { headers })).catch(e => this.handleApiError(e));
  }

  async previousTrack() {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.post(`${this.API_BASE}/me/player/previous?device_id=${targetId}`, {}, { headers })).catch(e => this.handleApiError(e));
  }

  async setVolume(v: number) {
    const targetId = this.activeDeviceId$.value || this.sdkDeviceId;
    if (!targetId || !this.accessToken) return;
    const volumePercent = Math.round(v * 100);
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.put(`${this.API_BASE}/me/player/volume?device_id=${targetId}&volume_percent=${volumePercent}`, {}, { headers })).catch(e => this.handleApiError(e));
  }

  async togglePlay() {
    // If using SDK, use SDK toggle
    if (this.activeDeviceId$.value === this.sdkDeviceId && this.player) {
      this.player.togglePlay();
    } else {
      // Use API toggle (check current status first)
      const state = await this.getPlaybackState();
      if (state && !state.paused) {
        await this.pause();
      } else {
        await this.play();
      }
    }
  }

  async getPlaybackState() {
    if (this.activeDeviceId$.value === this.sdkDeviceId && this.player) {
      return this.player.getCurrentState();
    }
    // Fallback to API state
    if (!this.accessToken) return null;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    try {
      const state: any = await firstValueFrom(this.http.get(`${this.API_BASE}/me/player`, { headers }));
      if (!state) return null;
      // Map API state to something similar to SDK state if needed, or just return it
      return {
        paused: !state.is_playing,
        position: state.progress_ms,
        track_window: {
          current_track: state.item ? { uri: state.item.uri, name: state.item.name } : null
        }
      };
    } catch (e) {
      return null;
    }
  }

  private handleApiError(err: any) {
    if (err.status === 401) this.logout();
  }
}

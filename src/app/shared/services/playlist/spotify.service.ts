import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

declare global {
  interface Window { onSpotifyWebPlaybackSDKReady: () => void; Spotify: any; }
}

export interface SpotifySearchResult {
  id: string;
  name: string;
  uri: string;
  type: 'track' | 'playlist' | 'album' | 'artist' | 'show' | 'episode' | 'audiobook';
  image: string;
  artist?: string; // For tracks, albums, artists
  owner?: string; // For playlists
  publisher?: string; // For shows, episodes, audiobooks
}

@Injectable({ providedIn: 'root' })
export class SpotifyService {
  private player: any;
  private deviceId: string | null = null;
  private accessToken: string | null = null;

  public isReady$ = new BehaviorSubject<boolean>(false);
  public currentTrack$ = new BehaviorSubject<any>(null);
  public isPaused$ = new BehaviorSubject<boolean>(true);
  public isAuthorized$ = new BehaviorSubject<boolean>(false);
  public error$ = new BehaviorSubject<string | null>(null);

  private readonly API_BASE = 'https://api.spotify.com/v1';

  constructor(private http: HttpClient) {
    this.accessToken = localStorage.getItem('spotify_access_token');
    if (this.accessToken) {
      this.isAuthorized$.next(true);
      this.initSDK();
    }
  }

  setTokens(access: string, refresh: string) {
    this.accessToken = access;
    localStorage.setItem('spotify_access_token', access);
    localStorage.setItem('spotify_refresh_token', refresh);
    this.isAuthorized$.next(true);
    this.error$.next(null);
    this.initSDK();
  }

  login() {
    if (!this.accessToken) {
      window.location.href = `http://127.0.0.1:5000/spotify/login`;
    } else {
      this.initSDK();
    }
  }

  logout() {
    if (this.player) {
      this.player.disconnect();
      this.player = null;
    }
    this.accessToken = null;
    localStorage.removeItem('spotify_access_token');
    localStorage.removeItem('spotify_refresh_token');
    this.isAuthorized$.next(false);
    this.isReady$.next(false);
    this.error$.next(null);
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
      this.deviceId = device_id;
      this.isReady$.next(true);
      this.error$.next(null);
    });

    this.player.addListener('player_state_changed', (state: any) => {
      if (!state) return;
      this.currentTrack$.next(state.track_window.current_track);
      this.isPaused$.next(state.paused);
    });

    this.player.addListener('initialization_error', ({ message }: any) => this.error$.next('DRM/Widevine not supported. Use a browser or CastLabs Electron.'));
    this.player.addListener('authentication_error', () => { this.error$.next('Auth expired.'); this.logout(); });
    this.player.addListener('account_error', () => this.error$.next('Spotify Premium required.'));

    this.player.connect();
  }

  async search(query: string): Promise<SpotifySearchResult[]> {
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    const params = new HttpParams()
      .set('q', query)
      .set('type', 'track,playlist,album,artist,show,episode,audiobook') // Expanded types
      .set('limit', '20');

    try {
      const res: any = await firstValueFrom(this.http.get(`${this.API_BASE}/search`, { headers, params }));
      let results: SpotifySearchResult[] = [];

      // Map tracks
      results = results.concat((res.tracks?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'track', image: i.album?.images[0]?.url || '', artist: i.artists[0]?.name
      })));
      // Map playlists
      results = results.concat((res.playlists?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'playlist', image: i.images[0]?.url || '', owner: i.owner?.display_name
      })));
      // Map albums
      results = results.concat((res.albums?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'album', image: i.images[0]?.url || '', artist: i.artists[0]?.name
      })));
      // Map artists
      results = results.concat((res.artists?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'artist', image: i.images[0]?.url || ''
      })));
      // Map shows
      results = results.concat((res.shows?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'show', image: i.images[0]?.url || '', publisher: i.publisher
      })));
      // Map episodes
      results = results.concat((res.episodes?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'episode', image: i.images[0]?.url || '', publisher: i.show?.publisher
      })));
      // Map audiobooks
      results = results.concat((res.audiobooks?.items || []).map((i: any) => ({
        id: i.id, name: i.name, uri: i.uri, type: 'audiobook', image: i.images[0]?.url || '', publisher: i.publisher
      })));

      return results;
    } catch (err) {
      this.handleApiError(err);
      return [];
    }
  }

  async play(uri?: string, positionMs: number = 0): Promise<any> {
    if (!this.deviceId || !this.accessToken) return null;
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
      return await firstValueFrom(this.http.put(`${this.API_BASE}/me/player/play?device_id=${this.deviceId}`, body, { headers }));
    } catch (err) {
      this.handleApiError(err);
      return null;
    }
  }

  async pause() {
    if (!this.deviceId) return;
    const headers = new HttpHeaders().set('Authorization', `Bearer ${this.accessToken}`);
    return firstValueFrom(this.http.put(`${this.API_BASE}/me/player/pause?device_id=${this.deviceId}`, {}, { headers })).catch(e => this.handleApiError(e));
  }

  async getPlaybackState() { return this.player?.getCurrentState(); }
  togglePlay() { this.player?.togglePlay(); }
  nextTrack() { this.player?.nextTrack(); }
  previousTrack() { this.player?.previousTrack(); }
  setVolume(v: number) { this.player?.setVolume(v); }

  private handleApiError(err: any) {
    if (err.status === 401) this.logout();
  }
}

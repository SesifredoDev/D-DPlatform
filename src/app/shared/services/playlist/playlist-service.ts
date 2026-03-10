import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

declare global {
  interface Window { onSpotifyWebPlaybackSDKReady: () => void; Spotify: any; }
}

@Injectable({ providedIn: 'root' })
export class PlaylistService {
  private player: any;
  private deviceId: string | null = null;
  public musicStream: MediaStream | null = null;

  constructor(private http: HttpClient) {}


  initSpotify(token: string): Promise<MediaStream> {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);

      window.onSpotifyWebPlaybackSDKReady = () => {
        this.player = new window.Spotify.Player({
          name: 'D&D Call Player',
          getOAuthToken: (cb: any) => cb(token),
          volume: 0.5
        });

        this.player.addListener('ready', ({ device_id }: any) => {
          this.deviceId = device_id;
          // Strategy: Use captureStream on the hidden Spotify iframe
          // or bridge via Web Audio API destination
          const stream = this.captureSpotifyStream();
          resolve(stream);
        });

        this.player.connect();
      };
    });
  }

  private captureSpotifyStream(): MediaStream {
    // This looks for the Spotify SDK's internal playback element
    const audioEl = document.querySelector('audio') || document.createElement('audio');
    return (audioEl as any).captureStream();
  }


  private captureSpotifyAudio() {
    // Spotify SDK plays through a hidden video/audio element.
    // We find it and capture the stream.
    const spotifyEl = document.querySelector('iframe[api-service*="spotify"]');
    if (spotifyEl) {
      // Note: captureStream() may require user interaction first
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const stream = (canvas as any).captureStream();
      // In a real production environment, you would use Web Audio API
      // to bridge the Spotify Player node to a MediaStreamDestination.
    }
  }

  async playPlaylist(playlistUri: string, token: string) {
    return this.http.put(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`,
      { context_uri: playlistUri },
      { headers: { Authorization: `Bearer ${token}` } }
    ).toPromise();
  }

  toggle() { this.player?.togglePlay(); }
  next() { this.player?.nextTrack(); }
  setVolume(v: number) { this.player?.setVolume(v); }
}

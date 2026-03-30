import { Component, Input, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { SpotifyService, SpotifySearchResult } from '../../../../shared/services/playlist/spotify.service';
import { Video } from '../../../../shared/services/video/video';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf, AsyncPipe } from '@angular/common';

@Component({
  selector: 'app-spotify-player',
  templateUrl: './spotify-player.html',
  styleUrls: ['./spotify-player.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe]
})
export class SpotifyPlayer implements OnInit, OnDestroy {
  @Input() isCallActive: boolean = false;
  @Output() close = new EventEmitter<void>();

  spotifySearch: string = '';
  searchResults: SpotifySearchResult[] = [];
  showDevicePicker: boolean = false;
  private spotifySyncSub!: Subscription;

  constructor(
    public spotify: SpotifyService,
    private videoService: Video
  ) {}

  ngOnInit() {
    // Spotify Sync Handling
    this.spotifySyncSub = this.videoService.spotifySync$.subscribe(async (state) => {
      if (!state.uri || !this.isCallActive) return;

      const currentState = await this.spotify.getPlaybackState();

      // Sync if different track or significantly different time
      if (!currentState || (currentState.track_window?.current_track?.uri !== state.uri) || Math.abs(currentState.position - state.position) > 4000) {
        if (!state.paused) {
          const drift = Date.now() - state.timestamp;
          await this.spotify.play(state.uri, state.position + drift);
        } else {
          await this.spotify.pause();
        }
      }
    });
  }

  async doSpotifySearch() {
    if (!this.spotifySearch) return;
    this.searchResults = await this.spotify.search(this.spotifySearch);
  }

  async playTrack(item: SpotifySearchResult) {
    if (!this.isCallActive) return;
    await this.spotify.play(item.uri);
    this.searchResults = [];
    this.spotifySearch = '';

    this.videoService.sendSpotifyCommand('play', {
      uri: item.uri,
      position: 0,
      paused: false
    });
  }

  async togglePlay() {
    if (!this.isCallActive) return;
    await this.spotify.togglePlay();
    setTimeout(async () => {
      const state = await this.spotify.getPlaybackState();
      if (state) {
        this.videoService.sendSpotifyCommand(state.paused ? 'pause' : 'play', {
          uri: state.track_window?.current_track?.uri,
          position: state.position,
          paused: state.paused
        });
      }
    }, 800);
  }

  async nextTrack() {
    await this.spotify.nextTrack();
    this.syncCurrentState('next');
  }

  async previousTrack() {
    await this.spotify.previousTrack();
    this.syncCurrentState('previous');
  }

  private async syncCurrentState(command: string) {
    if (!this.isCallActive) return;
    setTimeout(async () => {
      const state = await this.spotify.getPlaybackState();
      if (state && state.track_window?.current_track) {
        this.videoService.sendSpotifyCommand(command, {
          uri: state.track_window.current_track.uri,
          position: state.position,
          paused: state.paused
        });
      }
    }, 1000);
  }

  async transferPlayback(deviceId: string) {
    await this.spotify.transferPlayback(deviceId, true);
    this.showDevicePicker = false;
  }

  updateVolume(event: any) {
    this.spotify.setVolume(event.target.value);
  }

  ngOnDestroy() {
    if (this.spotifySyncSub) this.spotifySyncSub.unsubscribe();
  }
}

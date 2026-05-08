import { Component, DoCheck, Input, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { SpotifyService, SpotifySearchResult } from '../../../../shared/services/playlist/spotify.service';
import { TabService } from '../../../../shared/services/tab/tab-service';
import { Video } from '../../../../shared/services/video/video';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf, AsyncPipe } from '@angular/common';

type ResultGroup = { [key: string]: SpotifySearchResult[] };
type SidebarTab = 'playlists' | 'recent' | 'pinned';

interface SpotifyPlayerUiState {
  spotifySearch: string;
  groupedResults: ResultGroup;
  activeCategory: string;
  showDevicePicker: boolean;
  showQueue: boolean;
  activeSidebarTab: SidebarTab;
  showProfile: boolean;
  profileData: any;
  profileItems: SpotifySearchResult[];
}

@Component({
  selector: 'app-spotify-player',
  templateUrl: './spotify-player.html',
  styleUrls: ['./spotify-player.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe]
})
export class SpotifyPlayer implements OnInit, DoCheck, OnDestroy {
  private static readonly uiStateStorageKey = 'dd-platform.spotify-player.tab-ui-state';

  @Input() isCallActive: boolean = false;
  @Input() isTab: boolean = false;
  @Input() isServerOwner: boolean = false;
  @Input() userName: string = 'Unknown Player';
  @Output() close = new EventEmitter<void>();

  spotifySearch: string = '';
  groupedResults: ResultGroup = {};
  activeCategory: string = 'all';
  showDevicePicker: boolean = false;
  showPinnedPulldown: boolean = false;
  showQueue: boolean = false;
  isLoading: boolean = false;
  activeSidebarTab: SidebarTab = 'playlists';

  // Profile View
  showProfile: boolean = false;
  profileData: any = null;
  profileItems: SpotifySearchResult[] = [];

  readonly categories = [
    { id: 'all', label: 'All' },
    { id: 'track', label: 'Tracks' },
    { id: 'playlist', label: 'Playlists' },
    { id: 'album', label: 'Albums' },
    { id: 'artist', label: 'Artists' },
    { id: 'show', label: 'Podcasts' }
  ];

  constructor(
    public spotify: SpotifyService,
    private tabService: TabService,
    private videoService: Video
  ) {}

  private lastPersistedUiState = '';

  ngOnInit() {
    this.restoreUiState();
  }

  ngDoCheck() {
    this.persistUiState();
  }

  async doSpotifySearch() {
    if (!this.spotifySearch) return;

    if (this.spotifySearch.includes('open.spotify.com/') || this.spotifySearch.startsWith('spotify:')) {
      await this.handleSpotifyLink(this.spotifySearch);
      return;
    }

    this.isLoading = true;
    this.showProfile = false;
    try {
      const results = await this.spotify.search(this.spotifySearch);

      this.groupedResults = results.reduce((acc: ResultGroup, item) => {
        const type = (item.type === 'episode' || item.type === 'audiobook') ? 'show' : item.type;
        if (!acc[type]) acc[type] = [];
        acc[type].push(item);
        return acc;
      }, {});

      this.activeCategory = 'all';
      this.showQueue = false;
    } finally {
      this.isLoading = false;
    }
  }

  private async handleSpotifyLink(link: string) {
    let uri = link;
    if (link.includes('open.spotify.com/')) {
      const parts = link.split('?')[0].split('/');
      const type = parts[parts.length - 2];
      const id = parts[parts.length - 1];
      uri = `spotify:${type}:${id}`;
    }

    if (this.isServerOwner) {
        await this.spotify.play(uri);
    } else {
        // If not server owner, request the song/playlist
        this.videoService.sendSpotifyRequest({ uri, name: 'Spotify Link' }, this.userName);
    }
    this.spotifySearch = '';
  }

  get filteredResults(): SpotifySearchResult[] {
    if (this.activeCategory === 'all') {
      return Object.values(this.groupedResults).flat().slice(0, 30);
    }
    return this.groupedResults[this.activeCategory] || [];
  }

  openAsTab() {
    this.tabService.openTab('spotify-main', 'Spotify', 'spotify', 'right');
    this.close.emit();
  }

  async playTrack(item: any) {
    const uri = item.uri || item.track?.uri || item.item?.uri;
    if (this.isServerOwner || !this.isCallActive) {
        await this.spotify.play(uri);
    } else {
        this.videoService.sendSpotifyRequest(item, this.userName);
    }

    if (this.spotifySearch) {
      this.groupedResults = {};
      this.spotifySearch = '';
    }
    this.showPinnedPulldown = false;
    this.showQueue = false;
  }

  async requestTrack(item: any) {
    const uri = item.uri || item.track?.uri || item.item?.uri;
    if (this.isServerOwner) {
      await this.spotify.addToQueue(uri);
    } else {
      this.videoService.sendSpotifyRequest(item, this.userName);
    }
    if (this.spotifySearch) {
      this.groupedResults = {};
      this.spotifySearch = '';
    }
    this.showPinnedPulldown = false;
    this.showQueue = false;
  }

  async viewProfile(id: string | undefined, type: "artist" | "user") {
    if (!id) return;
    this.isLoading = true;
    this.showQueue = false;
    this.showProfile = true;
    this.profileData = null;
    this.profileItems = [];

    try {
      if (type === 'artist') {
        this.profileData = await this.spotify.getArtist(id);
        this.profileItems = await this.spotify.getArtistAlbums(id);
      } else {
        this.profileData = await this.spotify.getUser(id);
        this.profileItems = await this.spotify.getUserPlaylists(id);
      }
    } finally {
      this.isLoading = false;
    }
  }

  async togglePlay() {
    await this.spotify.togglePlay();
  }

  async toggleShuffle() {
    const currentState = this.spotify.shuffleState$.value;
    await this.spotify.toggleShuffle(!currentState);
  }

  async nextTrack() {
    await this.spotify.nextTrack();
  }

  async previousTrack() {
    await this.spotify.previousTrack();
  }

  async transferPlayback(deviceId: string) {
    await this.spotify.transferPlayback(deviceId, true);
    this.showDevicePicker = false;
  }

  async updateVolume(event: any) {
    await this.spotify.setVolume(event.target.value);
  }

  ngOnDestroy() {
    this.persistUiState();
  }

  private restoreUiState() {
    if (!this.isTab) return;

    try {
      const rawState = localStorage.getItem(SpotifyPlayer.uiStateStorageKey);
      if (!rawState) return;

      const state = JSON.parse(rawState) as Partial<SpotifyPlayerUiState>;
      this.spotifySearch = typeof state.spotifySearch === 'string' ? state.spotifySearch : '';
      this.groupedResults = this.isResultGroup(state.groupedResults) ? state.groupedResults : {};
      this.activeCategory = this.isKnownCategory(state.activeCategory) ? state.activeCategory : 'all';
      this.showDevicePicker = state.showDevicePicker === true;
      this.showQueue = state.showQueue === true;
      this.activeSidebarTab = this.isSidebarTab(state.activeSidebarTab) ? state.activeSidebarTab : 'playlists';
      this.showProfile = state.showProfile === true;
      this.profileData = state.profileData ?? null;
      this.profileItems = Array.isArray(state.profileItems) ? state.profileItems : [];
    } catch {
      this.resetPersistedUiState();
    }
  }

  private persistUiState() {
    if (!this.isTab) return;

    try {
      const serialized = JSON.stringify(this.getUiState());
      if (serialized === this.lastPersistedUiState) return;

      localStorage.setItem(SpotifyPlayer.uiStateStorageKey, serialized);
      this.lastPersistedUiState = serialized;
    } catch {
      // Persistence is best effort only; Spotify auth/playback state is still handled by SpotifyService.
    }
  }

  private getUiState(): SpotifyPlayerUiState {
    return {
      spotifySearch: this.spotifySearch,
      groupedResults: this.groupedResults,
      activeCategory: this.activeCategory,
      showDevicePicker: this.showDevicePicker,
      showQueue: this.showQueue,
      activeSidebarTab: this.activeSidebarTab,
      showProfile: this.showProfile,
      profileData: this.profileData,
      profileItems: this.profileItems
    };
  }

  private resetPersistedUiState() {
    this.lastPersistedUiState = '';
    try {
      localStorage.removeItem(SpotifyPlayer.uiStateStorageKey);
    } catch {
      // Best effort cleanup only.
    }
  }

  private isKnownCategory(value: unknown): value is string {
    return typeof value === 'string' && this.categories.some(category => category.id === value);
  }

  private isSidebarTab(value: unknown): value is SidebarTab {
    return value === 'playlists' || value === 'recent' || value === 'pinned';
  }

  private isResultGroup(value: unknown): value is ResultGroup {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
}

import { Component, DoCheck, Input, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import {
  SoundCloudService,
  SoundCloudSearchResult,
  SoundCloudMusicListImportResult
} from '../../../../shared/services/playlist/soundcloud.service';
import { TabService } from '../../../../shared/services/tab/tab-service';
import { Video } from '../../../../shared/services/video/video';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf, AsyncPipe } from '@angular/common';
import { Subscription } from 'rxjs';
import type { ResultGroup, SidebarTab, SoundCloudPlayerUiState } from '../../../../shared/models/pages/dashboard/call/spotify-player/spotify-player.model';
@Component({
  selector: 'app-spotify-player',
  templateUrl: './spotify-player.html',
  styleUrls: ['./spotify-player.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe]
})
export class SpotifyPlayer implements OnInit, DoCheck, OnDestroy {
  private static readonly uiStateStorageKey = 'dd-platform.soundcloud-player.tab-ui-state';

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
  isRefreshingThumbnails: boolean = false;
  activeSidebarTab: SidebarTab = 'playlists';
  libraryMessage: string = '';
  highlightedUris = new Set<string>();

  // Profile View
  showProfile: boolean = false;
  profileData: any = null;
  profileItems: SoundCloudSearchResult[] = [];

  readonly categories = [
    { id: 'all', label: 'All' },
    { id: 'track', label: 'Tracks' },
    { id: 'playlist', label: 'Playlists' }
  ];

  constructor(
    public spotify: SoundCloudService,
    private tabService: TabService,
    private videoService: Video
  ) {}

  private lastPersistedUiState = '';
  private savedItemsSub?: Subscription;
  private highlightTimeout?: ReturnType<typeof setTimeout>;

  ngOnInit() {
    this.restoreUiState();
    this.savedItemsSub = this.spotify.savedItems$.subscribe(() => {
      void this.refreshSavedSearch();
    });
  }

  ngDoCheck() {
    this.persistUiState();
  }

  async doSpotifySearch() {
    const query = this.spotifySearch.trim();

    if (!query) {
      this.libraryMessage = '';
      await this.refreshSavedSearch();
      return;
    }

    if (this.isSoundCloudLink(query) && this.spotify.isUserPlaylistSourceUrl(query)) {
      await this.importUserPlaylists(query);
      return;
    }

    if (this.isSoundCloudLink(query)) {
      await this.saveSoundCloudLink(query);
      return;
    }

    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;
    try {
      const results = await this.spotify.search(query);
      this.applyResults(results);
      this.activeCategory = 'all';
      this.libraryMessage = results.length ? '' : `No saved SoundCloud items match "${query}".`;
    } finally {
      this.isLoading = false;
    }
  }

  private async saveSoundCloudLink(uri: string) {
    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;
    try {
      const existingItem = this.spotify.getSavedItemFromUrl(uri);
      if (existingItem) {
        this.spotifySearch = '';
        this.highlightItems([existingItem]);
        this.libraryMessage = `Already saved: ${existingItem.name}`;
        await this.refreshSavedSearch();
        this.activeCategory = existingItem.type;
        return;
      }

      const item = await this.spotify.addSavedItemFromUrl(uri);
      this.spotifySearch = '';
      this.libraryMessage = `Saved ${item.type}: ${item.name}`;
      await this.refreshSavedSearch();
    } finally {
      this.isLoading = false;
    }
  }

  private async importUserPlaylists(uri: string) {
    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;
    this.libraryMessage = 'Importing public SoundCloud playlists...';
    try {
      const result = await this.spotify.addUserPlaylistsFromUrl(uri);
      this.spotifySearch = '';
      await this.refreshSavedSearch();
      this.activeCategory = 'playlist';

      if (result.duplicates.length) {
        this.highlightItems(result.duplicates);
      }

      if (!result.discoveredCount) {
        this.libraryMessage = 'No public playlists were found for that SoundCloud user.';
        return;
      }

      if (!result.added.length && result.duplicates.length) {
        this.libraryMessage = `No new playlists added. Highlighted ${result.duplicates.length} already saved playlist${result.duplicates.length === 1 ? '' : 's'}.`;
        return;
      }

      this.libraryMessage = `Added ${result.added.length} playlist${result.added.length === 1 ? '' : 's'}${result.duplicates.length ? ` and highlighted ${result.duplicates.length} duplicate${result.duplicates.length === 1 ? '' : 's'}` : ''}.`;
    } catch {
      this.libraryMessage = 'Could not import playlists for that SoundCloud user.';
    } finally {
      this.isLoading = false;
    }
  }

  async refreshSavedSearch() {
    const query = this.isSoundCloudLink(this.spotifySearch) ? '' : this.spotifySearch.trim();
    const results = await this.spotify.search(query);
    this.applyResults(results);
    this.activeCategory = 'all';
  }

  onSearchInputChange() {
    this.libraryMessage = '';
    void this.refreshSavedSearch();
  }

  private applyResults(results: SoundCloudSearchResult[]) {
    this.groupedResults = results.reduce((acc: ResultGroup, item) => {
      const type = item.type;
      if (!acc[type]) acc[type] = [];
      acc[type].push(item);
      return acc;
    }, {});
  }

  async removeSavedItem(item: SoundCloudSearchResult | any, event?: Event) {
    event?.stopPropagation();
    const uri = item.uri || item.permalink_url || item.track?.uri || item.track?.permalink_url;
    if (!uri) return;

    this.spotify.removeSavedItem(uri);
    this.libraryMessage = 'Removed from saved SoundCloud library.';
    await this.refreshSavedSearch();
  }

  onImageError(event: Event, fallback: string = 'assets/spotify-placeholder.png') {
    const image = event.target as HTMLImageElement | null;
    if (!image || image.getAttribute('src') === fallback) return;

    image.src = fallback;
  }

  isHighlighted(item: any): boolean {
    const uri = item?.uri || item?.permalink_url || item?.track?.uri || item?.track?.permalink_url;
    return !!uri && this.highlightedUris.has(uri);
  }

  private highlightItems(items: any[]) {
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
    }

    this.highlightedUris = new Set(
      items
        .map(item => item?.uri || item?.permalink_url || item?.track?.uri || item?.track?.permalink_url)
        .filter((uri): uri is string => typeof uri === 'string' && !!uri)
    );

    this.highlightTimeout = setTimeout(() => {
      this.highlightedUris = new Set<string>();
      this.highlightTimeout = undefined;
    }, 5500);
  }

  async refreshThumbnails() {
    if (this.isRefreshingThumbnails) return;

    this.isRefreshingThumbnails = true;
    this.libraryMessage = 'Refreshing SoundCloud thumbnails...';
    try {
      const refreshedCount = await this.spotify.refreshSavedThumbnails();
      await this.refreshSavedSearch();
      this.libraryMessage = refreshedCount
        ? `Refreshed thumbnails for ${refreshedCount} saved item${refreshedCount === 1 ? '' : 's'}.`
        : 'No saved SoundCloud items to refresh.';
    } catch {
      this.libraryMessage = 'Could not refresh thumbnails right now.';
    } finally {
      this.isRefreshingThumbnails = false;
    }
  }

  downloadMusicList() {
    const musicList = this.spotify.exportMusicList();
    const fileContents = JSON.stringify(musicList, null, 2);
    const blob = new Blob([fileContents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `soundcloud-music-list-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);

    this.libraryMessage = `Downloaded ${musicList.savedItems.length} saved SoundCloud item${musicList.savedItems.length === 1 ? '' : 's'}.`;
  }

  async uploadMusicList(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!input || !file) return;

    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;

    try {
      const fileContents = await file.text();
      const result = this.spotify.importMusicListFromJson(fileContents);
      await this.refreshSavedSearch();
      this.activeCategory = 'all';
      this.libraryMessage = this.formatMusicListImportMessage(result);
    } catch {
      this.libraryMessage = 'Could not upload that SoundCloud music list. Choose a valid JSON export.';
    } finally {
      this.isLoading = false;
      input.value = '';
    }
  }

  private formatMusicListImportMessage(result: SoundCloudMusicListImportResult): string {
    const parts = [
      result.addedCount
        ? `Imported ${result.addedCount} saved item${result.addedCount === 1 ? '' : 's'}`
        : 'No new saved items imported',
      result.duplicateCount
        ? `skipped ${result.duplicateCount} duplicate${result.duplicateCount === 1 ? '' : 's'}`
        : '',
      result.pinnedAddedCount
        ? `restored ${result.pinnedAddedCount} pinned item${result.pinnedAddedCount === 1 ? '' : 's'}`
        : ''
    ].filter(Boolean);

    return `${parts.join(', ')}.`;
  }

  get searchActionLabel(): string {
    if (this.spotify.isUserPlaylistSourceUrl(this.spotifySearch.trim())) {
      return 'Import';
    }

    return this.isSoundCloudLink(this.spotifySearch.trim()) ? 'Add' : 'Search';
  }

  clearSearch() {
    this.spotifySearch = '';
    this.libraryMessage = '';
    void this.refreshSavedSearch();
  }

  get filteredResults(): SoundCloudSearchResult[] {
    if (this.activeCategory === 'all') {
      return Object.values(this.groupedResults).flat().slice(0, 30);
    }
    return this.groupedResults[this.activeCategory] || [];
  }

  openAsTab() {
    this.tabService.openTab('soundcloud-main', 'SoundCloud', 'spotify', 'right');
    this.close.emit();
  }

  async playTrack(item: any) {
    const uri = item.uri || item.permalink_url || item.track?.uri || item.track?.permalink_url || item.item?.uri;
    if (!uri) return;

    if (this.isServerOwner || !this.isCallActive) {
        await this.spotify.play(uri);
    } else {
        this.videoService.sendSoundCloudRequest(item, this.userName);
    }

    if (this.spotifySearch) {
      this.spotifySearch = '';
      await this.refreshSavedSearch();
    }
    this.showPinnedPulldown = false;
    this.showQueue = false;
  }

  async requestTrack(item: any) {
    const uri = item.uri || item.permalink_url || item.track?.uri || item.track?.permalink_url || item.item?.uri;
    if (!uri) return;

    if (this.isServerOwner) {
      await this.spotify.addToQueue(uri);
    } else {
      this.videoService.sendSoundCloudRequest(item, this.userName);
    }
    if (this.spotifySearch) {
      this.spotifySearch = '';
      await this.refreshSavedSearch();
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
    if (this.highlightTimeout) {
      clearTimeout(this.highlightTimeout);
    }

    this.savedItemsSub?.unsubscribe();
    this.persistUiState();
  }

  private restoreUiState() {
    if (!this.isTab) return;

    try {
      const rawState = localStorage.getItem(SpotifyPlayer.uiStateStorageKey);
      if (!rawState) return;

      const state = JSON.parse(rawState) as Partial<SoundCloudPlayerUiState>;
      this.spotifySearch = typeof state.spotifySearch === 'string' ? state.spotifySearch : '';
      this.groupedResults = this.isResultGroup(state.groupedResults) ? state.groupedResults : {};
      this.activeCategory = this.isKnownCategory(state.activeCategory) ? state.activeCategory : 'all';
      this.showDevicePicker = state.showDevicePicker === true;
      this.showQueue = state.showQueue === true;
      const storedTab = state.activeSidebarTab as unknown;
      const restoredTab = storedTab === 'recent' ? 'tracks' : storedTab;
      this.activeSidebarTab = this.isSidebarTab(restoredTab) ? restoredTab : 'playlists';
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
      // Persistence is best effort only; SoundCloud library/playback state is still handled by SoundCloudService.
    }
  }

  private getUiState(): SoundCloudPlayerUiState {
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
    return value === 'playlists' || value === 'tracks' || value === 'pinned';
  }

  private isResultGroup(value: unknown): value is ResultGroup {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private isSoundCloudLink(value: string): boolean {
    return value.includes('soundcloud.com/') || value.startsWith('soundcloud:');
  }
}

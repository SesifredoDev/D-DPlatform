import { Component, DoCheck, Input, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import {
  SoundCloudService,
  SoundCloudSearchResult,
  SoundCloudMusicListImportResult
} from '../../../../shared/services/playlist/soundcloud.service';
import { PlaylistService, Song } from '../../../../shared/services/playlist/playlist-service';
import { TabService } from '../../../../shared/services/tab/tab-service';
import { Video } from '../../../../shared/services/video/video';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf, AsyncPipe } from '@angular/common';
import { Subscription, firstValueFrom } from 'rxjs';
import type { ResultGroup, SidebarTab, SoundCloudPlayerUiState } from '../../../../shared/models/pages/dashboard/call/spotify-player/spotify-player.model';

interface TagGridCard {
  name: string;
  cover: string;
  description: string;
}

type SelectionMode = 'mood-first' | 'atmosphere-first';

@Component({
  selector: 'app-spotify-player',
  templateUrl: './spotify-player.html',
  styleUrls: ['./spotify-player.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe]
})
export class SpotifyPlayer implements OnInit, DoCheck, OnDestroy {
  private static readonly uiStateStorageKey = 'dd-platform.music-player.tab-ui-state';

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
  availableMoods: string[] = [];
  availableAtmospheres: string[] = [];
  availableMoodCards: TagGridCard[] = [];
  availableAtmosphereCards: TagGridCard[] = [];
  selectionMode: SelectionMode = 'mood-first';
  selectedMood: string = '';
  selectedAtmosphere: string = '';
  moodPlaylistTracks: Array<Partial<SoundCloudSearchResult>> = [];
  isLoadingMoodPlaylist: boolean = false;
  showAttributionInfo: boolean = false;
  attributionInfoHtml: string = '';

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
    private playlistService: PlaylistService,
    private tabService: TabService,
    private videoService: Video
  ) {}

  private lastPersistedUiState = '';
  private savedItemsSub?: Subscription;
  private highlightTimeout?: ReturnType<typeof setTimeout>;
  private searchRequestId = 0;
  private loadingRequestId = 0;
  private isDestroyed = false;
  private songCatalog: Song[] = [];
  private allMoodCards: TagGridCard[] = [];
  private allAtmosphereCards: TagGridCard[] = [];

  ngOnInit() {
    this.restoreUiState();
    void this.loadMoodOptions();
    this.savedItemsSub = this.spotify.savedItems$.subscribe(() => {
      void this.refreshSavedSearch().catch(() => undefined);
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

    if (this.isMediaLink(query) && this.spotify.isUserPlaylistSourceUrl(query)) {
      await this.importUserPlaylists(query);
      return;
    }

    if (this.isMediaLink(query)) {
      await this.saveMusicLink(query);
      return;
    }

    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;
    const requestId = ++this.searchRequestId;
    this.loadingRequestId = requestId;
    try {
      const results = await this.spotify.search(query);
      if (!this.isCurrentSearchRequest(requestId)) return;

      this.applyResults(results);
      this.activeCategory = 'all';
      this.libraryMessage = results.length ? '' : `No saved songs match "${query}".`;
    } catch {
      if (this.isCurrentSearchRequest(requestId)) {
        this.libraryMessage = 'Could not search your saved music library.';
      }
    } finally {
      if (!this.isDestroyed && this.loadingRequestId === requestId) {
        this.isLoading = false;
      }
    }
  }

  private async saveMusicLink(uri: string) {
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
    } catch {
      this.libraryMessage = 'Could not save that audio link.';
    } finally {
      this.isLoading = false;
    }
  }

  private async importUserPlaylists(uri: string) {
    this.isLoading = true;
    this.showProfile = false;
    this.showQueue = false;
    this.libraryMessage = 'Importing playlists...';
    try {
      const result = await this.spotify.addUserPlaylistsFromUrl(uri);
      this.spotifySearch = '';
      await this.refreshSavedSearch();
      this.activeCategory = 'playlist';

      if (result.duplicates.length) {
        this.highlightItems(result.duplicates);
      }

      if (!result.discoveredCount) {
        this.libraryMessage = 'No playlists were found for that source.';
        return;
      }

      if (!result.added.length && result.duplicates.length) {
        this.libraryMessage = `No new playlists added. Highlighted ${result.duplicates.length} already saved playlist${result.duplicates.length === 1 ? '' : 's'}.`;
        return;
      }

      this.libraryMessage = `Added ${result.added.length} playlist${result.added.length === 1 ? '' : 's'}${result.duplicates.length ? ` and highlighted ${result.duplicates.length} duplicate${result.duplicates.length === 1 ? '' : 's'}` : ''}.`;
    } catch {
      this.libraryMessage = 'Could not import playlists from that source.';
    } finally {
      this.isLoading = false;
    }
  }

  async refreshSavedSearch() {
    const requestId = ++this.searchRequestId;
    const query = this.isMediaLink(this.spotifySearch) ? '' : this.spotifySearch.trim();
    try {
      const results = await this.spotify.search(query);
      if (!this.isCurrentSearchRequest(requestId)) return;

      this.applyResults(results);
      this.activeCategory = 'all';
      void this.loadMoodOptions();
    } catch {
      if (this.isCurrentSearchRequest(requestId)) {
        this.libraryMessage = 'Could not refresh your saved music library.';
      }
    }
  }

  async loadMoodOptions() {
    try {
      this.songCatalog = await firstValueFrom(this.playlistService.getSongs());
      this.allMoodCards = this.extractTagGridCards(
        this.songCatalog.flatMap(song => song.moods ?? [])
      );
      this.allAtmosphereCards = this.extractTagGridCards(
        this.songCatalog.flatMap(song => song.atmosphere ?? [])
      );
      this.syncSelectionCards();
      await this.loadMoodPlaylistTracks();
    } catch {
      this.songCatalog = [];
      this.availableMoods = [];
      this.availableAtmospheres = [];
      this.availableMoodCards = [];
      this.availableAtmosphereCards = [];
      this.allMoodCards = [];
      this.allAtmosphereCards = [];
      this.selectedMood = '';
      this.selectedAtmosphere = '';
      this.moodPlaylistTracks = [];
    }
  }

  setSelectionMode(mode: SelectionMode) {
    if (this.selectionMode === mode) return;
    this.selectionMode = mode;
    this.selectedMood = '';
    this.selectedAtmosphere = '';
    this.moodPlaylistTracks = [];
    this.syncSelectionCards();
  }

  async onMoodChange() {
    this.syncSelectionCards();
    await this.loadMoodPlaylistTracks();
  }

  private syncSelectionCards() {
    if (!this.songCatalog.length) {
      this.availableMoodCards = [];
      this.availableAtmosphereCards = [];
      this.availableMoods = [];
      this.availableAtmospheres = [];
      return;
    }

    if (this.selectionMode === 'mood-first') {
      this.availableMoodCards = [...this.allMoodCards];
      this.availableMoods = this.availableMoodCards.map(card => card.name);
      this.availableAtmosphereCards = this.selectedMood
        ? this.extractTagGridCards(this.getSongsByMood(this.selectedMood).flatMap(song => song.atmosphere ?? []))
        : [...this.allAtmosphereCards];
      this.availableAtmospheres = this.availableAtmosphereCards.map(card => card.name);

      if (this.selectedMood && !this.availableMoods.includes(this.selectedMood)) {
        this.selectedMood = '';
      }
      if (this.selectedAtmosphere && !this.availableAtmospheres.includes(this.selectedAtmosphere)) {
        this.selectedAtmosphere = '';
      }
      return;
    }

    this.availableAtmosphereCards = [...this.allAtmosphereCards];
    this.availableAtmospheres = this.availableAtmosphereCards.map(card => card.name);
    this.availableMoodCards = this.selectedAtmosphere
      ? this.extractTagGridCards(this.getSongsByAtmosphere(this.selectedAtmosphere).flatMap(song => song.moods ?? []))
      : [...this.allMoodCards];
    this.availableMoods = this.availableMoodCards.map(card => card.name);

    if (this.selectedAtmosphere && !this.availableAtmospheres.includes(this.selectedAtmosphere)) {
      this.selectedAtmosphere = '';
    }
    if (this.selectedMood && !this.availableMoods.includes(this.selectedMood)) {
      this.selectedMood = '';
    }
  }

  async selectMood(mood: string) {
    if (this.selectedMood === mood) return;
    this.selectedMood = mood;

    if (this.selectionMode === 'mood-first') {
      this.selectedAtmosphere = '';
    }

    this.moodPlaylistTracks = [];
    this.syncSelectionCards();
    await this.loadMoodPlaylistTracks();
  }

  async selectAtmosphere(atmosphere: string) {
    if (this.selectedAtmosphere === atmosphere) return;
    this.selectedAtmosphere = atmosphere;

    if (this.selectionMode === 'atmosphere-first') {
      this.selectedMood = '';
    }

    this.syncSelectionCards();
    await this.loadMoodPlaylistTracks();
  }

  clearMoodSelection() {
    this.selectedMood = '';
    if (this.selectionMode === 'mood-first') {
      this.selectedAtmosphere = '';
    }
    this.moodPlaylistTracks = [];
    this.syncSelectionCards();
  }

  clearAtmosphereSelection() {
    this.selectedAtmosphere = '';
    if (this.selectionMode === 'atmosphere-first') {
      this.selectedMood = '';
    }
    this.moodPlaylistTracks = [];
    this.syncSelectionCards();
  }

  goBackSelection() {
    if (this.selectionMode === 'mood-first') {
      if (this.selectedAtmosphere) {
        this.clearAtmosphereSelection();
        return;
      }

      if (this.selectedMood) {
        this.clearMoodSelection();
      }
      return;
    }

    if (this.selectedMood) {
      this.clearMoodSelection();
      return;
    }

    if (this.selectedAtmosphere) {
      this.clearAtmosphereSelection();
    }
  }

  async playCurrentSelection() {
    const mood = (this.selectedMood || '').trim();
    const atmosphere = (this.selectedAtmosphere || '').trim();

    if (!mood && !atmosphere) {
      this.libraryMessage = 'Select a mood or atmosphere before playing.';
      return;
    }

    await this.playMoodFilteredPlaylist(mood, atmosphere);
  }

  private async loadMoodPlaylistTracks() {
    const mood = (this.selectedMood || '').trim();
    const atmosphere = (this.selectedAtmosphere || '').trim();

    if (!mood && !atmosphere) {
      this.moodPlaylistTracks = [];
      return;
    }

    this.isLoadingMoodPlaylist = true;
    try {
      const songs = await firstValueFrom(
        this.playlistService.getSongsByMoodAndAtmosphere(mood, atmosphere)
      );
      this.moodPlaylistTracks = songs.map(song => this.toTrackMetadata(song));
    } catch {
      this.moodPlaylistTracks = [];
    } finally {
      this.isLoadingMoodPlaylist = false;
    }
  }

  private async playMoodFilteredPlaylist(mood: string, atmosphere: string) {
    this.closeAttributionInfo();
    try {
      const songs = await firstValueFrom(
        this.playlistService.getSongsByMoodAndAtmosphere(mood, atmosphere)
      );
      if (!songs.length) {
        if (mood && atmosphere) {
          this.libraryMessage = 'No songs match that mood and atmosphere.';
        } else if (mood) {
          this.libraryMessage = 'No songs match that mood.';
        } else {
          this.libraryMessage = 'No songs match that atmosphere.';
        }
        return;
      }

      const shuffledSongs = this.shuffleSongs([...songs]);

      if (!this.isServerOwner && this.isCallActive) {
        const sent = await this.videoService.sendSoundCloudRequest(this.toPlaylistRequestTrack(shuffledSongs[0]), this.userName);
        this.libraryMessage = sent
          ? `Sent "${this.getTrackName(shuffledSongs[0])}" playlist request to the DM.`
          : 'Could not send the playlist request. Join the call and try again.';
        return;
      }

      const [firstSong, ...rest] = shuffledSongs;
      await this.spotify.play(
        this.toSongUri(firstSong.fileName),
        0,
        false,
        undefined,
        this.toTrackMetadata(firstSong)
      );

      for (const song of rest) {
        await this.spotify.addToQueue(this.toSongUri(song.fileName));
      }

      const selectionLabel = this.getSelectionPlaybackLabel(mood, atmosphere);
      this.libraryMessage = `Playing ${shuffledSongs.length} song${shuffledSongs.length === 1 ? '' : 's'} ${selectionLabel}.`;
      this.showQueue = false;
      this.showProfile = false;
    } catch {
      this.libraryMessage = 'Could not start that playlist.';
    }
  }

  private getSelectionPlaybackLabel(mood: string, atmosphere: string): string {
    if (mood && atmosphere) return `for ${mood} / ${atmosphere}`;
    if (mood) return `for ${mood}`;
    if (atmosphere) return `for ${atmosphere}`;
    return 'from your full library';
  }

  private shuffleSongs<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  private getSongsByMood(moodName: string): Song[] {
    const key = moodName.trim().toLowerCase();
    return this.songCatalog.filter(song =>
      (song.moods ?? []).some(tag => `${tag?.name ?? ''}`.trim().toLowerCase() === key)
    );
  }

  private getSongsByAtmosphere(atmosphereName: string): Song[] {
    const key = atmosphereName.trim().toLowerCase();
    return this.songCatalog.filter(song =>
      (song.atmosphere ?? []).some(tag => `${tag?.name ?? ''}`.trim().toLowerCase() === key)
    );
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

  private isCurrentSearchRequest(requestId: number): boolean {
    return !this.isDestroyed && requestId === this.searchRequestId;
  }

  async removeSavedItem(item: SoundCloudSearchResult | any, event?: Event) {
    event?.stopPropagation();
    const uri = item.uri || item.permalink_url || item.track?.uri || item.track?.permalink_url;
    if (!uri) return;

    this.spotify.removeSavedItem(uri);
    this.libraryMessage = 'Removed from saved music library.';
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
    this.libraryMessage = 'Refreshing artwork...';
    try {
      const refreshedCount = await this.spotify.refreshSavedThumbnails();
      await this.refreshSavedSearch();
      this.libraryMessage = refreshedCount
        ? `Refreshed thumbnails for ${refreshedCount} saved item${refreshedCount === 1 ? '' : 's'}.`
        : 'No saved songs to refresh.';
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
    link.download = `music-list-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);

    this.libraryMessage = `Downloaded ${musicList.savedItems.length} saved song${musicList.savedItems.length === 1 ? '' : 's'}.`;
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
      this.libraryMessage = 'Could not upload that music list. Choose a valid JSON export.';
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

    return this.isMediaLink(this.spotifySearch.trim()) ? 'Add' : 'Search';
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
    this.tabService.openTab('music-main', 'Music', 'spotify', 'right');
    this.close.emit();
  }

  async playTrack(item: any) {
    const uri = item.uri || item.permalink_url || item.track?.uri || item.track?.permalink_url || item.item?.uri;
    if (!uri) return;
    this.closeAttributionInfo();

    try {
      if (this.isServerOwner || !this.isCallActive) {
        await this.spotify.play(uri);
      } else {
        const sent = await this.videoService.sendSoundCloudRequest(item, this.userName);
        this.libraryMessage = sent
          ? 'Sent track request to the DM.'
          : 'Could not send the request. Join the call and try again.';
      }
    } catch {
      this.libraryMessage = this.isServerOwner || !this.isCallActive
        ? 'Could not start playback for that song.'
        : 'Could not send the music request.';
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

    try {
      if (this.isServerOwner) {
        await this.spotify.addToQueue(uri);
        this.libraryMessage = 'Added to queue.';
      } else {
        const sent = await this.videoService.sendSoundCloudRequest(item, this.userName);
        this.libraryMessage = sent
          ? 'Sent track request to the DM.'
          : 'Could not send the request. Join the call and try again.';
      }
    } catch {
      this.libraryMessage = this.isServerOwner
        ? 'Could not add that song to the queue.'
        : 'Could not send the music request.';
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
    } catch {
      this.libraryMessage = 'Could not load that profile.';
      this.showProfile = false;
    } finally {
      this.isLoading = false;
    }
  }

  async togglePlay() {
    if (!this.canControlPlayback) return;
    await this.runPlaybackCommand(
      () => this.spotify.togglePlay(),
      'Could not toggle playback.'
    );
  }

  async toggleShuffle() {
    if (!this.canControlPlayback) return;
    const currentState = this.spotify.shuffleState$.value;
    await this.runPlaybackCommand(
      () => this.spotify.toggleShuffle(!currentState),
      'Could not update shuffle.'
    );
  }

  async nextTrack() {
    if (!this.canControlPlayback) return;
    await this.runPlaybackCommand(
      () => this.spotify.nextTrack(),
      'Could not skip to the next song.'
    );
  }

  async previousTrack() {
    if (!this.canControlPlayback) return;
    await this.runPlaybackCommand(
      () => this.spotify.previousTrack(),
      'Could not go back to the previous song.'
    );
  }

  async transferPlayback(deviceId: string) {
    await this.runPlaybackCommand(
      () => this.spotify.transferPlayback(deviceId, true),
      'Could not transfer playback.'
    );
    this.showDevicePicker = false;
  }

  async updateVolume(value: number | string) {
    await this.runPlaybackCommand(
      () => this.spotify.setVolumePercent(value),
      'Could not update SoundCloud volume.'
    );
  }

  async seekPlayback(value: number | string) {
    if (!this.canControlPlayback) return;
    await this.runPlaybackCommand(
      () => this.spotify.seek(this.normalizePlaybackTime(value)),
      'Could not seek playback.'
    );
  }

  openAttributionInfo(track: Partial<SoundCloudSearchResult> | null | undefined) {
    const text = `${track?.attribution ?? ''}`.trim();
    this.attributionInfoHtml = text
      ? this.formatAttributionText(text)
      : 'No attribution provided for this track.';
    this.showAttributionInfo = true;
  }

  closeAttributionInfo() {
    this.showAttributionInfo = false;
    this.attributionInfoHtml = '';
  }

  get canControlPlayback(): boolean {
    return this.isServerOwner || !this.isCallActive;
  }

  get playbackControlTitle(): string {
    return this.canControlPlayback ? '' : 'Only DMs can control playback';
  }

  private async runPlaybackCommand(action: () => Promise<unknown>, failureMessage: string) {
    try {
      await action();
    } catch {
      this.libraryMessage = failureMessage;
    }
  }

  formatPlaybackTime(value: number | string | null | undefined): string {
    const totalSeconds = Math.floor(this.normalizePlaybackTime(value) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  ngOnDestroy() {
    this.isDestroyed = true;
    this.searchRequestId += 1;

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
      // Persistence is best effort only; library/playback state is still handled by SoundCloudService.
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

  private isMediaLink(value: string): boolean {
    return /^https?:\/\//i.test(value.trim()) || value.startsWith('song:');
  }

  private normalizePlaybackTime(value: number | string | null | undefined): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.round(numericValue)) : 0;
  }

  private linkifyText(value: string): string {
    const escapedText = this.escapeHtml(value);
    const linkedText = escapedText.replace(/(https?:\/\/[^\s<]+)/gi, (rawUrl) => {
      const trimmedUrl = rawUrl.replace(/[),.;!?]+$/g, '');
      const trailingPunctuation = rawUrl.slice(trimmedUrl.length);
      return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${trimmedUrl}</a>${trailingPunctuation}`;
    });
    return linkedText.replace(/\n/g, '<br>');
  }

  private formatAttributionText(value: string): string {
    const normalizedText = this.decodeHtmlEntities(value).trim();
    if (!normalizedText) return '';

    if (!/<a\b/i.test(normalizedText)) {
      return this.linkifyText(normalizedText);
    }

    const normalizedAnchors = normalizedText.replace(
      /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, hrefDoubleQuoted: string, hrefSingleQuoted: string, hrefBare: string, label: string) => {
        const href = `${hrefDoubleQuoted ?? hrefSingleQuoted ?? hrefBare ?? ''}`.trim();
        if (!href) return this.escapeHtml(this.decodeHtmlEntities(label));

        const safeHref = this.escapeHtml(href);
        const safeLabel = this.escapeHtml(this.decodeHtmlEntities(label).trim() || href);
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
      }
    );

    return normalizedAnchors.replace(/\n/g, '<br>');
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private toSongUri(fileName: string): string {
    return `song:${fileName}`;
  }

  private getTrackName(song: Song): string {
    const raw = song.fileName.split('/').pop() || song.fileName;
    return decodeURIComponent(raw).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Custom track';
  }

  private getTrackArtist(song: Song): string {
    const mood = song.moods?.[0]?.name;
    const atmosphere = song.atmosphere?.[0]?.name;
    if (mood && atmosphere) return `${mood} • ${atmosphere}`;
    return mood || atmosphere || 'Custom source';
  }

  private extractTagGridCards(tags: Array<{ name?: string; cover?: string; description?: string }>): TagGridCard[] {
    const cardsByName = new Map<string, TagGridCard>();

    for (const tag of tags) {
      const name = `${tag?.name ?? ''}`.trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (cardsByName.has(key)) continue;

      cardsByName.set(key, {
        name,
        cover: `${tag?.cover ?? ''}`.trim() || 'assets/spotify-placeholder.png',
        description: `${tag?.description ?? ''}`.trim()
      });
    }

    return Array.from(cardsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private toTrackMetadata(song: Song): Partial<SoundCloudSearchResult> {
    const name = this.getTrackName(song);
    const artist = this.getTrackArtist(song);
    const rawAttribution = (song as any)?.attribution
      ?? (song as any)?.Attribution
      ?? (song as any)?.credits
      ?? '';
    const attribution = `${rawAttribution}`.trim();
    return {
      uri: this.toSongUri(song.fileName),
      id: this.toSongUri(song.fileName),
      type: 'track',
      name,
      artist,
      owner: artist,
      image: song.cover || 'assets/spotify-placeholder.png',
      fileName: song.fileName,
      cover: song.cover,
      attribution,
      moods: song.moods ?? [],
      atmosphere: song.atmosphere ?? [],
      album: { images: [{ url: song.cover || 'assets/spotify-placeholder.png' }] },
      artists: [{ name: artist }],
      images: [{ url: song.cover || 'assets/spotify-placeholder.png' }]
    };
  }

  private toPlaylistRequestTrack(song: Song) {
    const uri = this.toSongUri(song.fileName);
    const name = this.getTrackName(song);
    const artist = this.getTrackArtist(song);
    const rawAttribution = (song as any)?.attribution
      ?? (song as any)?.Attribution
      ?? (song as any)?.credits
      ?? '';
    const attribution = `${rawAttribution}`.trim();
    return {
      uri,
      name,
      artist,
      image: song.cover || 'assets/spotify-placeholder.png',
      fileName: song.fileName,
      attribution,
      moods: song.moods ?? [],
      atmosphere: song.atmosphere ?? [],
      type: 'track'
    };
  }
}

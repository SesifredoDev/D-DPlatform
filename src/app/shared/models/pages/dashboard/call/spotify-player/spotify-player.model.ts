import type { SoundCloudSearchResult } from '../../../../playlist/soundcloud.service.model';

export type ResultGroup = { [key: string]: SoundCloudSearchResult[] };

export type SidebarTab = 'playlists' | 'tracks' | 'pinned';

export interface SoundCloudPlayerUiState {
  spotifySearch: string;
  groupedResults: ResultGroup;
  activeCategory: string;
  showDevicePicker: boolean;
  showQueue: boolean;
  activeSidebarTab: SidebarTab;
  showProfile: boolean;
  profileData: any;
  profileItems: SoundCloudSearchResult[];
}

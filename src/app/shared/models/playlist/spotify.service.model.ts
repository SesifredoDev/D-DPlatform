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

export interface SpotifySyncEvent {
  command: string;
  data: any;
  source: 'manual' | 'auto';
}

export interface SpotifyRefreshResponse {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
}

export interface SpotifyTokenState {
  accessToken: string | null;
  refreshToken: string | null;
}

export interface SoundCloudSearchResult {
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
  album?: { images: { url: string }[] };
  artists?: { id?: string; name: string }[];
  images?: { url: string }[];
  duration?: number;
}

export interface SoundCloudDevice {
  id: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number;
}

export interface SoundCloudSyncEvent {
  command: string;
  data: any;
  source: 'manual' | 'auto';
}

export interface SoundCloudPlaylistImportResult {
  added: SoundCloudSearchResult[];
  duplicates: SoundCloudSearchResult[];
  discoveredCount: number;
}

export interface SoundCloudOEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

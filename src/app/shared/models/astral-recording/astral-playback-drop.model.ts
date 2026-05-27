export interface AstralPlaybackDropRequest {
  channelId: string;
  path?: string;
  unpacked?: boolean;
  file?: File;
  url?: string;
  remoteManifestUrl?: string;
  remoteMediaUrlTemplate?: string;
  packageSize?: number;
  filename?: string;
}

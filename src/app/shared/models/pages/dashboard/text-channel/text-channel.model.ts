import type { SafeResourceUrl } from '@angular/platform-browser';

export type ChannelAccessPermission = 'READ_MESSAGE_HISTORY' | 'SEND_MESSAGES' | 'CONNECT';

export type LinkPreviewType = 'website' | 'image' | 'video' | 'audio' | 'embed';

export type LinkPreviewAspect = 'landscape' | 'portrait' | 'square';

export type LinkPreviewProvider =
  | 'YouTube'
  | 'Instagram'
  | 'TikTok'
  | 'Vimeo'
  | 'Google Drive'
  | 'OneDrive'
  | 'Proton Drive';

export interface LinkPreview {
  url: string;
  host: string;
  displayUrl: string;
  title: string;
  description: string;
  type: LinkPreviewType;
  icon: string;
  imageUrl?: string;
  embedUrl?: SafeResourceUrl;
  embedAspect?: LinkPreviewAspect;
  provider?: LinkPreviewProvider;
}

export interface PlayableEmbedPreview {
  provider: LinkPreviewProvider;
  embedUrl: string;
  title: string;
  description: string;
  icon: string;
  aspect: LinkPreviewAspect;
  imageUrl?: string;
}

export interface ProviderLinkPreview {
  provider: LinkPreviewProvider;
  title: string;
  description: string;
  icon: string;
}

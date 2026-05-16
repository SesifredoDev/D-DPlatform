import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ViewChild,
  ElementRef,
  OnInit
} from '@angular/core';
import { Subscription } from 'rxjs';
import { Message, MessageData, Attachment } from '../../../shared/services/message/message';
import { UserService } from '../../../shared/services/user/user';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import { TextFieldModule } from '@angular/cdk/text-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { ServerService } from '../../../shared/services/server/server';
import { IServer } from '../../../shared/models/server/server.model';
import {ChannelType, IChannel} from '../../../shared/models/server/channel.model';
import { IUser } from '../../../shared/models/user/user.model';
import { IRole } from '../../../shared/models/server/role.model';
import { FileService } from '../../../shared/services/file/file';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

type ChannelAccessPermission = 'READ_MESSAGE_HISTORY' | 'SEND_MESSAGES' | 'CONNECT';
type LinkPreviewType = 'website' | 'image' | 'video' | 'audio' | 'embed';
type LinkPreviewAspect = 'landscape' | 'portrait' | 'square';
type LinkPreviewProvider =
  | 'YouTube'
  | 'Instagram'
  | 'TikTok'
  | 'Vimeo'
  | 'Google Drive'
  | 'OneDrive'
  | 'Proton Drive';

interface LinkPreview {
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

interface PlayableEmbedPreview {
  provider: LinkPreviewProvider;
  embedUrl: string;
  title: string;
  description: string;
  icon: string;
  aspect: LinkPreviewAspect;
  imageUrl?: string;
}

interface ProviderLinkPreview {
  provider: LinkPreviewProvider;
  title: string;
  description: string;
  icon: string;
}

@Component({
  selector: 'app-text-channel',
  templateUrl: 'text-channel.html',
  styleUrls: ['./text-channel.scss'],
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    MatIconModule,
    MatIconButton,
    MarkdownComponent,
    TextFieldModule,
    MatTooltipModule,
    MatMenuModule
  ],
  providers: [provideMarkdown()]
})
export class TextChannel implements OnChanges, OnDestroy, OnInit {
  @Input() channelId!: string;
  @Input() currentCharacterId?: string;

  private isAtBottom = true;
  private justOpened = true;

  showNewMessageIndicator = false;

  messages: MessageData[] = [];
  newMessageContent = '';
  replyingTo: MessageData | null = null;
  currentUserId: string | null = null;
  canSendMessages = true;
  sendError = '';
  isLoadingOlderMessages = false;
  hasMoreMessages = true;

  attachments: Attachment[] = [];
  isUploading = false;
  uploadProgress = 0;
  readonly quickReactions = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}'];

  private readonly imageExtensions = ['apng', 'avif', 'gif', 'jpg', 'jpeg', 'png', 'svg', 'webp'];
  private readonly videoExtensions = ['m4v', 'mov', 'mp4', 'mpeg', 'ogv', 'webm'];
  private readonly audioExtensions = ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm'];
  private readonly linkPreviewCache = new Map<string, LinkPreview[]>();

  // Whisper state
  isWhisperMode = false;
  whisperRecipient: any = null;
  serverOwner: any = null;

  private msgSub?: Subscription;
  private serverSub?: Subscription;

  @ViewChild('messageContainer') container!: ElementRef;

  constructor(
    private messageService: Message,
    private userService: UserService,
    private serverService: ServerService,
    private fileService: FileService,
    private sanitizer: DomSanitizer
  ) {
    this.userService.getMe().subscribe(user => {
      this.currentUserId = user._id;
      const server = this.serverService.getCurrentServer();
      if (server) {
        this.updateWhisperState(server);
      }
    });
  }

  ngOnInit() {
    this.serverSub = this.serverService.getServerDetailsObservable().subscribe(server => {
      if (server) {
        this.serverOwner = server.owner;
        this.updateWhisperState(server);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['channelId'] && this.channelId) {
      this.loadChannel();
      const server = this.serverService.getCurrentServer();
      if (server) {
        this.updateWhisperState(server);
      }
    }
  }

  updateWhisperState(server: IServer) {
    const channel = server.channels.find(c => c._id === this.channelId);
    if (channel && channel.type === ChannelType.Whisper) {
      this.isWhisperMode = true;
      this.canSendMessages = true;

      const ownerId = typeof server.owner === 'string' ? server.owner : (server.owner as IUser)._id;
      const isOwner = ownerId === this.currentUserId;

      if (isOwner) {
         // Owner is whispering to the stored recipient
         this.whisperRecipient = server.members.find(m => m.user._id === channel.recipient)?.user || { username: channel.name };
      } else {
         // Recipient is whispering to the owner
         this.whisperRecipient = typeof server.owner === 'object' ? server.owner : { username: 'the DM', _id: server.owner };
      }
    } else {
      this.isWhisperMode = false;
      this.whisperRecipient = null;
      this.canSendMessages = channel ? this.hasChannelPermission(server, channel, 'SEND_MESSAGES') : true;
    }
  }

  loadChannel() {
    this.msgSub?.unsubscribe();
    this.linkPreviewCache.clear();
    this.isLoadingOlderMessages = false;
    this.hasMoreMessages = true;
    this.justOpened = true;
    this.isAtBottom = true;

    this.msgSub = this.messageService
      .joinChannel(this.channelId)
      .subscribe(msgs => {
        const hadMessages = this.messages.length > 0;
        this.messages = msgs;

        if (this.isLoadingOlderMessages) {
          return;
        }

        if (this.isAtBottom || this.justOpened) {
          this.scrollToBottom();
        } else if (hadMessages) {
          this.showNewMessageIndicator = true;
        }
      });
  }

  sendMessage() {
    this.sendError = '';
    if (!this.canSendMessages) {
      this.sendError = 'You do not have permission to send messages in this channel.';
      return;
    }

    if (!this.newMessageContent.trim() && this.attachments.length === 0) return;

    // In a whisper channel, every message is a whisper
    const isWhisper = this.isWhisperMode;
    const recipientId = isWhisper ? (this.whisperRecipient?._id) : null;

    this.messageService
      .sendMessage(
        this.channelId,
        this.newMessageContent,
        this.currentCharacterId,
        this.attachments,
        this.replyingTo?._id,
        isWhisper,
        recipientId
      )
      .subscribe({
        next: () => {
          this.newMessageContent = '';
          this.replyingTo = null;
          this.attachments = [];
          this.scrollToBottom(true);
        },
        error: err => {
          console.error('Failed to send message', err);
          this.sendError = err?.error?.message || 'Message could not be sent.';
        }
      });
  }

  private hasChannelPermission(
    server: IServer,
    channel: IChannel,
    permissionName: ChannelAccessPermission
  ): boolean {
    if (!this.currentUserId) return true;

    const ownerId = typeof server.owner === 'string' ? server.owner : (server.owner as IUser)._id;
    if (ownerId === this.currentUserId) return true;

    const member = server.members?.find(candidate => {
      const user = candidate.user as any;
      return (typeof user === 'string' ? user : user?._id) === this.currentUserId;
    });
    if (!member) return false;

    const roleIds = new Set((member.roles ?? []).map(role => this.resolveId(role)).filter(Boolean));
    const memberRoles = (server.roles ?? []).filter(role => roleIds.has(role._id));

    if (memberRoles.some(role => role.permissions?.ADMINISTRATOR)) return true;

    const overwrites = (channel.permissionOverwrites ?? []).filter(overwrite =>
      roleIds.has(this.resolveId(overwrite.role))
    );

    if (overwrites.some(overwrite => (overwrite.deny ?? []).includes(permissionName))) return false;
    if (overwrites.some(overwrite => (overwrite.allow ?? []).includes(permissionName))) return true;

    return memberRoles.some(role => role.permissions?.[permissionName] === true);
  }

  private resolveId(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && '_id' in value) {
      const id = (value as IRole | { _id?: unknown })._id;
      return typeof id === 'string' ? id : '';
    }
    return '';
  }

  handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  onScroll() {
    if (!this.container) return;

    const el = this.container.nativeElement;
    const threshold = 50;

    this.isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    if (this.isAtBottom) {
      this.showNewMessageIndicator = false;
    }

    if (el.scrollTop <= threshold) {
      this.loadOlderMessages();
    }
  }

  private loadOlderMessages() {
    if (!this.channelId || this.isLoadingOlderMessages || !this.hasMoreMessages) return;
    if (!this.container || this.messages.length === 0) return;

    const el = this.container.nativeElement;
    const previousScrollHeight = el.scrollHeight;
    const previousScrollTop = el.scrollTop;

    this.isLoadingOlderMessages = true;

    this.messageService.loadOlderMessages(this.channelId).subscribe({
      next: olderMessages => {
        if (olderMessages.length === 0) {
          this.hasMoreMessages = false;
          this.isLoadingOlderMessages = false;
          return;
        }

        setTimeout(() => {
          if (!this.container) {
            this.isLoadingOlderMessages = false;
            return;
          }

          const updatedEl = this.container.nativeElement;
          updatedEl.scrollTop = updatedEl.scrollHeight - previousScrollHeight + previousScrollTop;
          this.isLoadingOlderMessages = false;
        }, 0);
      },
      error: err => {
        console.error('Failed to load older messages', err);
        this.isLoadingOlderMessages = false;
      }
    });
  }

  scrollToBottom(force = false) {
    setTimeout(() => {
      if (!this.container) return;

      if (force || this.isAtBottom || this.justOpened) {
        this.container.nativeElement.scrollTop =
          this.container.nativeElement.scrollHeight;

        this.showNewMessageIndicator = false;
        this.justOpened = false;
      }
    }, 50);
  }

  setReply(message: MessageData) {
    this.replyingTo = message;
  }

  cancelReply() {
    this.replyingTo = null;
  }

  addReaction(messageId: string, emoji: string) {
    this.messageService.addReaction(messageId, emoji).subscribe();
  }

  toggleReaction(message: MessageData, emoji: string) {
    const reaction = message.reactions.find(r => r.emoji === emoji);
    const hasReacted = reaction?.users.includes(this.currentUserId!);

    if (hasReacted) {
      this.messageService.removeReaction(message._id, emoji).subscribe();
    } else {
      this.messageService.addReaction(message._id, emoji).subscribe();
    }
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;

    this.isUploading = true;
    this.uploadProgress = 0;
    this.sendError = '';

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const uploaded = await this.fileService.uploadFileInChunks(file, progress => {
          const clampedProgress = Math.max(0, Math.min(progress, 100));
          this.uploadProgress = Math.round(((index + clampedProgress / 100) / files.length) * 100);
        });

        this.attachments.push({
          url: uploaded.url,
          id: uploaded.id,
          name: uploaded.name || uploaded.filename || file.name,
          filename: uploaded.filename || file.name,
          contentType: uploaded.contentType || file.type || 'application/octet-stream'
        });
      }
    } catch (err) {
      console.error('Upload failed', err);
      this.sendError = 'Attachment upload failed. Try a smaller file or another format.';
    } finally {
      this.isUploading = false;
      this.uploadProgress = 0;
      input.value = '';
    }
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
  }

  handleMessageLinkClick(event: MouseEvent) {
    const target = event.target as Element | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;

    const safeUrl = this.toSafeExternalUrl(anchor.getAttribute('href') || anchor.href);
    if (!safeUrl) return;

    this.openExternalUrl(safeUrl, event);
  }

  openExternalUrl(url: string | undefined, event?: Event) {
    const safeUrl = this.toSafeExternalUrl(url);
    if (!safeUrl) return;

    event?.preventDefault();
    event?.stopPropagation();
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
  }

  getLinkPreviews(content: string | null | undefined): LinkPreview[] {
    const cacheKey = content ?? '';
    const cached = this.linkPreviewCache.get(cacheKey);
    if (cached) return cached;

    const previews = this.extractPreviewUrls(cacheKey)
      .slice(0, 3)
      .map(url => this.createLinkPreview(url));

    this.linkPreviewCache.set(cacheKey, previews);
    return previews;
  }

  isImageAttachment(attachment: Attachment): boolean {
    return this.hasContentType(attachment, 'image/') || this.hasFileExtension(attachment, this.imageExtensions);
  }

  isVideoAttachment(attachment: Attachment): boolean {
    return this.hasContentType(attachment, 'video/') || this.hasFileExtension(attachment, this.videoExtensions);
  }

  isAudioAttachment(attachment: Attachment): boolean {
    return this.hasContentType(attachment, 'audio/') || this.hasFileExtension(attachment, this.audioExtensions);
  }

  getAttachmentIcon(attachment: Attachment): string {
    if (this.isImageAttachment(attachment)) return 'image';
    if (this.isVideoAttachment(attachment)) return 'movie';
    if (this.isAudioAttachment(attachment)) return 'graphic_eq';
    return 'insert_drive_file';
  }

  getAttachmentDisplayName(attachment: Attachment): string {
    return attachment.name || attachment.filename || 'Attachment';
  }

  formatAttachmentType(attachment: Attachment): string {
    const contentType = attachment.contentType?.split(';')[0]?.trim();
    if (contentType) return contentType;

    const extension = this.getExtension(attachment.url || attachment.filename || attachment.name || '');
    return extension ? extension.toUpperCase() : 'file';
  }

  private extractPreviewUrls(content: string): string[] {
    const markdownImageUrls = new Set<string>();
    for (const match of content.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const safeUrl = this.toSafeExternalUrl(this.cleanUrlMatch(match[1]));
      if (safeUrl) {
        markdownImageUrls.add(safeUrl);
      }
    }

    const matches = content.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? [];
    const urls: string[] = [];
    for (const match of matches) {
      const safeUrl = this.toSafeExternalUrl(this.cleanUrlMatch(match));
      if (safeUrl && !markdownImageUrls.has(safeUrl) && !urls.includes(safeUrl)) {
        urls.push(safeUrl);
      }
    }

    return urls;
  }

  private createLinkPreview(url: string): LinkPreview {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const playableEmbed = this.getPlayableEmbed(parsed);

    if (playableEmbed) {
      const safeEmbedUrl = this.toSafeExternalUrl(playableEmbed.embedUrl);

      return {
        url,
        host,
        displayUrl: this.buildDisplayUrl(parsed, host),
        title: playableEmbed.title,
        description: playableEmbed.description,
        type: 'embed',
        icon: playableEmbed.icon,
        imageUrl: playableEmbed.imageUrl,
        embedUrl: safeEmbedUrl
          ? this.sanitizer.bypassSecurityTrustResourceUrl(safeEmbedUrl)
          : undefined,
        embedAspect: playableEmbed.aspect,
        provider: playableEmbed.provider
      };
    }

    const providerPreview = this.getProviderLinkPreview(parsed);
    if (providerPreview) {
      return {
        url,
        host,
        displayUrl: this.buildDisplayUrl(parsed, host),
        title: providerPreview.title,
        description: providerPreview.description,
        type: 'website',
        icon: providerPreview.icon,
        provider: providerPreview.provider
      };
    }

    const type = this.getPreviewType(parsed.pathname) ?? 'website';

    return {
      url,
      host,
      displayUrl: this.buildDisplayUrl(parsed, host),
      title: this.buildPreviewTitle(parsed, host, type),
      description: this.buildPreviewDescription(parsed, type),
      type,
      icon: this.getPreviewIcon(type),
      imageUrl: this.getPreviewImageUrl(url, type)
    };
  }

  private cleanUrlMatch(value: string): string {
    return value.trim().replace(/[.,!?;:)\]}]+$/g, '');
  }

  private toSafeExternalUrl(value: string | undefined): string | null {
    if (!value) return null;

    try {
      const baseUrl = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
      const url = new URL(value, baseUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }

  private hasContentType(attachment: Attachment, prefix: string): boolean {
    return (attachment.contentType || '').toLowerCase().startsWith(prefix);
  }

  private hasFileExtension(attachment: Attachment, extensions: string[]): boolean {
    return [attachment.url, attachment.name, attachment.filename]
      .filter((candidate): candidate is string => !!candidate)
      .some(candidate => extensions.includes(this.getExtension(candidate)));
  }

  private getExtension(value: string): string {
    const cleanValue = value.split(/[?#]/)[0].toLowerCase();
    const match = cleanValue.match(/\.([a-z0-9]+)$/);
    return match?.[1] ?? '';
  }

  private getPreviewType(pathname: string): LinkPreviewType | null {
    const extension = this.getExtension(pathname);
    if (this.imageExtensions.includes(extension)) return 'image';
    if (this.videoExtensions.includes(extension)) return 'video';
    if (this.audioExtensions.includes(extension)) return 'audio';
    return null;
  }

  private getPlayableEmbed(url: URL): PlayableEmbedPreview | null {
    const youtubeId = this.getYoutubeVideoId(url);
    if (youtubeId) {
      return {
        provider: 'YouTube',
        embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
        title: 'YouTube video',
        description: 'Playable YouTube preview',
        icon: 'smart_display',
        aspect: 'landscape',
        imageUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
      };
    }

    const instagramEmbed = this.getInstagramEmbed(url);
    if (instagramEmbed) return instagramEmbed;

    const tiktokId = this.getTiktokVideoId(url);
    if (tiktokId) {
      return {
        provider: 'TikTok',
        embedUrl: `https://www.tiktok.com/player/v1/${tiktokId}`,
        title: 'TikTok video',
        description: 'Playable TikTok preview',
        icon: 'smart_display',
        aspect: 'portrait'
      };
    }

    const vimeoId = this.getVimeoVideoId(url);
    if (vimeoId) {
      return {
        provider: 'Vimeo',
        embedUrl: `https://player.vimeo.com/video/${vimeoId}`,
        title: 'Vimeo video',
        description: 'Playable Vimeo preview',
        icon: 'smart_display',
        aspect: 'landscape'
      };
    }

    const googleDriveEmbed = this.getGoogleDriveEmbed(url);
    if (googleDriveEmbed) return googleDriveEmbed;

    const oneDriveEmbed = this.getOneDriveEmbed(url);
    if (oneDriveEmbed) return oneDriveEmbed;

    return null;
  }

  private getYoutubeVideoId(url: URL): string | null {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    let candidate: string | null = null;

    if (host === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
    }

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      candidate = url.searchParams.get('v');
      if (!candidate) {
        const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
        candidate = pathMatch?.[1] ?? null;
      }
    }

    return this.cleanProviderId(candidate, /^[A-Za-z0-9_-]{6,}$/);
  }

  private getInstagramEmbed(url: URL): PlayableEmbedPreview | null {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return null;

    const match = url.pathname.match(/^\/(p|reel|tv)\/([^/?#]+)/i);
    if (!match) return null;

    const mediaType = match[1].toLowerCase();
    const mediaId = this.cleanProviderId(match[2], /^[A-Za-z0-9_-]+$/);
    if (!mediaId) return null;

    const isVideoShape = mediaType === 'reel' || mediaType === 'tv';

    return {
      provider: 'Instagram',
      embedUrl: `https://www.instagram.com/${mediaType}/${mediaId}/embed`,
      title: `Instagram ${isVideoShape ? 'reel' : 'post'}`,
      description: 'Playable Instagram preview',
      icon: isVideoShape ? 'smart_display' : 'photo_camera',
      aspect: isVideoShape ? 'portrait' : 'square'
    };
  }

  private getTiktokVideoId(url: URL): string | null {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null;

    const videoMatch = url.pathname.match(/\/video\/(\d+)/);
    const embedMatch = url.pathname.match(/^\/embed\/(?:v2\/)?(\d+)/);
    const playerMatch = url.pathname.match(/^\/player\/v1\/(\d+)/);
    return this.cleanProviderId(videoMatch?.[1] ?? embedMatch?.[1] ?? playerMatch?.[1], /^\d+$/);
  }

  private getVimeoVideoId(url: URL): string | null {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'vimeo.com' && !host.endsWith('.vimeo.com')) return null;

    const playerMatch = url.pathname.match(/^\/video\/(\d+)/);
    if (playerMatch) return this.cleanProviderId(playerMatch[1], /^\d+$/);

    const segments = url.pathname.split('/').filter(Boolean);
    const numericSegment = [...segments].reverse().find(segment => /^\d+$/.test(segment));
    return this.cleanProviderId(numericSegment, /^\d+$/);
  }

  private getGoogleDriveEmbed(url: URL): PlayableEmbedPreview | null {
    const host = this.normalizedHost(url);
    const fileId = this.getGoogleDriveFileId(url);
    if (fileId) {
      return {
        provider: 'Google Drive',
        embedUrl: `https://drive.google.com/file/d/${fileId}/preview`,
        title: 'Google Drive file',
        description: 'Inline Google Drive preview',
        icon: 'add_to_drive',
        aspect: 'landscape'
      };
    }

    if (host !== 'docs.google.com') return null;

    const docsMatch = url.pathname.match(
      /^\/(document|spreadsheets|presentation|drawings)\/d\/([^/?#]+)/i
    );
    const app = docsMatch?.[1]?.toLowerCase();
    const docId = this.cleanProviderId(docsMatch?.[2], /^[A-Za-z0-9_-]{10,}$/);
    if (!app || !docId) return null;

    return {
      provider: 'Google Drive',
      embedUrl: `https://docs.google.com/${app}/d/${docId}/preview`,
      title: 'Google Drive file',
      description: 'Inline Google Drive preview',
      icon: 'add_to_drive',
      aspect: 'landscape'
    };
  }

  private getGoogleDriveFileId(url: URL): string | null {
    const host = this.normalizedHost(url);
    if (host !== 'drive.google.com') return null;

    const fileMatch = url.pathname.match(/^\/file\/d\/([^/?#]+)/i);
    const candidate =
      fileMatch?.[1] ??
      url.searchParams.get('id') ??
      url.searchParams.get('fileId');

    return this.cleanProviderId(candidate, /^[A-Za-z0-9_-]{10,}$/);
  }

  private getOneDriveEmbed(url: URL): PlayableEmbedPreview | null {
    const host = this.normalizedHost(url);
    if (host !== 'onedrive.live.com') return null;

    const pathname = url.pathname.toLowerCase();
    if (pathname === '/embed' || pathname.endsWith('/embed')) {
      return {
        provider: 'OneDrive',
        embedUrl: url.toString(),
        title: 'OneDrive file',
        description: 'Inline OneDrive preview',
        icon: 'cloud',
        aspect: 'landscape'
      };
    }

    const resourceId = this.getOneDriveResourceId(url);
    if (!resourceId) return null;

    const embedUrl = new URL('https://onedrive.live.com/embed');
    embedUrl.searchParams.set('resid', resourceId);

    const authKey = url.searchParams.get('authkey');
    if (authKey) {
      embedUrl.searchParams.set('authkey', authKey);
    }

    const itemHint = url.searchParams.get('ithint');
    if (itemHint) {
      embedUrl.searchParams.set('ithint', itemHint);
    }

    embedUrl.searchParams.set('em', '2');

    return {
      provider: 'OneDrive',
      embedUrl: embedUrl.toString(),
      title: 'OneDrive file',
      description: 'Inline OneDrive preview',
      icon: 'cloud',
      aspect: 'landscape'
    };
  }

  private getOneDriveResourceId(url: URL): string | null {
    const candidate =
      url.searchParams.get('resid') ??
      url.searchParams.get('id');

    const resourceId = this.cleanProviderId(candidate, /^[A-Za-z0-9_.!%-]+$/);
    return resourceId?.includes('!') ? resourceId : null;
  }

  private getProviderLinkPreview(url: URL): ProviderLinkPreview | null {
    const host = this.normalizedHost(url);

    if (host === 'drive.google.com' || host === 'docs.google.com') {
      return {
        provider: 'Google Drive',
        title: 'Google Drive link',
        description: 'Open Google Drive preview in a new tab',
        icon: 'add_to_drive'
      };
    }

    if (
      host === 'onedrive.live.com' ||
      host === '1drv.ms' ||
      host.endsWith('.sharepoint.com')
    ) {
      return {
        provider: 'OneDrive',
        title: 'OneDrive link',
        description: 'Open OneDrive preview in a new tab',
        icon: 'cloud'
      };
    }

    if (host === 'drive.proton.me') {
      return {
        provider: 'Proton Drive',
        title: 'Proton Drive link',
        description: 'Open Proton Drive preview in a new tab',
        icon: 'lock'
      };
    }

    return null;
  }

  private normalizedHost(url: URL): string {
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  }

  private cleanProviderId(value: string | null | undefined, pattern: RegExp): string | null {
    if (!value) return null;

    const candidate = value.trim();
    return pattern.test(candidate) ? candidate : null;
  }

  private buildDisplayUrl(url: URL, host: string): string {
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
    return path ? `${host}${path}` : host;
  }

  private buildPreviewTitle(url: URL, host: string, type: LinkPreviewType): string {
    if (type === 'image') return 'Image link';
    if (type === 'video') return 'Video link';
    if (type === 'audio') return 'Audio link';

    const segments = url.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (!lastSegment) return `Open ${host}`;

    const withoutExtension = decodeURIComponent(lastSegment).replace(/\.[a-z0-9]{2,6}$/i, '');
    const title = withoutExtension.replace(/[-_+]+/g, ' ').trim();
    return title ? this.toTitleCase(title) : `Open ${host}`;
  }

  private buildPreviewDescription(url: URL, type: LinkPreviewType): string {
    if (type === 'image') return 'Open image in a new tab';
    if (type === 'video') return 'Playable video preview';
    if (type === 'audio') return 'Playable audio preview';

    return `External link from ${url.hostname.replace(/^www\./i, '')}`;
  }

  private getPreviewIcon(type: LinkPreviewType): string {
    if (type === 'image') return 'image';
    if (type === 'video') return 'movie';
    if (type === 'audio') return 'graphic_eq';
    if (type === 'embed') return 'smart_display';
    return 'language';
  }

  private getPreviewImageUrl(url: string, type: LinkPreviewType): string | undefined {
    if (type === 'image') return url;
    return undefined;
  }

  private toTitleCase(value: string): string {
    return value.replace(/\b\w/g, letter => letter.toUpperCase()).slice(0, 90);
  }

  ngOnDestroy() {
    this.msgSub?.unsubscribe();
    this.serverSub?.unsubscribe();
    this.messageService.leaveChannel(this.channelId);
  }
}

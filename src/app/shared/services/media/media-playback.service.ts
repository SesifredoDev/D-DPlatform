import { Injectable, inject, signal } from '@angular/core';
import { Subject, firstValueFrom } from 'rxjs';
import { Video } from '../video/video';
import { FileService } from '../file/file';
import { SoundCloudService } from '../playlist/soundcloud.service';
import { ServerService } from '../server/server';
import { AuthService } from '../auth/auth';
import { UserService } from '../user/user';

export type MediaKind = 'audio' | 'video';

const AUDIO_EXTENSIONS = /\.(aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|ogv|mkv|avi)$/i;

/** Whether a file plays as audio or video (by its type, else its name). */
export function mediaKindOf(name: string, contentType?: string | null): MediaKind | null {
  if (contentType?.startsWith('audio/')) return 'audio';
  if (contentType?.startsWith('video/')) return 'video';
  if (AUDIO_EXTENSIONS.test(name)) return 'audio';
  if (VIDEO_EXTENSIONS.test(name)) return 'video';
  return null;
}

/** What's playing in the background player (bottom left), just on this device. */
export interface LocalMedia {
  id: number;
  name: string;
  kind: MediaKind;
  url: string;
  /** The file, kept so it can be sent to the call without reading it again. */
  file: Blob | null;
  /** Where to start, in seconds. */
  startAt: number;
}

/** How "Play on call" went: played for everyone, or (audio, not the DM) sent to the DM's queue. */
export type CallPlayResult = 'played' | 'requested';

interface UploadedMedia {
  url: string;
  filename: string;
}

/**
 * Plays music and video from the vault or a broadcast, either locally or on the call.
 *
 * - **Locally**: in the page (a vault file or embed), or in the background player, which keeps
 *   playing while you move between notes.
 * - **On the call**: audio goes through the call's shared music player (the DM plays it; anyone
 *   else sends it to the DM's request queue); video shows on everyone's screen, in step with
 *   whoever started it.
 *
 * Only one thing plays locally at a time: starting one pauses the others.
 */
@Injectable({ providedIn: 'root' })
export class MediaPlaybackService {
  private readonly video = inject(Video);
  private readonly fileService = inject(FileService);
  private readonly soundCloud = inject(SoundCloudService);
  private readonly serverService = inject(ServerService);
  private readonly authService = inject(AuthService);
  private readonly userService = inject(UserService);

  readonly local = signal<LocalMedia | null>(null);
  /** A file being sent to the call, with upload progress (0–100). */
  readonly sending = signal<{ name: string; progress: number } | null>(null);
  /** A player started; every other player pauses. Carries the player's id. */
  readonly playing$ = new Subject<string>();

  private nextId = 1;
  private uploads = new Map<string, Promise<UploadedMedia>>();

  isCallConnected(): boolean {
    return this.video.isCallConnected();
  }

  /** The DM controls the call's music; anyone else's audio becomes a request. */
  canControlCallAudio(): boolean {
    return this.serverService.canUserDm(this.serverService.getCurrentServer(), this.authService.getCurrentUserId());
  }

  /** What "Play on call" will do for this kind of file, for button labels. */
  callActionLabel(kind: MediaKind): string {
    return kind === 'audio' && !this.canControlCallAudio() ? 'Request on call' : 'Play on call';
  }

  /** Tells the other players to pause. */
  notifyPlaying(playerId: string): void {
    this.playing$.next(playerId);
  }

  /** Plays in the background player (keeps playing while you browse). */
  playLocal(source: Blob | string, name: string, kind: MediaKind, startAt = 0): void {
    this.stopLocal();
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    this.local.set({
      id: this.nextId++,
      name,
      kind,
      url,
      file: typeof source === 'string' ? null : source,
      startAt,
    });
  }

  stopLocal(): void {
    const current = this.local();
    if (current?.file && current.url.startsWith('blob:')) URL.revokeObjectURL(current.url);
    this.local.set(null);
  }

  /**
   * Plays a file on the call (uploading it first, once per file). Rejects when there's no call.
   * The background player stops if it was playing the same thing (the call plays it now).
   */
  async playOnCall(file: Blob, name: string, kind: MediaKind, startAt = 0): Promise<CallPlayResult> {
    if (!this.isCallConnected()) throw new Error('Join a call first.');
    const uploaded = await this.upload(file, name);
    if (this.local()?.file === file) this.stopLocal();
    return this.playUploadedOnCall(uploaded, kind, startAt);
  }

  /** Shows an image on everyone's screen in the call (uploading it first, once per image). */
  async showImageOnCall(file: Blob, name: string): Promise<void> {
    if (!this.isCallConnected()) throw new Error('Join a call first.');
    const uploaded = await this.upload(file, name);
    this.video.broadcastOverlayImage(uploaded.url);
  }

  /** Plays an already uploaded file on the call. */
  async playUploadedOnCall(asset: UploadedMedia, kind: MediaKind, startAt = 0): Promise<CallPlayResult> {
    if (!this.isCallConnected()) throw new Error('Join a call first.');
    if (kind === 'video') {
      this.video.broadcastOverlayVideo({ url: asset.url, name: asset.filename, playing: true, time: startAt });
      return 'played';
    }

    const metadata = {
      id: asset.url,
      uri: asset.url,
      name: asset.filename,
      artist: 'Shared audio',
      owner: 'Shared audio',
      image: '',
      type: 'track' as const,
    };
    if (this.canControlCallAudio()) {
      await this.soundCloud.play(asset.url, Math.round(startAt * 1000), false, undefined, metadata);
      return 'played';
    }
    const me = await firstValueFrom(this.userService.getMe()).catch(() => null);
    await this.video.sendSoundCloudRequest(metadata, me?.username || 'A player');
    return 'requested';
  }

  /** Uploads a file once: playing it on the call again reuses the upload. */
  private upload(file: Blob, name: string): Promise<UploadedMedia> {
    const key = `${name}:${file.size}:${file instanceof File ? file.lastModified : ''}`;
    const cached = this.uploads.get(key);
    if (cached) return cached;

    const upload = (async () => {
      this.sending.set({ name, progress: 0 });
      try {
        const asFile = file instanceof File && file.name === name ? file : new File([file], name, { type: file.type });
        const uploaded = await this.fileService.uploadFileInChunks(asFile, progress => this.sending.set({ name, progress }));
        return { url: uploaded.url, filename: uploaded.filename || name };
      } finally {
        this.sending.set(null);
      }
    })();
    this.uploads.set(key, upload);
    upload.catch(() => this.uploads.delete(key));
    return upload;
  }
}

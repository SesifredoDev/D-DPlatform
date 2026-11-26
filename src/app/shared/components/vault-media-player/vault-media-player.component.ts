import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import { ObsidianVaultService } from '../../services/ObsidianVault/obsidian-vault-service';
import { getVaultDisplayName } from '../../services/ObsidianVault/vault-file-types';
import { MediaKind, MediaPlaybackService, mediaKindOf } from '../../services/media/media-playback.service';

let nextPlayerId = 1;

/**
 * An audio or video file from the vault: opened as a file, or embedded in a note
 * (`![[Tavern theme.mp3]]`). It plays here, and **Play on call** plays it for everyone on the
 * call instead. If it's still playing when you open another note, it carries on in the
 * background player (bottom left) from the same moment.
 */
@Component({
  selector: 'app-vault-media-player',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './vault-media-player.component.html',
  styleUrl: './vault-media-player.component.scss',
})
export class VaultMediaPlayerComponent implements OnChanges, OnDestroy {
  @Input() serverId = '';
  @Input() path = '';
  @Input() name = '';
  /** 'page' when the file is open; 'embed' inside a note. */
  @Input() mode: 'page' | 'embed' = 'page';

  @ViewChild('media') mediaRef?: ElementRef<HTMLMediaElement>;

  readonly media = inject(MediaPlaybackService);
  private readonly vaultService = inject(ObsidianVaultService);
  private readonly playerId = `vault-media-${nextPlayerId++}`;

  url = '';
  kind: MediaKind = 'audio';
  error = '';
  status = '';
  statusIsError = false;
  sendingToCall = false;
  private blob: Blob | null = null;
  private loadId = 0;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private readonly sub: Subscription;

  constructor() {
    this.sub = this.media.playing$.subscribe(id => {
      if (id !== this.playerId) this.mediaRef?.nativeElement.pause();
    });
  }

  get title(): string {
    return getVaultDisplayName(this.name || this.path.split('/').pop() || '');
  }

  get callConnected(): boolean {
    return this.media.isCallConnected();
  }

  get callLabel(): string {
    return this.media.callActionLabel(this.kind);
  }

  get callHint(): string {
    if (!this.callConnected) return 'Join a call to play this for everyone';
    if (this.kind === 'video') return 'Show this video to everyone on the call (you control it)';
    return this.media.canControlCallAudio()
      ? 'Play this through the call’s music player for everyone'
      : 'Send this to the DM’s music requests';
  }

  /** Upload progress while this file is being sent to the call. */
  get uploadProgress(): number | null {
    const sending = this.media.sending();
    return this.sendingToCall && sending ? sending.progress : null;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['path'] || changes['serverId']) void this.load();
  }

  ngOnDestroy(): void {
    this.loadId++;
    this.sub.unsubscribe();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    const element = this.mediaRef?.nativeElement;
    // Still playing: carry on in the background player.
    if (element && this.blob && !element.paused && !element.ended) {
      this.media.playLocal(this.blob, this.title, this.kind, element.currentTime);
    }
    this.releaseUrl();
  }

  onPlay(): void {
    this.media.notifyPlaying(this.playerId);
    // The background player was playing this same file: this one takes over.
    if (this.media.local()?.name === this.title) this.media.stopLocal();
  }

  async playOnCall(): Promise<void> {
    if (!this.blob || this.sendingToCall || !this.callConnected) return;
    const element = this.mediaRef?.nativeElement;
    const startAt = element && !element.ended ? element.currentTime : 0;
    this.sendingToCall = true;
    this.setStatus('');
    try {
      const result = await this.media.playOnCall(this.blob, this.name || this.title, this.kind, startAt);
      element?.pause();
      this.setStatus(result === 'requested' ? 'Sent to the DM’s requests' : 'Playing on the call', false, 4000);
    } catch (error) {
      console.warn('[VaultMedia] Play on call failed', error);
      this.setStatus(error instanceof Error && error.message ? error.message : 'Couldn’t play this on the call.', true, 6000);
    } finally {
      this.sendingToCall = false;
    }
  }

  private async load(): Promise<void> {
    const id = ++this.loadId;
    this.error = '';
    this.releaseUrl();
    this.kind = mediaKindOf(this.name || this.path) ?? 'audio';
    if (!this.serverId || !this.path) return;
    try {
      const blob = await this.vaultService.readFileAsBlob(this.serverId, this.path);
      if (id !== this.loadId) return;
      this.kind = mediaKindOf(this.name || this.path, blob.type) ?? this.kind;
      this.blob = blob;
      this.url = URL.createObjectURL(blob);
    } catch (error) {
      console.warn('[VaultMedia] Failed to load', this.path, error);
      if (id === this.loadId) this.error = 'This file couldn’t be read from the vault.';
    }
  }

  onMediaError(): void {
    this.error = this.kind === 'video'
      ? 'This browser can’t play this video format. Try MP4 (H.264) or WebM.'
      : 'This browser can’t play this audio format. Try MP3, OGG or WAV.';
  }

  private setStatus(text: string, isError = false, clearAfterMs = 0): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.status = text;
    this.statusIsError = isError;
    if (clearAfterMs) this.statusTimer = setTimeout(() => (this.status = ''), clearAfterMs);
  }

  private releaseUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
    this.blob = null;
  }
}

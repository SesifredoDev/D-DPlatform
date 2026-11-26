import { Component, ElementRef, OnDestroy, ViewChild, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import { LocalMedia, MediaPlaybackService } from '../../services/media/media-playback.service';

const PLAYER_ID = 'media-mini-player';

/**
 * Bottom-left player for music and video playing just on this device: a vault file that was
 * still playing when you opened another note, or a broadcast played "just for me". It can be
 * sent to the call from here too.
 */
@Component({
  selector: 'app-media-mini-player',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './media-mini-player.component.html',
  styleUrl: './media-mini-player.component.scss',
})
export class MediaMiniPlayerComponent implements OnDestroy {
  readonly media = inject(MediaPlaybackService);
  @ViewChild('player') playerRef?: ElementRef<HTMLMediaElement>;

  status = '';
  statusIsError = false;
  sendingToCall = false;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private readonly sub: Subscription;

  constructor() {
    this.sub = this.media.playing$.subscribe(id => {
      if (id !== PLAYER_ID) this.playerRef?.nativeElement.pause();
    });
  }

  get callConnected(): boolean {
    return this.media.isCallConnected();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  /** Starts where the page left off. */
  onLoaded(item: LocalMedia): void {
    const element = this.playerRef?.nativeElement;
    if (!element) return;
    if (item.startAt > 0 && Math.abs(element.currentTime - item.startAt) > 0.5) element.currentTime = item.startAt;
    void element.play().catch(() => {
      // Autoplay blocked: leave it paused with its controls showing.
    });
  }

  onPlay(): void {
    this.media.notifyPlaying(PLAYER_ID);
  }

  close(): void {
    this.status = '';
    this.media.stopLocal();
  }

  async playOnCall(item: LocalMedia): Promise<void> {
    if (!item.file || this.sendingToCall) return;
    const element = this.playerRef?.nativeElement;
    const startAt = element && !element.ended ? element.currentTime : 0;
    this.sendingToCall = true;
    try {
      const result = await this.media.playOnCall(item.file, item.name, item.kind, startAt);
      if (result === 'requested') {
        this.setStatus('Sent to the DM’s requests', false);
      } else {
        // The call plays it now.
        this.media.stopLocal();
      }
    } catch (error) {
      this.setStatus(error instanceof Error && error.message ? error.message : 'Couldn’t play this on the call.', true);
    } finally {
      this.sendingToCall = false;
    }
  }

  uploadLabel(): string | null {
    const sending = this.media.sending();
    return this.sendingToCall && sending ? `Sending ${sending.progress}%` : null;
  }

  private setStatus(text: string, isError: boolean): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.status = text;
    this.statusIsError = isError;
    this.statusTimer = setTimeout(() => (this.status = ''), 5000);
  }
}

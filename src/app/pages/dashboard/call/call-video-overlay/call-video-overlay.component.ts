import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { OverlayVideoState, Video } from '../../../../shared/services/video/video';
import { BroadcastScale } from '../call-broadcast-scale';
import { BroadcastResizeHandleComponent, BroadcastScaleControlsComponent } from '../call-broadcast-scale.component';

/** How far (seconds) a viewer can drift from whoever controls the video before being moved. */
const DRIFT_SECONDS = 1.2;

/**
 * A video shown to everyone on the call. Whoever started it controls it: their play, pause and
 * seeking are sent to everyone, and late joiners start at the same moment. Everyone else watches
 * in step (with their own volume) and can hide it just for themselves.
 */
@Component({
  selector: 'app-call-video-overlay',
  standalone: true,
  imports: [MatIconModule, BroadcastScaleControlsComponent, BroadcastResizeHandleComponent],
  template: `
    <div
      class="call-video glass call-overlay-content"
      [class.is-resizing]="scale.resizing"
      [style.--broadcast-scale]="scale.value">
      <div class="call-video-toolbar">
        <mat-icon class="call-video-glyph" aria-hidden="true">movie</mat-icon>
        <div class="call-video-label">
          <strong [title]="state.name">{{ state.name }}</strong>
          <span>{{ isController ? 'Playing for everyone on the call. You control it.' : 'Played for the call' }}</span>
        </div>
        <app-broadcast-scale-controls [scale]="scale" label="Video" />
        @if (isController) {
          <button type="button" class="call-video-btn is-stop" (click)="stop.emit()">
            <mat-icon>stop</mat-icon>
            <span>Stop for everyone</span>
          </button>
        }
        <button type="button" class="call-video-btn" (click)="dismiss.emit()" [attr.aria-label]="isController ? 'Hide (keeps playing for everyone else)' : 'Hide video'">
          <mat-icon>close</mat-icon>
          <span>Hide</span>
        </button>
      </div>
      <div class="call-video-stage">
        <video
          #video
          [src]="state.url"
          [controls]="true"
          playsinline
          (loadedmetadata)="apply()"
          (play)="onLocalChange()"
          (pause)="onLocalChange()"
          (seeked)="onLocalChange()"
          (ended)="onLocalChange()"></video>
        @if (needsClick) {
          <button type="button" class="call-video-start" (click)="startAfterClick()">
            <mat-icon>play_arrow</mat-icon>
            <span>Click to watch with the call</span>
          </button>
        }
      </div>
      <app-broadcast-resize-handle [scale]="scale" label="Video" />
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .call-video {
      position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr);
      width: calc(100% * var(--broadcast-scale, 1)); max-height: 100%; overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1); border-radius: var(--radius-l, 14px);
      background: rgba(30, 31, 34, 0.6); box-shadow: 0 40px 100px rgba(0, 0, 0, 0.8);
    }
    .call-video-toolbar {
      display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.09); background: rgba(0, 0, 0, 0.28);
    }
    .call-video-glyph { flex: none; color: var(--primary, #7289da); }
    .call-video-label { display: grid; flex: 1; min-width: 0; }
    .call-video-label strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .call-video-label span { color: rgba(255, 255, 255, 0.6); font-size: 0.8rem; }
    .call-video-btn {
      display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; background: rgba(255, 255, 255, 0.06);
      color: inherit; font: inherit; font-size: 0.85rem; white-space: nowrap; cursor: pointer;
    }
    .call-video-btn:hover { background: rgba(255, 255, 255, 0.12); }
    .call-video-btn:focus-visible { outline: 2px solid var(--primary, #7289da); outline-offset: 2px; }
    .call-video-btn.is-stop { border-color: rgba(255, 122, 122, 0.4); color: #ffb3b3; }
    .call-video-btn mat-icon { width: 18px; height: 18px; font-size: 18px; }
    /* The strip under the video holds the resize handle, clear of the video's own controls. */
    .call-video-stage { position: relative; display: grid; place-items: center; min-height: 0; padding-bottom: 22px; background: #000; }
    .call-video-stage video { display: block; width: 100%; max-height: calc((85vh - 60px) * var(--broadcast-scale, 1)); background: #000; object-fit: contain; }
    .call-video.is-resizing { user-select: none; }
    .call-video.is-resizing video { pointer-events: none; }
    .call-video-start {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px;
      border: 0; background: rgba(0, 0, 0, 0.55); color: #fff; font: inherit; font-size: 1rem; cursor: pointer;
    }
    @media (max-width: 640px) { .call-video-btn span { display: none; } }
  `],
})
export class CallVideoOverlayComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) state!: OverlayVideoState;
  @Input() isController = false;
  @Output() dismiss = new EventEmitter<void>();
  @Output() stop = new EventEmitter<void>();
  @ViewChild('video') videoRef?: ElementRef<HTMLVideoElement>;

  needsClick = false;
  /** How big the video shows (each viewer's own, remembered on this device). */
  readonly scale = new BroadcastScale('video');
  private readonly videoService = inject(Video);
  /** Set while this component moves the video itself, so those events aren't sent back out. */
  private applying = false;
  private applyingTimer?: ReturnType<typeof setTimeout>;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['state']) queueMicrotask(() => this.apply());
  }

  ngOnDestroy(): void {
    if (this.applyingTimer) clearTimeout(this.applyingTimer);
  }

  /** Brings the video in line with the shared state. */
  apply(): void {
    const element = this.videoRef?.nativeElement;
    if (!element || !this.state || element.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const target = this.targetTime();
    this.applying = true;
    if (this.applyingTimer) clearTimeout(this.applyingTimer);
    if (Math.abs(element.currentTime - target) > DRIFT_SECONDS) element.currentTime = target;
    if (this.state.playing && element.paused) {
      element.play().then(() => (this.needsClick = false)).catch(() => (this.needsClick = true));
    } else if (!this.state.playing && !element.paused) {
      element.pause();
    }
    this.applyingTimer = setTimeout(() => (this.applying = false), 500);
  }

  /** The controller played, paused or moved the video: tell everyone. */
  onLocalChange(): void {
    const element = this.videoRef?.nativeElement;
    if (!this.isController || this.applying || !element) return;
    const playing = !element.paused && !element.ended;
    const sameState = playing === this.state.playing && Math.abs(this.targetTime() - element.currentTime) < 0.5;
    if (sameState) return;
    this.videoService.broadcastOverlayVideo({ url: this.state.url, name: this.state.name, playing, time: element.currentTime });
  }

  startAfterClick(): void {
    this.needsClick = false;
    this.apply();
  }

  private targetTime(): number {
    const elapsed = this.state.playing ? (Date.now() - this.state.receivedAt) / 1000 : 0;
    const target = this.state.time + elapsed;
    const duration = this.videoRef?.nativeElement.duration;
    return duration && Number.isFinite(duration) ? Math.min(target, duration) : target;
  }
}

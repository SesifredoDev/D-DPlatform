import { ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import {
  CallLivestreamService,
  type CallLivestreamRuntimeState,
  type CallLivestreamSettings,
  type CallLivestreamSourceSnapshot
} from './call-livestream.service';
import type { CallLivestreamMusicState } from './call-livestream-compositor';
import {
  SoundCloudService,
  type SoundCloudLivestreamOutputCaptureState
} from '../../../shared/services/playlist/soundcloud.service';

@Component({
  selector: 'app-call-livestream-manager',
  standalone: true,
  imports: [FormsModule, NgIf, MatIconModule],
  templateUrl: './call-livestream-manager.html',
  styleUrl: './call-livestream-manager.scss'
})
export class CallLivestreamManager implements OnInit, OnDestroy {
  @Input() channelId = '';

  @ViewChild('livestreamPreviewVideo') set livestreamPreviewVideo(value: ElementRef<HTMLVideoElement> | undefined) {
    this.previewVideoRef = value;
    this.syncPreviewVideo();
  }

  settings!: CallLivestreamSettings;
  runtime!: CallLivestreamRuntimeState;
  source: CallLivestreamSourceSnapshot | null = null;
  musicOutputCaptureState!: SoundCloudLivestreamOutputCaptureState;

  private previewVideoRef?: ElementRef<HTMLVideoElement>;
  private readonly subscriptions = new Subscription();
  private sourceRefreshTimer = 0;

  constructor(
    public livestream: CallLivestreamService,
    private soundCloud: SoundCloudService,
    private cdr: ChangeDetectorRef
  ) {
    this.settings = this.livestream.settings$.value;
    this.runtime = this.livestream.state$.value;
    this.source = this.livestream.source$.value;
    this.musicOutputCaptureState = this.soundCloud.livestreamOutputCaptureState$.value;
  }

  ngOnInit() {
    this.subscriptions.add(this.livestream.settings$.subscribe(settings => {
      this.settings = settings;
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.livestream.state$.subscribe(runtime => {
      this.runtime = runtime;
      this.syncPreviewVideo();
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.livestream.source$.subscribe(source => {
      this.source = source;
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.soundCloud.livestreamOutputCaptureState$.subscribe(state => {
      this.musicOutputCaptureState = state;
      this.livestream.refreshFrameSource(this.channelId || undefined);
      this.cdr.detectChanges();
    }));

    void this.livestream.refreshAvailability();
    this.livestream.refreshFrameSource(this.channelId || undefined);
    this.startSourceRefreshTimer();
  }

  ngOnDestroy() {
    this.stopSourceRefreshTimer();
    this.subscriptions.unsubscribe();
    if (this.previewVideoRef?.nativeElement) {
      this.previewVideoRef.nativeElement.srcObject = null;
    }
  }

  get hasLivestreamOutput(): boolean {
    return !!this.runtime.outputStream;
  }

  get canStart(): boolean {
    return this.livestream.canStart(this.channelId);
  }

  get statusText(): string {
    return this.livestream.getStatusText(this.channelId);
  }

  get hasMatchingCallSource(): boolean {
    return !!this.source && (!this.channelId || this.source.channelId === this.channelId);
  }

  get participantCount(): number {
    return this.hasMatchingCallSource ? this.source?.participants.length ?? 0 : 0;
  }

  get resolutionOptions() {
    return this.livestream.resolutionOptions;
  }

  get isCustomResolution(): boolean {
    return this.settings.resolutionPreset === 'custom';
  }

  get outputPresetLabel(): string {
    return this.livestream.outputPresetLabel;
  }

  get outputSizeLabel(): string {
    return this.livestream.outputSizeLabel;
  }

  get obsMediaSourceUrl(): string {
    return this.livestream.obsMediaSourceUrl;
  }

  get outputAspectRatio(): string {
    const { width, height } = this.livestream.outputDimensions;
    return `${width} / ${height}`;
  }

  get canTriggerIntro(): boolean {
    return this.livestream.canTriggerIntro();
  }

  get introStatusText(): string {
    if (this.runtime.introError) {
      return this.runtime.introError;
    }

    if (this.runtime.introStatus) {
      return this.runtime.introStatus;
    }

    if (this.settings.introVideoFileName) {
      return `Local intro ready: ${this.settings.introVideoFileName}`;
    }

    return this.settings.introVideoUrl.trim()
      ? 'Web intro ready'
      : 'Choose a local video file or paste a browser-playable video URL.';
  }

  get introProgressLabel(): string {
    if (!this.runtime.introDurationMs) {
      return this.formatDuration(this.runtime.introPositionMs);
    }

    return `${this.formatDuration(this.runtime.introPositionMs)} / ${this.formatDuration(this.runtime.introDurationMs)}`;
  }

  get musicState(): CallLivestreamMusicState | null {
    return this.hasMatchingCallSource ? this.source?.music ?? null : null;
  }

  get hasMusicState(): boolean {
    return !!this.musicState;
  }

  get musicTitle(): string {
    return this.musicState?.title || 'No music source';
  }

  get musicArtist(): string {
    const music = this.musicState;
    if (!music) {
      return 'Start playback in the call music player.';
    }

    return music.artist || (music.paused ? 'Paused' : 'Now playing');
  }

  get musicTrackCount(): number {
    return this.musicState?.audioStream?.getAudioTracks()
      .filter(track => track.readyState === 'live' && track.enabled)
      .length ?? 0;
  }

  get hasMusicAudioTrack(): boolean {
    return this.musicTrackCount > 0;
  }

  get canUseMusicOutputCapture(): boolean {
    return !!navigator.mediaDevices?.getDisplayMedia;
  }

  get isMusicUsingOutputCapture(): boolean {
    return this.musicState?.captureSource === 'output-capture';
  }

  get musicOutputCaptureLabel(): string {
    if (!this.canUseMusicOutputCapture) {
      return 'Unavailable';
    }

    if (this.musicOutputCaptureState.error) {
      return 'Needs attention';
    }

    if (this.musicOutputCaptureState.active) {
      return `${this.musicOutputCaptureState.trackCount} audio track${this.musicOutputCaptureState.trackCount === 1 ? '' : 's'}`;
    }

    return 'Auto on output start';
  }

  get musicStatusIcon(): string {
    const music = this.musicState;
    if (!music) {
      return 'music_off';
    }

    if (music.paused) {
      return 'pause_circle';
    }

    if (this.hasMusicAudioTrack) {
      return 'graphic_eq';
    }

    return music.canCaptureAudio ? 'volume_off' : 'visibility';
  }

  get musicStatusText(): string {
    const music = this.musicState;
    if (!music) {
      return 'No player state';
    }

    if (music.paused) {
      return 'Music paused';
    }

    if (this.hasMusicAudioTrack) {
      if (this.isMusicUsingOutputCapture) {
        return 'Output capture active';
      }

      return 'Audio track detected';
    }

    if (music.canCaptureAudio) {
      return 'Capture source has no live tracks';
    }

    return 'Visual only';
  }

  get musicCaptureDetail(): string {
    const music = this.musicState;
    if (!music) {
      return 'The manager will show the current track, capture state, and output mix once playback is active.';
    }

    if (music.paused) {
      return 'The track is paused, so no music audio is currently being sent to the output mix.';
    }

    if (this.hasMusicAudioTrack) {
      if (this.isMusicUsingOutputCapture) {
        return 'The OBS output is using the browser audio capture fallback. The output mix slider scales that captured music without applying the player volume a second time.';
      }

      return 'A live audio track is available to the compositor. The output mix slider below scales it without changing local playback volume.';
    }

    if (music.canCaptureAudio) {
      return 'The player reported a capturable source, but it currently has no live enabled audio tracks.';
    }

    if (!this.canUseMusicOutputCapture) {
      return 'The player source is not exposing capturable audio, and browser audio capture is unavailable in this environment.';
    }

    if (this.musicOutputCaptureState.error) {
      return this.musicOutputCaptureState.error;
    }

    return 'The SoundCloud widget is visual only to the compositor. Starting the OBS media feed will ask for an audio source automatically; choose a source that includes the music audio.';
  }

  get musicLocalVolumePercent(): number {
    return this.normalizeNumber(this.musicState?.volumePercent ?? 0, 0, 200, 0);
  }

  get musicStreamVolumePercent(): number {
    return this.settings.musicVolumePercent;
  }

  get musicEffectiveVolumePercent(): number {
    if (this.musicState?.audioStreamIsPostVolume) {
      return this.musicStreamVolumePercent;
    }

    return this.livestream.getStreamMusicVolumePercent(this.musicLocalVolumePercent);
  }

  setResolutionPreset(value: string) {
    this.livestream.setResolutionPreset(value);
  }

  setOutputWidth(value: number | string) {
    this.livestream.setOutputWidth(value);
  }

  setOutputHeight(value: number | string) {
    this.livestream.setOutputHeight(value);
  }

  setFrameRate(value: number | string) {
    this.livestream.updateSettings({
      frameRate: this.normalizeNumber(value, 15, 60, 30)
    });
  }

  setIntroVideoUrl(value: string) {
    this.livestream.setIntroVideoUrl(value);
  }

  onIntroVideoFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) {
      return;
    }

    this.livestream.setIntroVideoFile(file);
    input.value = '';
  }

  setIntroFadeMs(value: number | string) {
    this.livestream.setIntroFadeMs(value);
  }

  setIntroVolumePercent(value: number | string) {
    this.livestream.setIntroVolumePercent(value);
  }

  setMusicVolumePercent(value: number | string) {
    this.livestream.setMusicVolumePercent(value);
  }

  async startMusicOutputCapture() {
    await this.soundCloud.startLivestreamOutputCapture();
    this.livestream.refreshFrameSource(this.channelId || undefined);
  }

  stopMusicOutputCapture() {
    this.soundCloud.stopLivestreamOutputCapture();
    this.livestream.refreshFrameSource(this.channelId || undefined);
  }

  async triggerIntro() {
    await this.livestream.triggerIntro();
  }

  endIntro() {
    this.livestream.endIntro();
  }

  async start() {
    await this.livestream.start(this.channelId);
  }

  async stop() {
    await this.livestream.stop();
  }

  private syncPreviewVideo() {
    const video = this.previewVideoRef?.nativeElement;
    if (!video) {
      return;
    }

    if (video.srcObject !== this.runtime.outputStream) {
      video.srcObject = this.runtime.outputStream;
    }

    if (this.runtime.outputStream) {
      void video.play().catch(() => undefined);
    }
  }

  private startSourceRefreshTimer() {
    this.stopSourceRefreshTimer();
    this.sourceRefreshTimer = window.setInterval(() => {
      this.livestream.refreshFrameSource(this.channelId || undefined);
    }, 1000);
  }

  private stopSourceRefreshTimer() {
    if (!this.sourceRefreshTimer) {
      return;
    }

    window.clearInterval(this.sourceRefreshTimer);
    this.sourceRefreshTimer = 0;
  }

  private normalizeNumber(value: number | string, min: number, max: number, fallback: number): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(numberValue)));
  }

  private formatDuration(valueMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

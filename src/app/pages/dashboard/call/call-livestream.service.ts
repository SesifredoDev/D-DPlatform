import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ThemeService } from '../../../shared/services/theme/theme.service';
import { CallStreamingService } from '../../../shared/services/call-streaming/call-streaming';
import { SoundCloudService } from '../../../shared/services/playlist/soundcloud.service';
import { CallLivestreamCompositor } from './call-livestream-compositor';
import type {
  CallLivestreamFrameState,
  CallLivestreamIntroState,
  CallLivestreamMusicState
} from './call-livestream-compositor';

export type CallLivestreamDestination = 'youtube' | 'twitch' | 'custom';
export type CallLivestreamResolutionPreset = '480p' | '720p' | '1080p' | '1440p' | '2160p' | 'custom';
export type CallLivestreamIntroPhase = 'idle' | 'loading' | 'fading-out' | 'playing' | 'fading-in';

export interface CallLivestreamResolutionOption {
  preset: Exclude<CallLivestreamResolutionPreset, 'custom'>;
  label: string;
  width: number;
  height: number;
  recommendedVideoBitrateKbps: number;
  recommendedAudioBitrateKbps: number;
}

export const CALL_LIVESTREAM_RESOLUTION_OPTIONS: readonly CallLivestreamResolutionOption[] = [
  { preset: '480p', label: '480p', width: 854, height: 480, recommendedVideoBitrateKbps: 2500, recommendedAudioBitrateKbps: 128 },
  { preset: '720p', label: '720p', width: 1280, height: 720, recommendedVideoBitrateKbps: 4500, recommendedAudioBitrateKbps: 160 },
  { preset: '1080p', label: '1080p', width: 1920, height: 1080, recommendedVideoBitrateKbps: 6000, recommendedAudioBitrateKbps: 192 },
  { preset: '1440p', label: '1440p', width: 2560, height: 1440, recommendedVideoBitrateKbps: 9000, recommendedAudioBitrateKbps: 256 },
  { preset: '2160p', label: '4K UHD', width: 3840, height: 2160, recommendedVideoBitrateKbps: 12000, recommendedAudioBitrateKbps: 320 }
];

export interface CallLivestreamSettings {
  destination: CallLivestreamDestination;
  serverUrl: string;
  customUrl: string;
  streamKey: string;
  resolutionPreset: CallLivestreamResolutionPreset;
  outputWidth: number;
  outputHeight: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  frameRate: number;
  introVideoUrl: string;
  introVideoFileName: string;
  introFadeMs: number;
  introVolumePercent: number;
  musicVolumePercent: number;
}

export interface CallLivestreamRuntimeState {
  canUse: boolean;
  isLivestreaming: boolean;
  isStarting: boolean;
  isStopping: boolean;
  status: string;
  error: string;
  outputStream: MediaStream | null;
  isIntroPlaying: boolean;
  introPhase: CallLivestreamIntroPhase;
  introStatus: string;
  introError: string;
  introPositionMs: number;
  introDurationMs: number;
}

export interface CallLivestreamSourceSnapshot extends CallLivestreamFrameState {
  channelId: string;
  hasLiveCall: boolean;
  isPlaybackMode: boolean;
}

const DEFAULT_SETTINGS: CallLivestreamSettings = {
  destination: 'youtube',
  serverUrl: 'rtmps://a.rtmps.youtube.com/live2',
  customUrl: '',
  streamKey: '',
  resolutionPreset: '720p',
  outputWidth: 1280,
  outputHeight: 720,
  videoBitrateKbps: 4500,
  audioBitrateKbps: 160,
  frameRate: 30,
  introVideoUrl: '',
  introVideoFileName: '',
  introFadeMs: 1000,
  introVolumePercent: 100,
  musicVolumePercent: 100
};

const DEFAULT_RUNTIME_STATE: CallLivestreamRuntimeState = {
  canUse: false,
  isLivestreaming: false,
  isStarting: false,
  isStopping: false,
  status: '',
  error: '',
  outputStream: null,
  isIntroPlaying: false,
  introPhase: 'idle',
  introStatus: '',
  introError: '',
  introPositionMs: 0,
  introDurationMs: 0
};

@Injectable({ providedIn: 'root' })
export class CallLivestreamService {
  readonly resolutionOptions = CALL_LIVESTREAM_RESOLUTION_OPTIONS;
  readonly settings$ = new BehaviorSubject<CallLivestreamSettings>({ ...DEFAULT_SETTINGS });
  readonly state$ = new BehaviorSubject<CallLivestreamRuntimeState>({ ...DEFAULT_RUNTIME_STATE });
  readonly source$ = new BehaviorSubject<CallLivestreamSourceSnapshot | null>(null);

  private readonly compositor = new CallLivestreamCompositor();
  private sourceChannelId: string | null = null;
  private sourceFactory: (() => CallLivestreamSourceSnapshot) | null = null;
  private recorder: MediaRecorder | null = null;
  private sessionId = '';
  private chunkWriteChain: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;
  private hasReceivedStreamChunk = false;
  private hasWrittenStreamChunk = false;
  private recorderDataEventCount = 0;
  private recorderEmptyDataEventCount = 0;
  private firstChunkTimeout = 0;
  private recorderChunkPump = 0;
  private introVideoElement: HTMLVideoElement | null = null;
  private introAudioContext: AudioContext | null = null;
  private introAudioSource: MediaElementAudioSourceNode | null = null;
  private introAudioDestination: MediaStreamAudioDestinationNode | null = null;
  private introPhase: CallLivestreamIntroPhase = 'idle';
  private introPhaseStartedAtMs = 0;
  private introPhaseTimer = 0;
  private introVideoObjectUrl: string | null = null;

  constructor(
    private callStreaming: CallStreamingService,
    private soundCloud: SoundCloudService,
    private themeService: ThemeService
  ) {
    void this.refreshAvailability();
  }

  get stateSnapshot(): CallLivestreamRuntimeState {
    return this.state$.value;
  }

  setFrameSource(channelId: string, factory: () => CallLivestreamSourceSnapshot) {
    this.sourceChannelId = channelId;
    this.sourceFactory = factory;
    this.refreshFrameSource(channelId);
  }

  clearFrameSource(channelId: string) {
    if (this.sourceChannelId !== channelId) {
      return;
    }

    this.sourceChannelId = null;
    this.sourceFactory = null;
    this.source$.next(null);
  }

  refreshFrameSource(channelId?: string) {
    if (channelId && this.sourceChannelId !== channelId) {
      return;
    }

    this.source$.next(this.readSourceSnapshot());
  }

  async refreshAvailability(): Promise<boolean> {
    const canUse = typeof MediaRecorder !== 'undefined' &&
      (await this.callStreaming.isAvailable().catch(() => false));
    this.patchState({ canUse });
    return canUse;
  }

  canStart(channelId?: string): boolean {
    const state = this.state$.value;
    const source = this.readSourceSnapshot();
    return state.canUse &&
      !!source &&
      (!channelId || source.channelId === channelId) &&
      source.hasLiveCall &&
      !source.isPlaybackMode &&
      !state.isLivestreaming &&
      !state.isStarting &&
      !state.isStopping;
  }

  getStatusText(channelId?: string): string {
    const state = this.state$.value;
    if (state.error) {
      return state.error;
    }

    if (!state.canUse) {
      return 'Desktop app required';
    }

    if (state.isStarting) {
      return 'Starting live stream';
    }

    if (state.isStopping) {
      return 'Stopping live stream';
    }

    if (state.isLivestreaming) {
      const musicSuffix = this.hasUncapturableMusic(this.readSourceSnapshot())
        ? ' - music visual only'
        : '';
      return `Streaming ${this.outputSizeLabel}${musicSuffix}`;
    }

    const source = this.readSourceSnapshot();
    if (!source || (channelId && source.channelId !== channelId)) {
      return 'Open the live call before streaming';
    }

    if (source.isPlaybackMode) {
      return 'Live streaming only supports the live call';
    }

    if (!source.hasLiveCall) {
      return 'Join the call before streaming';
    }

    return 'Stream call';
  }

  updateSettings(patch: Partial<CallLivestreamSettings>) {
    this.settings$.next({
      ...this.settings$.value,
      ...patch
    });
  }

  setDestination(destination: CallLivestreamDestination) {
    const nextSettings: Partial<CallLivestreamSettings> = { destination };
    if (destination === 'youtube') {
      nextSettings.serverUrl = DEFAULT_SETTINGS.serverUrl;
    } else if (destination === 'twitch') {
      nextSettings.serverUrl = 'rtmp://live.twitch.tv/app';
    }

    this.updateSettings(nextSettings);
  }

  setResolutionPreset(preset: string) {
    const resolutionPreset = this.normalizeResolutionPreset(preset);
    const option = this.findResolutionOption(resolutionPreset);
    if (option) {
      this.updateSettings({
        resolutionPreset: option.preset,
        outputWidth: option.width,
        outputHeight: option.height,
        videoBitrateKbps: option.recommendedVideoBitrateKbps,
        audioBitrateKbps: option.recommendedAudioBitrateKbps
      });
      return;
    }

    const dimensions = this.outputDimensions;
    const recommendedBitrates = this.getRecommendedBitratesForDimensions(dimensions.width, dimensions.height);
    this.updateSettings({
      resolutionPreset: 'custom',
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
      ...recommendedBitrates
    });
  }

  setOutputWidth(value: number | string) {
    const outputWidth = this.normalizeEvenNumber(value, 640, 3840, this.outputDimensions.width);
    const outputHeight = this.outputDimensions.height;
    this.updateSettings({
      resolutionPreset: 'custom',
      outputWidth,
      outputHeight,
      ...this.getRecommendedBitratesForDimensions(outputWidth, outputHeight)
    });
  }

  setOutputHeight(value: number | string) {
    const outputWidth = this.outputDimensions.width;
    const outputHeight = this.normalizeEvenNumber(value, 360, 2160, this.outputDimensions.height);
    this.updateSettings({
      resolutionPreset: 'custom',
      outputWidth,
      outputHeight,
      ...this.getRecommendedBitratesForDimensions(outputWidth, outputHeight)
    });
  }

  setIntroVideoUrl(value: string) {
    this.revokeIntroVideoObjectUrl();
    this.updateSettings({
      introVideoUrl: value,
      introVideoFileName: ''
    });
    this.patchState({
      introError: '',
      introStatus: ''
    });
  }

  setIntroVideoFile(file: File) {
    this.revokeIntroVideoObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    this.introVideoObjectUrl = objectUrl;
    this.updateSettings({
      introVideoUrl: objectUrl,
      introVideoFileName: file.name
    });
    this.patchState({
      introError: '',
      introStatus: `Local intro selected: ${file.name}`
    });
  }

  setIntroFadeMs(value: number | string) {
    this.updateSettings({
      introFadeMs: this.normalizeNumber(value, 250, 5000, DEFAULT_SETTINGS.introFadeMs)
    });
  }

  setIntroVolumePercent(value: number | string) {
    this.updateSettings({
      introVolumePercent: this.normalizeNumber(value, 0, 200, DEFAULT_SETTINGS.introVolumePercent)
    });
  }

  setMusicVolumePercent(value: number | string) {
    this.updateSettings({
      musicVolumePercent: this.normalizeNumber(value, 0, 200, DEFAULT_SETTINGS.musicVolumePercent)
    });
  }

  getStreamMusicVolumePercent(localVolumePercent: number): number {
    return this.normalizeNumber(
      localVolumePercent * (this.settings$.value.musicVolumePercent / 100),
      0,
      200,
      DEFAULT_SETTINGS.musicVolumePercent
    );
  }

  canTriggerIntro(): boolean {
    const state = this.state$.value;
    return state.isLivestreaming &&
      !state.isStarting &&
      !state.isStopping &&
      !state.isIntroPlaying &&
      !!this.settings$.value.introVideoUrl.trim();
  }

  async triggerIntro() {
    if (this.state$.value.isIntroPlaying) {
      return;
    }

    if (!this.state$.value.isLivestreaming) {
      this.patchState({ introError: 'Start the livestream before triggering an intro.' });
      return;
    }

    const introVideoUrl = this.settings$.value.introVideoUrl.trim();
    if (!introVideoUrl) {
      this.patchState({ introError: 'Enter an intro video URL.' });
      return;
    }

    this.cleanupIntro(false);
    this.setIntroPhase('loading', 'Loading intro video');
    this.patchState({
      isIntroPlaying: true,
      introError: '',
      introPositionMs: 0,
      introDurationMs: 0
    });

    try {
      const video = this.createIntroVideoElement(introVideoUrl);
      this.introVideoElement = video;
      this.setupIntroAudioCapture(video);
      await this.waitForIntroVideoReady(video);
      video.currentTime = 0;
      await this.introAudioContext?.resume().catch(() => undefined);
      await video.play();
      this.updateIntroProgress();
      this.setIntroPhase('fading-out', 'Playing intro');
      this.scheduleIntroPhase(() => this.setIntroPhase('playing', 'Intro playing'), this.getIntroFadeMs());
    } catch (error) {
      console.warn('Failed to play livestream intro video', error);
      this.cleanupIntro(false);
      this.patchState({
        isIntroPlaying: false,
        introPhase: 'idle',
        introStatus: '',
        introError: error instanceof Error ? error.message : 'Could not play the intro video.'
      });
    }
  }

  endIntro() {
    if (!this.state$.value.isIntroPlaying || this.introPhase === 'idle' || this.introPhase === 'fading-in') {
      return;
    }

    if (this.introPhase === 'loading') {
      this.cleanupIntro(false);
      this.patchState({
        isIntroPlaying: false,
        introPhase: 'idle',
        introStatus: 'Intro cancelled',
        introPositionMs: 0,
        introDurationMs: 0
      });
      return;
    }

    this.beginIntroReturn('Returning to call');
  }

  async start(channelId?: string) {
    const currentState = this.state$.value;
    if (currentState.isLivestreaming || currentState.isStarting) {
      return;
    }

    this.patchState({ error: '', status: '' });
    try {
      this.compositor.primeAudioContext();
    } catch (error) {
      this.patchState({
        error: error instanceof Error ? error.message : 'Audio mixing is unavailable.'
      });
      return;
    }

    const initialSource = this.readSourceSnapshot();
    if (!initialSource || (channelId && initialSource.channelId !== channelId)) {
      this.compositor.stop();
      this.patchState({ error: 'Open the live call before streaming.' });
      return;
    }

    if (!initialSource.hasLiveCall) {
      this.compositor.stop();
      this.patchState({ error: 'Join the call before streaming.' });
      return;
    }

    if (initialSource.isPlaybackMode) {
      this.compositor.stop();
      this.patchState({ error: 'Live streaming only supports the live call.' });
      return;
    }

    if (this.state$.value.canUse) {
      const hasMusicCapture = await this.ensureMusicCaptureForStart(initialSource);
      if (!hasMusicCapture) {
        this.compositor.stop();
        return;
      }
    }

    await this.refreshAvailability();

    if (!this.state$.value.canUse) {
      this.compositor.stop();
      this.patchState({ error: 'Live streaming requires the Tauri desktop app.' });
      return;
    }

    const source = this.readSourceSnapshot();
    if (!source || (channelId && source.channelId !== channelId)) {
      this.compositor.stop();
      this.patchState({ error: 'Open the live call before streaming.' });
      return;
    }

    if (!source.hasLiveCall) {
      this.compositor.stop();
      this.patchState({ error: 'Join the call before streaming.' });
      return;
    }

    if (source.isPlaybackMode) {
      this.compositor.stop();
      this.patchState({ error: 'Live streaming only supports the live call.' });
      return;
    }

    const rtmpUrl = this.getRtmpUrl();
    if (!rtmpUrl) {
      this.compositor.stop();
      return;
    }

    const mimeType = this.getSupportedMimeType();
    if (!mimeType) {
      this.compositor.stop();
      this.patchState({ error: 'This browser cannot encode the livestream feed.' });
      return;
    }

    const sessionId = this.createSessionId();
    this.sessionId = sessionId;
    this.hasReceivedStreamChunk = false;
    this.hasWrittenStreamChunk = false;
    this.recorderDataEventCount = 0;
    this.recorderEmptyDataEventCount = 0;
    this.patchState({ isStarting: true });

    try {
      const settings = this.settings$.value;
      const frameRate = this.normalizeNumber(settings.frameRate, 15, 60, DEFAULT_SETTINGS.frameRate);
      const outputDimensions = this.getOutputDimensions(settings);
      const videoBitrateKbps = this.normalizeNumber(settings.videoBitrateKbps, 800, 12000, DEFAULT_SETTINGS.videoBitrateKbps);
      const audioBitrateKbps = this.normalizeNumber(settings.audioBitrateKbps, 64, 320, DEFAULT_SETTINGS.audioBitrateKbps);
      const outputStream = this.compositor.start(
        () => this.createFrameStateForRender(),
        {
          width: outputDimensions.width,
          height: outputDimensions.height,
          frameRate
        }
      );
      this.patchState({ outputStream });
      this.compositor.requestFrame();

      await this.callStreaming.start({
        sessionId,
        rtmpUrls: [rtmpUrl],
        width: outputDimensions.width,
        height: outputDimensions.height,
        frameRate,
        videoBitrateKbps,
        audioBitrateKbps
      });

      const recorder = new MediaRecorder(outputStream, {
        mimeType,
        videoBitsPerSecond: videoBitrateKbps * 1000,
        audioBitsPerSecond: audioBitrateKbps * 1000
      });
      recorder.ondataavailable = event => {
        this.recorderDataEventCount += 1;
        if (event.data.size > 0) {
          if (!this.hasReceivedStreamChunk) {
            this.hasReceivedStreamChunk = true;
            this.clearFirstChunkTimeout();
            this.patchState({ status: `Encoder produced data; forwarding to ${this.destinationLabel}` });
          }
          this.queueChunk(sessionId, event.data);
          return;
        }

        this.recorderEmptyDataEventCount += 1;
      };
      recorder.onerror = event => {
        console.error('Call livestream recorder error', event);
        const recorderError = (event as Event & { error?: unknown }).error;
        void this.fail(this.getErrorMessage(recorderError, 'Live stream encoder failed.'));
      };
      recorder.start();

      this.recorder = recorder;
      this.patchState({
        isLivestreaming: true,
        status: `Connecting to ${this.destinationLabel} ingest`
      });
      this.startRecorderChunkPump(sessionId, frameRate);
      this.scheduleFirstChunkTimeout(sessionId);
    } catch (error) {
      console.error('Failed to start call livestream', error);
      this.patchState({
        error: this.getErrorMessage(error, 'Could not start live stream.')
      });
      await this.cleanup(sessionId);
    } finally {
      this.patchState({ isStarting: false });
    }
  }

  async stop() {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  get destinationLabel(): string {
    const destination = this.settings$.value.destination;
    if (destination === 'youtube') return 'YouTube';
    if (destination === 'twitch') return 'Twitch';
    return 'Custom';
  }

  get outputDimensions(): { width: number; height: number } {
    return this.getOutputDimensions(this.settings$.value);
  }

  get outputPresetLabel(): string {
    const settings = this.settings$.value;
    const option = this.findResolutionOption(settings.resolutionPreset);
    return option?.label ?? 'Custom';
  }

  get outputSizeLabel(): string {
    const { width, height } = this.outputDimensions;
    return `${width}x${height}`;
  }

  get serverUrlLabel(): string {
    return this.settings$.value.destination === 'custom' ? 'RTMP URL' : 'Server URL';
  }

  get activeServerUrl(): string {
    const settings = this.settings$.value;
    return settings.destination === 'custom' ? settings.customUrl : settings.serverUrl;
  }

  setActiveServerUrl(value: string) {
    if (this.settings$.value.destination === 'custom') {
      this.updateSettings({ customUrl: value });
      return;
    }

    this.updateSettings({ serverUrl: value });
  }

  private createIntroVideoElement(url: string): HTMLVideoElement {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.playsInline = true;
    video.controls = false;
    video.loop = false;
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.top = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';

    video.addEventListener('ended', () => this.beginIntroReturn('Returning to call'));
    video.addEventListener('timeupdate', () => this.updateIntroProgress());
    video.addEventListener('durationchange', () => this.updateIntroProgress());
    video.addEventListener('error', () => {
      this.handleIntroPlaybackError('The intro video could not be played.');
    });

    video.src = url;
    document.body.appendChild(video);
    video.load();
    return video;
  }

  private setupIntroAudioCapture(video: HTMLVideoElement) {
    const AudioContextConstructor = this.getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return;
    }

    try {
      this.introAudioContext = new AudioContextConstructor();
      this.introAudioSource = this.introAudioContext.createMediaElementSource(video);
      this.introAudioDestination = this.introAudioContext.createMediaStreamDestination();
      this.introAudioSource.connect(this.introAudioDestination);
    } catch (error) {
      console.warn('Failed to capture livestream intro audio', error);
      this.introAudioContext = null;
      this.introAudioSource = null;
      this.introAudioDestination = null;
    }
  }

  private waitForIntroVideoReady(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let timeout = 0;
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadeddata', handleReady);
        video.removeEventListener('canplay', handleReady);
        video.removeEventListener('error', handleError);
      };
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('The intro video could not be loaded.'));
      };

      video.addEventListener('loadeddata', handleReady);
      video.addEventListener('canplay', handleReady);
      video.addEventListener('error', handleError);
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out loading the intro video.'));
      }, 12000);
    });
  }

  private getIntroFrameState(): CallLivestreamIntroState | null {
    const videoElement = this.introVideoElement;
    if (!videoElement || this.introPhase === 'idle' || this.introPhase === 'loading') {
      return null;
    }

    const fadeMs = this.getIntroFadeMs();
    const elapsedMs = Math.max(0, performance.now() - this.introPhaseStartedAtMs);
    const progress = fadeMs <= 0 ? 1 : Math.max(0, Math.min(1, elapsedMs / fadeMs));
    const introBaseVolume = this.getIntroVolumePercent();
    let callOpacity = 1;
    let introOpacity = 0;

    if (this.introPhase === 'fading-out') {
      callOpacity = 1 - progress;
      introOpacity = progress;
    } else if (this.introPhase === 'playing') {
      callOpacity = 0;
      introOpacity = 1;
    } else if (this.introPhase === 'fading-in') {
      callOpacity = progress;
      introOpacity = 1 - progress;
    }

    return {
      videoElement,
      audioStream: this.introAudioDestination?.stream ?? null,
      callOpacity,
      introOpacity,
      callVolumePercent: Math.round(callOpacity * 100),
      introVolumePercent: Math.round(introBaseVolume * introOpacity)
    };
  }

  private setIntroPhase(phase: CallLivestreamIntroPhase, status: string) {
    this.clearIntroPhaseTimer();
    this.introPhase = phase;
    this.introPhaseStartedAtMs = performance.now();
    this.patchState({
      introPhase: phase,
      introStatus: status,
      isIntroPlaying: phase !== 'idle'
    });
  }

  private scheduleIntroPhase(callback: () => void, delayMs: number) {
    this.clearIntroPhaseTimer();
    this.introPhaseTimer = window.setTimeout(() => {
      this.introPhaseTimer = 0;
      callback();
    }, Math.max(0, delayMs));
  }

  private beginIntroReturn(status: string) {
    if (this.introPhase === 'idle' || this.introPhase === 'fading-in') {
      return;
    }

    this.setIntroPhase('fading-in', status);
    this.scheduleIntroPhase(() => this.finishIntro(), this.getIntroFadeMs());
  }

  private finishIntro() {
    this.cleanupIntro(false);
    this.patchState({
      isIntroPlaying: false,
      introPhase: 'idle',
      introStatus: 'Intro complete',
      introPositionMs: 0,
      introDurationMs: 0
    });
  }

  private handleIntroPlaybackError(message: string) {
    if (!this.state$.value.isIntroPlaying || this.introPhase === 'idle') {
      return;
    }

    this.patchState({ introError: message });
    if (this.introPhase === 'loading') {
      this.cleanupIntro(false);
      this.patchState({
        isIntroPlaying: false,
        introPhase: 'idle',
        introStatus: ''
      });
      return;
    }

    this.beginIntroReturn('Returning to call');
  }

  private updateIntroProgress() {
    const video = this.introVideoElement;
    if (!video) {
      return;
    }

    const positionMs = Number.isFinite(video.currentTime) ? Math.max(0, Math.round(video.currentTime * 1000)) : 0;
    const durationMs = Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration * 1000)) : 0;
    this.patchState({
      introPositionMs: positionMs,
      introDurationMs: durationMs
    });
  }

  private cleanupIntro(patchState: boolean = true) {
    this.clearIntroPhaseTimer();
    this.introPhase = 'idle';
    this.introPhaseStartedAtMs = 0;

    if (this.introVideoElement) {
      this.introVideoElement.pause();
      this.introVideoElement.removeAttribute('src');
      this.introVideoElement.load();
      this.introVideoElement.remove();
    }

    try {
      this.introAudioSource?.disconnect();
      this.introAudioDestination?.disconnect();
    } catch {
      // Audio nodes may already be detached when the stream is stopped mid-transition.
    }
    void this.introAudioContext?.close().catch(() => undefined);
    this.introVideoElement = null;
    this.introAudioContext = null;
    this.introAudioSource = null;
    this.introAudioDestination = null;

    if (patchState) {
      this.patchState({
        isIntroPlaying: false,
        introPhase: 'idle',
        introStatus: '',
        introPositionMs: 0,
        introDurationMs: 0
      });
    }
  }

  private revokeIntroVideoObjectUrl() {
    if (!this.introVideoObjectUrl) {
      return;
    }

    URL.revokeObjectURL(this.introVideoObjectUrl);
    this.introVideoObjectUrl = null;
  }

  private clearIntroPhaseTimer() {
    if (!this.introPhaseTimer) {
      return;
    }

    window.clearTimeout(this.introPhaseTimer);
    this.introPhaseTimer = 0;
  }

  private getIntroFadeMs(): number {
    return this.normalizeNumber(this.settings$.value.introFadeMs, 250, 5000, DEFAULT_SETTINGS.introFadeMs);
  }

  private getIntroVolumePercent(): number {
    return this.normalizeNumber(this.settings$.value.introVolumePercent, 0, 200, DEFAULT_SETTINGS.introVolumePercent);
  }

  private getAudioContextConstructor(): typeof AudioContext | null {
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
  }

  private hasUncapturableMusic(source: CallLivestreamSourceSnapshot | null): boolean {
    const music = source?.music;
    return !!music && !music.paused && !music.canCaptureAudio;
  }

  private readSourceSnapshot(): CallLivestreamSourceSnapshot | null {
    if (!this.sourceFactory) {
      return null;
    }

    try {
      return this.sourceFactory();
    } catch (error) {
      console.warn('Failed to read call livestream source state', error);
      return null;
    }
  }

  private createFrameStateForRender(): CallLivestreamFrameState {
    const source = this.readSourceSnapshot();
    if (source) {
      return {
        theme: source.theme,
        temporaryAtmosphereBackground: source.temporaryAtmosphereBackground,
        participants: source.participants,
        music: this.applyMusicStreamSettings(source.music),
        intro: this.getIntroFrameState(),
        isSceneMainLayoutActive: source.isSceneMainLayoutActive
      };
    }

    return {
      theme: this.themeService.getColors(),
      temporaryAtmosphereBackground: null,
      participants: [],
      music: null,
      intro: this.getIntroFrameState(),
      isSceneMainLayoutActive: false
    };
  }

  private applyMusicStreamSettings(music: CallLivestreamMusicState | null): CallLivestreamMusicState | null {
    if (!music) {
      return null;
    }

    const volumePercent = music.audioStreamIsPostVolume
      ? this.normalizeNumber(
        this.settings$.value.musicVolumePercent,
        0,
        200,
        DEFAULT_SETTINGS.musicVolumePercent
      )
      : this.getStreamMusicVolumePercent(music.volumePercent);

    return {
      ...music,
      volumePercent
    };
  }

  private async ensureMusicCaptureForStart(source: CallLivestreamSourceSnapshot): Promise<boolean> {
    const music = source.music;
    if (!music || music.paused || this.hasLiveAudioTracks(music.audioStream)) {
      return true;
    }

    if (music.canCaptureAudio) {
      return true;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.patchState({
        error: 'Music is playing, but this Tauri WebView cannot request app audio capture.'
      });
      return false;
    }

    this.patchState({
      status: 'Choose a source that includes the music audio.'
    });

    const captured = await this.soundCloud.startLivestreamOutputCapture();
    this.refreshFrameSource(source.channelId);
    const refreshedSource = this.readSourceSnapshot();
    const refreshedMusic = refreshedSource?.music ?? null;
    if (captured && this.hasLiveAudioTracks(refreshedMusic?.audioStream ?? null)) {
      this.patchState({ status: '' });
      return true;
    }

    const captureError = this.soundCloud.livestreamOutputCaptureState$.value.error;
    this.patchState({
      status: '',
      error: captureError || 'Music audio capture is required before starting the stream.'
    });
    return false;
  }

  private hasLiveAudioTracks(stream: MediaStream | null): boolean {
    return !!stream?.getAudioTracks()
      .some(track => track.readyState === 'live' && track.enabled);
  }

  private queueChunk(sessionId: string, blob: Blob) {
    this.chunkWriteChain = this.chunkWriteChain
      .catch(() => undefined)
      .then(() => this.withTimeout(
        this.callStreaming.writeChunk(sessionId, blob),
        15000,
        `Timed out writing stream data to ffmpeg. ${this.getRecorderDiagnostics()}`
      ))
      .then(() => {
        if (this.sessionId !== sessionId) {
          return;
        }

        if (!this.hasWrittenStreamChunk) {
          this.hasWrittenStreamChunk = true;
          this.clearFirstChunkTimeout();
          this.patchState({ status: `Sending stream data to ${this.destinationLabel}` });
        }
      })
      .catch(error => {
        console.error('Failed to write call livestream chunk', error);
        if (this.sessionId === sessionId && this.state$.value.isLivestreaming) {
          void this.fail(this.getErrorMessage(error, 'Live stream connection failed.'));
        }
      });
  }

  private async fail(message: string) {
    this.patchState({ error: message });
    await this.stop();
  }

  private async stopInternal() {
    if (!this.state$.value.isLivestreaming && !this.state$.value.isStarting && !this.sessionId) {
      this.cleanupOutput();
      return;
    }

    const sessionId = this.sessionId;
    this.patchState({ isStopping: true });

    const recorder = this.recorder;
    this.recorder = null;
    this.stopRecorderChunkPump();
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>(resolve => {
        const timeout = window.setTimeout(resolve, 2000);
        recorder.onstop = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        try {
          recorder.stop();
        } catch {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    }

    await this.chunkWriteChain.catch(() => undefined);
    await this.cleanup(sessionId);
    this.patchState({ status: this.state$.value.error ? '' : 'Live stream stopped' });
  }

  private async cleanup(sessionId: string | null = this.sessionId) {
    this.clearFirstChunkTimeout();
    this.stopRecorderChunkPump();
    if (sessionId) {
      await this.callStreaming.stop(sessionId).catch(error => {
        console.warn('Failed to stop call livestream process', error);
      });
    }

    this.cleanupOutput();
    this.sessionId = '';
    this.hasReceivedStreamChunk = false;
    this.hasWrittenStreamChunk = false;
    this.recorderDataEventCount = 0;
    this.recorderEmptyDataEventCount = 0;
    this.chunkWriteChain = Promise.resolve();
    this.patchState({
      isLivestreaming: false,
      isStarting: false,
      isStopping: false
    });
  }

  private cleanupOutput() {
    this.cleanupIntro();
    this.compositor.stop();
    this.patchState({ outputStream: null });
  }

  private getRtmpUrl(): string | null {
    const settings = this.settings$.value;
    const serverUrl = this.activeServerUrl.trim();
    const streamKey = settings.streamKey.trim();

    if (!serverUrl) {
      this.patchState({ error: 'Enter an RTMP server URL.' });
      return null;
    }

    if (!/^rtmps?:\/\//i.test(serverUrl)) {
      this.patchState({ error: 'The stream URL must start with rtmp:// or rtmps://.' });
      return null;
    }

    if (/\s/.test(serverUrl) || /\s/.test(streamKey)) {
      this.patchState({ error: 'The stream URL and key cannot contain whitespace.' });
      return null;
    }

    if (settings.destination !== 'custom' && !streamKey) {
      this.patchState({ error: `Enter your ${this.destinationLabel} stream key.` });
      return null;
    }

    if (!streamKey) {
      return serverUrl;
    }

    return `${serverUrl.replace(/\/+$/, '')}/${streamKey}`;
  }

  private getSupportedMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return null;
    }

    return [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ].find(type => MediaRecorder.isTypeSupported(type)) ?? null;
  }

  private getOutputDimensions(settings: CallLivestreamSettings): { width: number; height: number } {
    const option = this.findResolutionOption(settings.resolutionPreset);
    if (option) {
      return {
        width: option.width,
        height: option.height
      };
    }

    return {
      width: this.normalizeEvenNumber(settings.outputWidth, 640, 3840, DEFAULT_SETTINGS.outputWidth),
      height: this.normalizeEvenNumber(settings.outputHeight, 360, 2160, DEFAULT_SETTINGS.outputHeight)
    };
  }

  private getRecommendedBitratesForDimensions(
    width: number,
    height: number
  ): Pick<CallLivestreamSettings, 'videoBitrateKbps' | 'audioBitrateKbps'> {
    const pixels = width * height;
    const option = CALL_LIVESTREAM_RESOLUTION_OPTIONS.find(resolution => {
      return pixels <= resolution.width * resolution.height;
    }) ?? CALL_LIVESTREAM_RESOLUTION_OPTIONS[CALL_LIVESTREAM_RESOLUTION_OPTIONS.length - 1];

    return {
      videoBitrateKbps: option.recommendedVideoBitrateKbps,
      audioBitrateKbps: option.recommendedAudioBitrateKbps
    };
  }

  private normalizeResolutionPreset(value: string): CallLivestreamResolutionPreset {
    if (value === 'custom') {
      return 'custom';
    }

    return CALL_LIVESTREAM_RESOLUTION_OPTIONS.find(option => option.preset === value)?.preset ??
      DEFAULT_SETTINGS.resolutionPreset;
  }

  private findResolutionOption(
    preset: CallLivestreamResolutionPreset
  ): CallLivestreamResolutionOption | undefined {
    if (preset === 'custom') {
      return undefined;
    }

    return CALL_LIVESTREAM_RESOLUTION_OPTIONS.find(option => option.preset === preset);
  }

  private normalizeNumber(value: number | string, min: number, max: number, fallback: number): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(numberValue)));
  }

  private normalizeEvenNumber(value: number | string, min: number, max: number, fallback: number): number {
    const normalized = this.normalizeNumber(value, min, max, fallback);
    return normalized % 2 === 0 ? normalized : Math.min(max, normalized + 1);
  }

  private createSessionId(): string {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return `callstream-${Date.now()}-${randomPart}`;
  }

  private scheduleFirstChunkTimeout(sessionId: string) {
    this.clearFirstChunkTimeout();
    this.firstChunkTimeout = window.setTimeout(() => {
      this.firstChunkTimeout = 0;
      if (
        this.sessionId === sessionId &&
        this.state$.value.isLivestreaming &&
        !this.hasReceivedStreamChunk
      ) {
        void this.fail(`Live stream encoder did not produce any data. ${this.getRecorderDiagnostics()}`);
      }
    }, 12000);
  }

  private startRecorderChunkPump(sessionId: string, frameRate: number) {
    this.stopRecorderChunkPump();
    const intervalMs = Math.max(250, Math.min(1000, Math.round(1000 / Math.max(1, frameRate)) * 6));
    this.recorderChunkPump = window.setInterval(() => {
      if (this.sessionId !== sessionId) {
        this.stopRecorderChunkPump();
        return;
      }

      this.compositor.requestFrame();
      const recorder = this.recorder;
      if (!recorder || recorder.state !== 'recording') {
        return;
      }

      try {
        recorder.requestData();
      } catch (error) {
        console.warn('Failed to request livestream recorder data', error);
      }
    }, intervalMs);
  }

  private stopRecorderChunkPump() {
    if (!this.recorderChunkPump) {
      return;
    }

    window.clearInterval(this.recorderChunkPump);
    this.recorderChunkPump = 0;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      promise
        .then(resolve, reject)
        .finally(() => window.clearTimeout(timeout));
    });
  }

  private clearFirstChunkTimeout() {
    if (!this.firstChunkTimeout) {
      return;
    }

    window.clearTimeout(this.firstChunkTimeout);
    this.firstChunkTimeout = 0;
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
      return error;
    }

    return fallback;
  }

  private getRecorderDiagnostics(): string {
    const recorderState = this.recorder?.state ?? 'none';
    const tracks = this.state$.value.outputStream?.getTracks()
      .map(track => {
        const muted = 'muted' in track ? ` muted=${track.muted}` : '';
        return `${track.kind}:${track.readyState}:enabled=${track.enabled}${muted}`;
      })
      .join(', ') || 'no tracks';
    return `Recorder state: ${recorderState}; data events: ${this.recorderDataEventCount}; empty events: ${this.recorderEmptyDataEventCount}; tracks: ${tracks}.`;
  }

  private patchState(patch: Partial<CallLivestreamRuntimeState>) {
    this.state$.next({
      ...this.state$.value,
      ...patch
    });
  }
}

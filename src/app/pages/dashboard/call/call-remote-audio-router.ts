import type { RemoteAudioOutput } from '../../../shared/models/pages/dashboard/call/call.model';
import type { RemoteAudioTrack } from 'livekit-client';

export class CallRemoteAudioRouter {
  readonly supportsAudioOutputSelection =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  readonly supportsRemoteAudioGain =
    typeof window !== 'undefined' && !!this.getAudioContextConstructor();

  private remoteAudioContext: AudioContext | null = null;
  private readonly remoteAudioOutputs = new Map<string, RemoteAudioOutput>();
  private readonly audioOutputRequestTokens = new WeakMap<HTMLMediaElement, number>();
  private nextAudioOutputRequestToken = 0;
  private readonly audioOutputRetryDelayMs = 75;

  constructor(private readonly getSelectedOutputId: () => string) {}

  configureRemoteAudio(
    participantId: string,
    stream: MediaStream | null | undefined,
    volumePercent: number,
    video: HTMLVideoElement,
    remoteAudioTrack?: RemoteAudioTrack
  ) {
    const audioTrack = stream?.getAudioTracks()[0] || remoteAudioTrack?.mediaStreamTrack || null;
    if (!audioTrack) {
      this.teardownRemoteAudioOutput(participantId);
      return;
    }

    if (!this.supportsRemoteAudioGain || !stream) {
      if (this.configureLiveKitRemoteAudioOutput(participantId, stream ?? undefined, audioTrack.id, volumePercent, video, remoteAudioTrack)) {
        video.muted = true;
        return;
      }

      this.applyNativeVideoVolume(video, volumePercent, false);
      this.teardownRemoteAudioOutput(participantId);
      return;
    }

    video.muted = true;

    const existingOutput = this.remoteAudioOutputs.get(participantId);
    if (
      existingOutput &&
      existingOutput.stream === stream &&
      existingOutput.audioTrackId === audioTrack.id &&
      (!existingOutput.remoteAudioTrack || existingOutput.remoteAudioTrack === remoteAudioTrack)
    ) {
      this.applyRemoteAudioOutputVolume(existingOutput, volumePercent);
      void this.playRemoteAudioElement(existingOutput.audioElement).then(played => {
        if (!played) {
          this.handleRemoteAudioPlaybackFailure(
            participantId,
            stream,
            audioTrack.id,
            volumePercent,
            video,
            remoteAudioTrack,
            existingOutput.audioElement
          );
        }
      });
      return;
    }

    this.teardownRemoteAudioOutput(participantId);

    const audioContext = this.getRemoteAudioContext();
    if (!audioContext) {
      this.applyNativeVideoVolume(video, volumePercent, false);
      return;
    }

    try {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      const audioElement = new Audio();

      gain.gain.value = volumePercent / 100;
      source.connect(gain);
      gain.connect(destination);

      audioElement.autoplay = true;
      audioElement.srcObject = destination.stream;
      audioElement.volume = 1;

      this.remoteAudioOutputs.set(participantId, {
        stream,
        audioTrackId: audioTrack.id,
        source,
        gain,
        destination,
        audioElement
      });

      void this.applyAudioOutputToMediaElement(audioElement);
      void this.playRemoteAudioElement(audioElement).then(played => {
        const currentOutput = this.remoteAudioOutputs.get(participantId);
        if (!played && currentOutput?.audioElement === audioElement) {
          this.handleRemoteAudioPlaybackFailure(
            participantId,
            stream,
            audioTrack.id,
            volumePercent,
            video,
            remoteAudioTrack,
            audioElement
          );
        }
      });
    } catch (error) {
      console.warn('Failed to create amplified remote audio output', error);
      this.teardownRemoteAudioOutput(participantId);
      if (this.configureLiveKitRemoteAudioOutput(participantId, stream, audioTrack.id, volumePercent, video, remoteAudioTrack)) {
        return;
      }

      this.applyNativeVideoVolume(video, volumePercent, false);
    }
  }

  applyRemoteVolume(participantId: string, volumePercent: number, video: HTMLVideoElement | null) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (output) {
      this.applyRemoteAudioOutputVolume(output, volumePercent);
      void this.playRemoteAudioElement(output.audioElement).then(played => {
        if (!played && video) {
          this.applyNativeVideoVolume(video, volumePercent, false);
        }
      });
    }

    if (video) {
      this.applyNativeVideoVolume(video, volumePercent, this.supportsRemoteAudioGain || !!output);
    }
  }

  teardownMissingRemoteAudioOutputs(activeParticipantIds: Set<string>) {
    Array.from(this.remoteAudioOutputs.keys()).forEach(participantId => {
      if (!activeParticipantIds.has(participantId)) {
        this.teardownRemoteAudioOutput(participantId);
      }
    });
  }

  teardownAllRemoteAudioOutputs() {
    Array.from(this.remoteAudioOutputs.keys()).forEach(participantId => {
      this.teardownRemoteAudioOutput(participantId);
    });

    if (this.remoteAudioContext && this.remoteAudioContext.state !== 'closed') {
      void this.remoteAudioContext.close().catch(() => undefined);
    }
    this.remoteAudioContext = null;
  }

  async applyAudioOutputToAllMedia(mediaElements: HTMLMediaElement[]) {
    if (!this.supportsAudioOutputSelection || !this.getSelectedOutputId()) {
      return;
    }

    const elements = [...mediaElements];
    this.remoteAudioOutputs.forEach(output => {
      elements.push(output.audioElement);
    });

    for (const element of elements) {
      await this.applyAudioOutputToMediaElement(element);
    }
  }

  async applyAudioOutputToMediaElement(element: HTMLMediaElement) {
    const outputId = this.getSelectedOutputId();
    if (!this.supportsAudioOutputSelection || !outputId) {
      return;
    }

    if (this.getElementSinkId(element) === outputId) {
      return;
    }

    const requestToken = ++this.nextAudioOutputRequestToken;
    this.audioOutputRequestTokens.set(element, requestToken);

    try {
      await element.setSinkId(outputId);
    } catch (error) {
      if (!this.isCurrentAudioOutputRequest(element, requestToken, outputId)) {
        return;
      }

      if (this.isDomExceptionName(error, 'AbortError')) {
        await this.retryAbortedAudioOutputChange(element, requestToken, outputId);
        return;
      }

      console.warn('Failed to switch audio output device', error);
    }
  }

  private async retryAbortedAudioOutputChange(
    element: HTMLMediaElement,
    requestToken: number,
    outputId: string
  ) {
    await new Promise(resolve => setTimeout(resolve, this.audioOutputRetryDelayMs));

    if (!this.isCurrentAudioOutputRequest(element, requestToken, outputId)) {
      return;
    }

    if (this.getElementSinkId(element) === outputId) {
      return;
    }

    try {
      await element.setSinkId(outputId);
    } catch (error) {
      if (!this.isCurrentAudioOutputRequest(element, requestToken, outputId)) {
        return;
      }

      if (this.isDomExceptionName(error, 'AbortError')) {
        console.debug('Audio output switch was aborted by the browser', error);
        return;
      }

      console.warn('Failed to switch audio output device', error);
    }
  }

  private isCurrentAudioOutputRequest(
    element: HTMLMediaElement,
    requestToken: number,
    outputId: string
  ): boolean {
    return (
      this.audioOutputRequestTokens.get(element) === requestToken &&
      this.getSelectedOutputId() === outputId
    );
  }

  private getElementSinkId(element: HTMLMediaElement): string {
    return (element as HTMLMediaElement & { sinkId?: string }).sinkId ?? '';
  }

  private isDomExceptionName(error: unknown, name: string): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === name;
  }

  private getRemoteAudioContext(): AudioContext | null {
    if (this.remoteAudioContext?.state === 'closed') {
      this.remoteAudioContext = null;
    }

    if (!this.remoteAudioContext) {
      const AudioContextConstructor = this.getAudioContextConstructor();
      if (!AudioContextConstructor) {
        return null;
      }

      this.remoteAudioContext = new AudioContextConstructor();
    }

    if (this.remoteAudioContext.state === 'suspended') {
      void this.remoteAudioContext.resume().catch(() => undefined);
    }

    return this.remoteAudioContext;
  }

  private async playRemoteAudioElement(audioElement: HTMLAudioElement): Promise<boolean> {
    try {
      if (this.remoteAudioContext?.state === 'suspended') {
        await this.remoteAudioContext.resume();
      }

      await audioElement.play();
      return true;
    } catch (error) {
      if (typeof error === 'object' && error && 'name' in error && error.name === 'AbortError') {
        return true;
      }

      return false;
    }
  }

  private configureLiveKitRemoteAudioOutput(
    participantId: string,
    stream: MediaStream | undefined,
    audioTrackId: string,
    volumePercent: number,
    video: HTMLVideoElement,
    remoteAudioTrack?: RemoteAudioTrack
  ): boolean {
    if (!remoteAudioTrack) {
      return false;
    }

    this.teardownRemoteAudioOutput(participantId);

    const audioElement = new Audio();
    audioElement.autoplay = true;
    audioElement.muted = false;
    remoteAudioTrack.attach(audioElement);

    const output: RemoteAudioOutput = {
      stream,
      audioTrackId,
      audioElement,
      remoteAudioTrack
    };
    this.applyRemoteAudioOutputVolume(output, volumePercent);
    this.remoteAudioOutputs.set(participantId, output);

    void this.applyAudioOutputToMediaElement(audioElement);
    void this.playRemoteAudioElement(audioElement).then(played => {
      const currentOutput = this.remoteAudioOutputs.get(participantId);
      if (!played && currentOutput?.audioElement === audioElement) {
        this.applyNativeVideoVolume(video, volumePercent, false);
      }
    });

    return true;
  }

  private handleRemoteAudioPlaybackFailure(
    participantId: string,
    stream: MediaStream,
    audioTrackId: string,
    volumePercent: number,
    video: HTMLVideoElement,
    remoteAudioTrack: RemoteAudioTrack | undefined,
    failedAudioElement: HTMLAudioElement
  ) {
    const currentOutput = this.remoteAudioOutputs.get(participantId);
    if (currentOutput?.audioElement !== failedAudioElement) {
      return;
    }

    if (!currentOutput.remoteAudioTrack && this.configureLiveKitRemoteAudioOutput(
      participantId,
      stream,
      audioTrackId,
      volumePercent,
      video,
      remoteAudioTrack
    )) {
      return;
    }

    this.applyNativeVideoVolume(video, volumePercent, false);
  }

  private applyRemoteAudioOutputVolume(output: RemoteAudioOutput, volumePercent: number) {
    if (output.gain) {
      output.gain.gain.value = volumePercent / 100;
      output.audioElement.volume = 1;
      return;
    }

    const nativeVolume = Math.min(1, volumePercent / 100);
    output.audioElement.volume = nativeVolume;
    output.remoteAudioTrack?.setVolume(nativeVolume);
  }

  private teardownRemoteAudioOutput(participantId: string) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (!output) {
      return;
    }

    output.source?.disconnect();
    output.gain?.disconnect();
    output.remoteAudioTrack?.detach(output.audioElement);
    output.audioElement.pause();
    output.audioElement.srcObject = null;
    output.destination?.stream.getTracks().forEach(track => track.stop());
    this.remoteAudioOutputs.delete(participantId);
  }

  private applyNativeVideoVolume(
    video: HTMLVideoElement,
    volumePercent: number,
    muted: boolean
  ) {
    video.muted = muted;
    video.volume = Math.min(1, volumePercent / 100);
  }

  private getAudioContextConstructor(): typeof AudioContext | null {
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
  }
}

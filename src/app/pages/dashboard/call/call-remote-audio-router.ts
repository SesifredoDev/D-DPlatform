import type { RemoteAudioOutput } from '../../../shared/models/pages/dashboard/call/call.model';

export class CallRemoteAudioRouter {
  readonly supportsAudioOutputSelection =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  readonly supportsRemoteAudioGain =
    typeof window !== 'undefined' && !!this.getAudioContextConstructor();

  private remoteAudioContext: AudioContext | null = null;
  private readonly remoteAudioOutputs = new Map<string, RemoteAudioOutput>();

  constructor(private readonly getSelectedOutputId: () => string) {}

  configureRemoteAudio(
    participantId: string,
    stream: MediaStream | null | undefined,
    volumePercent: number,
    video: HTMLVideoElement
  ) {
    if (!this.supportsRemoteAudioGain || !stream) {
      this.applyNativeVideoVolume(video, volumePercent, false);
      this.teardownRemoteAudioOutput(participantId);
      return;
    }

    video.muted = true;

    const audioTrack = stream.getAudioTracks()[0] || null;
    if (!audioTrack) {
      this.teardownRemoteAudioOutput(participantId);
      return;
    }

    const existingOutput = this.remoteAudioOutputs.get(participantId);
    if (existingOutput && existingOutput.stream === stream && existingOutput.audioTrackId === audioTrack.id) {
      existingOutput.gain.gain.value = volumePercent / 100;
      void this.playRemoteAudioElement(existingOutput.audioElement).then(played => {
        if (!played) {
          this.applyNativeVideoVolume(video, volumePercent, false);
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
          this.applyNativeVideoVolume(video, volumePercent, false);
        }
      });
    } catch (error) {
      console.warn('Failed to create amplified remote audio output', error);
      this.teardownRemoteAudioOutput(participantId);
      this.applyNativeVideoVolume(video, volumePercent, false);
    }
  }

  applyRemoteVolume(participantId: string, volumePercent: number, video: HTMLVideoElement | null) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (output) {
      output.gain.gain.value = volumePercent / 100;
      output.audioElement.volume = 1;
      void this.playRemoteAudioElement(output.audioElement).then(played => {
        if (!played && video) {
          this.applyNativeVideoVolume(video, volumePercent, false);
        }
      });
    }

    if (video) {
      this.applyNativeVideoVolume(video, volumePercent, this.supportsRemoteAudioGain);
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
    if (!this.supportsAudioOutputSelection || !this.getSelectedOutputId()) {
      return;
    }

    try {
      await element.setSinkId(this.getSelectedOutputId());
    } catch (error) {
      console.warn('Failed to switch audio output device', error);
    }
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
    } catch {
      return false;
    }
  }

  private teardownRemoteAudioOutput(participantId: string) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (!output) {
      return;
    }

    output.source.disconnect();
    output.gain.disconnect();
    output.audioElement.pause();
    output.audioElement.srcObject = null;
    output.destination.stream.getTracks().forEach(track => track.stop());
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

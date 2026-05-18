import type { CallParticipantActivityMonitor } from '../../../../shared/models/pages/dashboard/call/call-recording.workers.model';
import { getAudioContextConstructor } from './call-recording-media.utils';

export interface CallParticipantActivityMonitorOptions {
  audioRmsThreshold: number;
  videoMotionThreshold: number;
}

export function createParticipantActivityMonitor(
  stream: MediaStream,
  options: CallParticipantActivityMonitorOptions
): CallParticipantActivityMonitor | null {
  const audioTrack = stream.getAudioTracks().find(track => track.readyState === 'live') ?? null;
  const videoTrack = stream.getVideoTracks().find(track => track.readyState === 'live') ?? null;
  let audioContext: AudioContext | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let audioData: Uint8Array | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let canvasContext: CanvasRenderingContext2D | null = null;
  let previousFrame: Uint8ClampedArray | null = null;

  if (audioTrack) {
    const AudioContextConstructor = getAudioContextConstructor();
    if (AudioContextConstructor) {
      try {
        audioContext = new AudioContextConstructor();
        audioSource = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.75;
        audioData = new Uint8Array(analyser.fftSize);
        audioSource.connect(analyser);
        void audioContext.resume().catch(() => undefined);
      } catch {
        audioContext = null;
        audioSource = null;
        analyser = null;
        audioData = null;
      }
    }
  }

  if (videoTrack && typeof document !== 'undefined') {
    videoElement = document.createElement('video');
    videoElement.muted = true;
    videoElement.playsInline = true;
    videoElement.srcObject = new MediaStream([videoTrack]);
    canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 27;
    canvasContext = canvas.getContext('2d', { willReadFrequently: true });
    void videoElement.play().catch(() => undefined);
  }

  if (!analyser && !canvasContext) {
    return null;
  }

  const getAudioLevel = () => {
    if (!audioTrack || !analyser || !audioData || audioTrack.readyState !== 'live' || !audioTrack.enabled) {
      return 0;
    }

    analyser.getByteTimeDomainData(audioData as Uint8Array<ArrayBuffer>);
    let totalSquare = 0;
    for (const value of audioData) {
      const normalized = (value - 128) / 128;
      totalSquare += normalized * normalized;
    }

    return Math.sqrt(totalSquare / audioData.length);
  };

  const getVideoMotion = () => {
    if (
      !videoTrack ||
      !videoElement ||
      !canvas ||
      !canvasContext ||
      videoTrack.readyState !== 'live' ||
      videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !videoElement.videoWidth ||
      !videoElement.videoHeight
    ) {
      return 0;
    }

    try {
      canvasContext.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const frame = canvasContext.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!previousFrame) {
        previousFrame = new Uint8ClampedArray(frame);
        return 0;
      }

      let totalDifference = 0;
      for (let index = 0; index < frame.length; index += 4) {
        totalDifference += Math.abs(frame[index] - previousFrame[index]);
        totalDifference += Math.abs(frame[index + 1] - previousFrame[index + 1]);
        totalDifference += Math.abs(frame[index + 2] - previousFrame[index + 2]);
      }

      previousFrame.set(frame);
      return totalDifference / (canvas.width * canvas.height * 3);
    } catch {
      return 0;
    }
  };

  return {
    getSample: () => {
      const audioLevel = getAudioLevel();
      const videoMotion = getVideoMotion();
      return {
        audioLevel,
        videoMotion,
        active: audioLevel >= options.audioRmsThreshold ||
          videoMotion >= options.videoMotionThreshold
      };
    },
    cleanup: () => {
      audioSource?.disconnect();
      if (audioContext) {
        void audioContext.close().catch(() => undefined);
      }

      if (videoElement) {
        videoElement.pause();
        videoElement.srcObject = null;
        videoElement.remove();
      }
    }
  };
}

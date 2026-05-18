import type { MicTestRecordingWorkerOptions } from '../../../../shared/models/pages/dashboard/call/call-recording.workers.model';
import { getSupportedMicRecordingMimeType } from './call-recording-media.utils';

export class MicTestRecordingWorker {
  isRecording = false;
  durationSeconds = 0;
  playbackUrl: string | null = null;
  error = '';

  private recorder: MediaRecorder | null = null;
  private recorderStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private durationInterval: any;
  private autoStopTimeout: any;
  private discardOnStop = false;

  constructor(private readonly options: MicTestRecordingWorkerOptions) {}

  start() {
    if (this.isRecording) {
      return;
    }

    this.error = '';
    if (typeof MediaRecorder === 'undefined') {
      this.error = 'Mic test unsupported here';
      this.options.requestChangeDetection();
      return;
    }

    const track = this.options.getActiveMicTrack();
    if (!track || track.readyState !== 'live') {
      this.error = 'Microphone unavailable';
      this.options.requestChangeDetection();
      return;
    }

    if (!track.enabled) {
      this.error = 'Unmute microphone to test';
      this.options.requestChangeDetection();
      return;
    }

    this.clearSample();
    this.stop(true);
    this.discardOnStop = false;
    this.chunks = [];
    this.recorderStream = new MediaStream([track]);

    try {
      const mimeType = getSupportedMicRecordingMimeType();
      this.recorder = mimeType
        ? new MediaRecorder(this.recorderStream, { mimeType })
        : new MediaRecorder(this.recorderStream);
    } catch (error) {
      console.error('Failed to start mic test recorder', error);
      this.error = 'Mic test unavailable';
      this.cleanupRecorder();
      this.options.requestChangeDetection();
      return;
    }

    this.recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.recorder.onerror = event => {
      console.error('Mic test recorder error', event);
      this.error = 'Mic test failed';
      this.cleanupRecorder();
      this.options.requestChangeDetection();
    };

    this.recorder.onstop = () => {
      const discardSample = this.discardOnStop;
      const chunks = [...this.chunks];
      const mimeType = this.recorder?.mimeType || getSupportedMicRecordingMimeType() || 'audio/webm';

      this.cleanupRecorder();

      if (!discardSample) {
        if (chunks.length > 0) {
          this.playbackUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
          setTimeout(() => {
            void this.options.applyAudioOutput();
            const audioElement = this.options.getAudioElement();
            if (audioElement) {
              audioElement.load();
              void audioElement.play().catch(() => undefined);
            }
          });
        } else {
          this.error = 'No audio captured';
        }
      }

      this.options.requestChangeDetection();
    };

    try {
      this.recorder.start(250);
    } catch (error) {
      console.error('Failed to run mic test recorder', error);
      this.error = 'Mic test failed';
      this.cleanupRecorder();
      this.options.requestChangeDetection();
      return;
    }

    this.isRecording = true;
    this.durationSeconds = 0;
    const startedAt = Date.now();
    this.durationInterval = setInterval(() => {
      this.durationSeconds = Math.min(
        Math.ceil((Date.now() - startedAt) / 1000),
        Math.ceil(this.options.maxDurationMs / 1000)
      );
      this.options.requestChangeDetection();
    }, 200);
    this.autoStopTimeout = setTimeout(() => {
      this.stop();
    }, this.options.maxDurationMs);
    this.options.requestChangeDetection();
  }

  stop(discardSample: boolean = false) {
    if (!this.recorder) {
      return;
    }

    this.discardOnStop = this.discardOnStop || discardSample;
    this.clearTimers();
    if (this.recorder.state !== 'inactive') {
      this.recorder.stop();
    } else {
      this.cleanupRecorder();
      this.options.requestChangeDetection();
    }
  }

  clearSample() {
    const audioElement = this.options.getAudioElement();
    if (audioElement) {
      audioElement.pause();
      audioElement.removeAttribute('src');
      audioElement.load();
    }

    if (this.playbackUrl) {
      URL.revokeObjectURL(this.playbackUrl);
      this.playbackUrl = null;
    }
  }

  resetForCaptureChange() {
    this.error = '';
    this.stop(true);
    this.clearSample();
  }

  private clearTimers() {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    if (this.autoStopTimeout) {
      clearTimeout(this.autoStopTimeout);
      this.autoStopTimeout = null;
    }
  }

  private cleanupRecorder() {
    this.clearTimers();
    this.isRecording = false;
    this.durationSeconds = 0;
    this.chunks = [];
    this.recorder = null;
    this.recorderStream = null;
    this.discardOnStop = false;
  }
}

import type { CallRecordingParticipant } from '../../../video/video.model';
import type { SessionRecording } from '../../../session-recording/session-recording.model';

export interface MicTestRecordingWorkerOptions {
  maxDurationMs: number;
  getActiveMicTrack: () => MediaStreamTrack | null;
  getAudioElement: () => HTMLAudioElement | null;
  applyAudioOutput: () => Promise<void> | void;
  requestChangeDetection: () => void;
}

export interface CallParticipantActivitySample {
  audioLevel: number;
  videoMotion: number;
  active: boolean;
}

export interface CallParticipantActivityMonitor {
  getSample: () => CallParticipantActivitySample;
  cleanup: () => void;
}

export interface CallSessionRecordingWorkerOptions {
  getParticipants: () => CallRecordingParticipant[];
  getCallRoomId: () => string | null;
  isPlaybackMode: () => boolean;
  setError: (message: string) => void;
  onDurationChange: (durationSeconds: number) => void;
  onRecordingReady: (recording: SessionRecording, packagedAsAstral: boolean) => void;
  requestChangeDetection: () => void;
}

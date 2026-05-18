import type { CallParticipantMetadata, CallRecordingParticipant } from '../../../video/video.model';
import type { ICharacter } from '../../../user/character.model';
import type { SessionRecording } from '../../../session-recording/session-recording.model';

export interface MicTestRecordingWorkerOptions {
  maxDurationMs: number;
  getActiveMicTrack: () => MediaStreamTrack | null;
  getAudioElement: () => HTMLAudioElement | null;
  applyAudioOutput: () => Promise<void> | void;
  requestChangeDetection: () => void;
}

export type CallParticipantRecorderStopReason = 'final' | 'idle' | 'tracks-changed' | 'removed';

export interface CallParticipantActivitySample {
  audioLevel: number;
  videoMotion: number;
  active: boolean;
}

export interface CallParticipantActivityMonitor {
  getSample: () => CallParticipantActivitySample;
  cleanup: () => void;
}

export interface CallParticipantRecorder {
  participantId: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  volumePercent: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAtMs: number;
  stopping: boolean;
  astralSegmentIndex: number | null;
  astralFilePath: string | null;
  astralFileUrl: string | null;
  astralSize: number;
  astralWriteChain: Promise<void>;
  astralWriteFailed: boolean;
  stopReason: CallParticipantRecorderStopReason;
  idleMonitor: CallParticipantActivityMonitor | null;
  idleMonitorInterval: any;
  idleLastActivityAt: number;
  idleTransitionInProgress: boolean;
  pendingIdleStillFrame: Blob | null;
  pendingIdleStillMimeType: string | null;
}

export interface CallParticipantIdleState {
  participantId: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  volumePercent: number;
  stream: MediaStream;
  tracksSignature: string;
  startedAtMs: number;
  blob: Blob | null;
  mimeType: string;
  mediaUrl: string | null;
  mediaPath: string | null;
  size: number;
  activityMonitor: CallParticipantActivityMonitor | null;
  activityMonitorInterval: any;
  resuming: boolean;
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

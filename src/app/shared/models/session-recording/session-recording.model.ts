export type VttRecordingActionSource = 'local' | 'remote' | 'snapshot';

export type RecordedCallEnvironmentAction =
  | 'theme-sync'
  | 'overlay-image'
  | 'overlay-text'
  | 'temporary-atmosphere-background'
  | 'scene-main-characters'
  | 'participants'
  | 'dm-mode'
  | 'vtt-session'
  | 'spotify-state'
  | 'spotify-requests';

export interface RecordedVttAction {
  timeMs: number;
  action: string;
  data: any;
  source: VttRecordingActionSource;
}

export interface RecordedVttTimeline {
  roomId: string | null;
  initialState: any | null;
  actions: RecordedVttAction[];
}

export interface RecordedCallEnvironmentEvent {
  timeMs: number;
  action: RecordedCallEnvironmentAction;
  data: any;
}

export interface RecordedCallEnvironmentTimeline {
  initialState: any | null;
  events: RecordedCallEnvironmentEvent[];
}

export interface SessionRecordingMedia {
  blob?: Blob | null;
  storage: 'memory' | 'astral';
  mimeType: string;
  url: string;
  durationMs: number;
  size: number;
  path?: string | null;
}

export interface SessionRecordingParticipantMedia {
  participantId: string;
  isLocal: boolean;
  userData: any | null;
  participantMeta: any | null;
  volumePercent: number;
  startedAtMs: number;
  endedAtMs: number;
  media: SessionRecordingMedia;
}

export interface SessionRecordingParticipantMediaInput {
  participantId: string;
  isLocal: boolean;
  userData?: any | null;
  participantMeta?: any | null;
  volumePercent?: number;
  startedAtMs?: number;
}

export interface SessionRecording {
  id: string;
  callRoomId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  media: SessionRecordingMedia | null;
  participantMedia: SessionRecordingParticipantMedia[];
  package: SessionRecordingPackage | null;
  vtt: RecordedVttTimeline;
  callEnvironment: RecordedCallEnvironmentTimeline;
}

export interface SessionRecordingPackage {
  storage: 'astral';
  path: string;
  size: number;
  formatVersion: number;
  createdAt: string;
  originalPath?: string | null;
  originalSize?: number;
  optimizedAt?: string;
}

export interface SessionRecordingState {
  active: boolean;
  session: SessionRecording | null;
  elapsedMs: number;
}

export interface SessionPlaybackState {
  active: boolean;
  paused: boolean;
  recording: SessionRecording | null;
  currentTimeMs: number;
  durationMs: number;
}

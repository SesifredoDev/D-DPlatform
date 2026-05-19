import type { CallParticipantMetadata, CompanionSourceId, ParticipantMediaDiagnostics, RemoteVideoQualityPreference } from '../../../video/video.model';
import type { ICharacter } from '../../../user/character.model';
import type { ThemeColors } from '../../../theme/theme.service.model';
import type { SessionRecordingParticipantMedia } from '../../../session-recording/session-recording.model';
import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';

export interface ParticipantStream {
  id: string;
  stream?: MediaStream;
  stillFrameUrl?: string;
  userData?: ICharacter;
  participantMeta?: CallParticipantMetadata | null;
  remoteAudioTrack?: RemoteAudioTrack;
  remoteVideoTrack?: RemoteVideoTrack;
  ping?: number;
  isLocal?: boolean;
  diagnostics?: ParticipantMediaDiagnostics;
  volumePercent: number;
  isSceneMainCharacter: boolean;
}

export interface VttStopEvent {
  roomId: string;
  endSession: boolean;
}

export interface VttPlaybackEvent {
  roomId: string;
  active: boolean;
}

export interface VttSessionState {
  active: boolean;
  roomId: string | null;
  hostId: string | null;
}

export type MicrophoneProcessingMode = 'studio' | 'processed';

export type RemoteVideoQualityLevel = 0 | 1 | 2;

export interface StoredCallMediaPreferences {
  selectedVideoId?: string;
  selectedAudioId?: string;
  selectedOutputId?: string;
  microphoneProcessingMode?: MicrophoneProcessingMode;
  remoteVideoQualityPreference?: RemoteVideoQualityPreference;
  selectedPcVideoSource?: CompanionSourceId;
  selectedPcAudioSource?: CompanionSourceId;
  isPreviewMuted?: boolean;
  isPreviewVideoOff?: boolean;
  experimentalMobile1080pEnabled?: boolean;
}

export interface RemoteAudioOutput {
  stream?: MediaStream;
  audioTrackId: string;
  source?: MediaStreamAudioSourceNode;
  gain?: GainNode;
  destination?: MediaStreamAudioDestinationNode;
  audioElement: HTMLAudioElement;
  remoteAudioTrack?: RemoteAudioTrack;
}

export interface RemoteContextMenuState {
  remoteId: string;
  x: number;
  y: number;
}

export interface PriorityGridPlacement {
  row: number;
  column: number;
  columnSpan: number;
}

export interface CallPlaybackSource {
  participant: SessionRecordingParticipantMedia;
  video: HTMLVideoElement;
  stream: MediaStream | null;
  cleanup: Array<() => void>;
  active: boolean;
  ended: boolean;
}

export interface RecordedCallParticipantSnapshot {
  id: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  ping?: number;
  volumePercent: number;
  isSceneMainCharacter: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface RecordedSpotifyState {
  uri: string | null;
  name: string;
  artist: string;
  image: string;
  position: number;
  playing: boolean;
  paused: boolean;
  contextUri: string | null;
  shuffle: boolean;
  volumePercent: number;
}

export interface RecordedCallEnvironmentState {
  activeColors: ThemeColors;
  activeOverlayImage: string | null;
  activeOverlayText: string | null;
  activeTemporaryAtmosphereBackground: string | null;
  sceneMainCharacterIds: string[];
  isDmMode: boolean;
  vttSession: VttSessionState;
  spotify: RecordedSpotifyState | null;
  spotifyRequests: any[];
  participants: RecordedCallParticipantSnapshot[];
}

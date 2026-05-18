import type { ConnectionQuality } from 'livekit-client';
import type { DeviceInfo } from '../device/device.model';

export type CallDeviceRole = 'desktop-main' | 'phone-camera';

export type CompanionSourceId = 'desktop-local' | string;

export type RemoteVideoQualityPreference = 'low' | 'medium' | 'high';

export type ParticipantVolumeMap = Record<string, number>;

export interface SceneMainCharacterState {
  participantIds: string[];
  updatedAt: number;
  updatedBy?: string;
}

export interface CallParticipantMetadata {
  userId: string;
  deviceId: string;
  deviceType: DeviceInfo['deviceType'];
  deviceRole: CallDeviceRole;
  character: any;
  selectedVideoSource?: CompanionSourceId;
  selectedAudioSource?: CompanionSourceId;
  sceneMainCharacters?: SceneMainCharacterState;
}

export interface CompanionDeviceOption {
  identity: string;
  deviceId: string;
  deviceType: DeviceInfo['deviceType'];
  label: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface MediaTrackDiagnostics {
  kind: 'audio' | 'video';
  bitrateKbps: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
  enabled: boolean;
  muted: boolean;
}

export interface ParticipantMediaDiagnostics {
  connectionQuality: ConnectionQuality;
  connectionState: string;
  rttMs: number | null;
  audio?: MediaTrackDiagnostics;
  video?: MediaTrackDiagnostics;
}

export interface CallRecordingParticipant {
  id: string;
  stream?: MediaStream;
  userData?: any;
  participantMeta?: CallParticipantMetadata | null;
  isLocal: boolean;
  volumePercent: number;
}

export interface LiveKitConnectionInfo {
  token: string;
  iceServers?: RTCIceServer[];
}

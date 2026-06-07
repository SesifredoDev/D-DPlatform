import type {
  CompanionSourceId,
  MobileCallJoinMode,
  RemoteVideoQualityPreference
} from '../../../shared/models/video/video.model';
import type { DeviceType } from '../../../shared/models/device/device.model';
import type {
  MicrophoneProcessingMode,
  RemoteVideoQualityLevel,
  StoredCallMediaPreferences
} from '../../../shared/models/pages/dashboard/call/call.model';
import {
  CALL_AUDIO_CONSTRAINTS,
  CALL_MEDIA_PREFERENCES_STORAGE_KEY,
  CALL_REMOTE_VIDEO_QUALITY_OPTIONS,
  CALL_VIDEO_CONSTRAINTS
} from './call.constants';

export interface CallMediaConstraintOptions {
  isMobileBrowser: boolean;
  experimentalMobile1080pEnabled: boolean;
  selectedVideoId: string;
  selectedAudioId: string;
  microphoneProcessingMode: MicrophoneProcessingMode;
}

export function buildCallMediaConstraints(options: CallMediaConstraintOptions): MediaStreamConstraints {
  return {
    video: buildCallVideoConstraints(options),
    audio: buildCallAudioConstraints(options)
  };
}

export function readStoredCallMediaPreferences(): Partial<StoredCallMediaPreferences> | null {
  const storage = getPreferenceStorage();
  if (!storage) {
    return null;
  }

  const value = storage.getItem(CALL_MEDIA_PREFERENCES_STORAGE_KEY);
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredCallMediaPreferences(preferences: Partial<StoredCallMediaPreferences>) {
  const storage = getPreferenceStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(CALL_MEDIA_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.warn('Failed to persist call media preferences', error);
  }
}

export function resolveAvailableDeviceId(devices: MediaDeviceInfo[], selectedDeviceId: string): string {
  if (!devices.length) {
    return '';
  }

  return selectedDeviceId && devices.some(device => device.deviceId === selectedDeviceId)
    ? selectedDeviceId
    : devices[0].deviceId;
}

export function isMicrophoneProcessingMode(value: unknown): value is MicrophoneProcessingMode {
  return value === 'studio' || value === 'processed';
}

export function isRemoteVideoQualityPreference(value: unknown): value is RemoteVideoQualityPreference {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function isMobileCallJoinMode(value: unknown): value is MobileCallJoinMode {
  return value === 'caller' || value === 'companion';
}

export function normalizeRemoteVideoQualityLevel(value: unknown): RemoteVideoQualityLevel {
  const numericValue = typeof value === 'string' ? Number(value) : value;
  if (numericValue === 0 || numericValue === 1 || numericValue === 2) {
    return numericValue;
  }

  return 1;
}

export function getRemoteVideoQualityPreference(
  remoteVideoQualityLevel: unknown
): RemoteVideoQualityPreference {
  const level = normalizeRemoteVideoQualityLevel(remoteVideoQualityLevel);
  return CALL_REMOTE_VIDEO_QUALITY_OPTIONS[level]?.value ?? 'medium';
}

export function parseDeviceTypeParam(value: string | null | undefined): DeviceType | null {
  if (value === 'desktop' || value === 'mobile' || value === 'tablet' || value === 'unknown') {
    return value;
  }

  return null;
}

export function preferenceToRemoteVideoQualityLevel(
  preference: RemoteVideoQualityPreference
): RemoteVideoQualityLevel {
  switch (preference) {
    case 'low':
      return 0;
    case 'high':
      return 2;
    default:
      return 1;
  }
}

function buildCallVideoConstraints(options: CallMediaConstraintOptions): MediaTrackConstraints {
  const baseConstraints = getPreferredVideoConstraints(options);

  if (options.selectedVideoId) {
    return {
      ...baseConstraints,
      deviceId: { exact: options.selectedVideoId }
    };
  }

  return baseConstraints;
}

function getPreferredVideoConstraints(options: CallMediaConstraintOptions): MediaTrackConstraints {
  if (options.isMobileBrowser) {
    return options.experimentalMobile1080pEnabled
      ? CALL_VIDEO_CONSTRAINTS.mobileExperimental
      : CALL_VIDEO_CONSTRAINTS.mobileStandard;
  }

  return CALL_VIDEO_CONSTRAINTS.desktop;
}

function buildCallAudioConstraints(options: CallMediaConstraintOptions): MediaTrackConstraints {
  const baseConstraints = CALL_AUDIO_CONSTRAINTS[options.microphoneProcessingMode];

  if (options.selectedAudioId) {
    return {
      ...baseConstraints,
      deviceId: { exact: options.selectedAudioId }
    };
  }

  return baseConstraints;
}

function getPreferenceStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

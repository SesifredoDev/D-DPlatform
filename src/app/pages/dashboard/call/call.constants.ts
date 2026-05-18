import type {
  CompanionSourceId,
  RemoteVideoQualityPreference
} from '../../../shared/models/video/video.model';
import type { ICharacter } from '../../../shared/models/user/character.model';
import type { TemporaryDmDuration } from '../../../shared/models/server/server.model';
import type {
  MicrophoneProcessingMode,
  RemoteVideoQualityLevel
} from '../../../shared/models/pages/dashboard/call/call.model';

export const CALL_MEDIA_PREFERENCES_STORAGE_KEY = 'd-d-platform.call.media-preferences';
export const CALL_MIC_TEST_MAX_DURATION_MS = 8000;
export const CALL_MAX_THEME_SYNC_PAYLOAD_BYTES = 60_000;

export const CALL_VIDEO_CONSTRAINTS: {
  desktop: MediaTrackConstraints;
  mobileStandard: MediaTrackConstraints;
  mobileExperimental: MediaTrackConstraints;
} = {
  desktop: {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  },
  mobileStandard: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  },
  mobileExperimental: {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  }
};

export const CALL_AUDIO_CONSTRAINTS: Record<MicrophoneProcessingMode, MediaTrackConstraints> = {
  studio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 }
  },
  processed: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 }
  }
};

export const CALL_MICROPHONE_PROCESSING_OPTIONS: ReadonlyArray<{
  value: MicrophoneProcessingMode;
  label: string;
}> = [
  { value: 'studio', label: 'Studio mic' },
  { value: 'processed', label: 'Voice processed' }
];

export const CALL_REMOTE_VIDEO_QUALITY_OPTIONS: ReadonlyArray<{
  level: RemoteVideoQualityLevel;
  value: RemoteVideoQualityPreference;
  label: string;
}> = [
  { level: 0, value: 'low', label: 'Data saver' },
  { level: 1, value: 'medium', label: 'Balanced' },
  { level: 2, value: 'high', label: 'Max detail' }
];

export const CALL_DEFAULT_PC_SOURCE: CompanionSourceId = 'desktop-local';

export const CALL_TEMPORARY_DM_DURATIONS: Array<{
  duration: TemporaryDmDuration;
  label: string;
}> = [
  { duration: 'day', label: 'DM for 1 day' },
  { duration: 'week', label: 'DM for 1 week' },
  { duration: 'month', label: 'DM for 1 month' },
  { duration: 'permanent', label: 'DM permanently' }
];

export const CALL_DM_CHARACTER: ICharacter = {
  _id: 'dm-character-id',
  ownerId: '',
  servers: [],
  name: 'DM',
  race: 'Dungeon Master',
  icon: null,
  baseStats: { strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
  classes: [{ className: 'Dungeon Master', level: 20 }]
};

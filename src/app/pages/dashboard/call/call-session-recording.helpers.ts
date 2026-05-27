import type {
  SessionRecording,
  SessionRecordingParticipantMedia
} from '../../../shared/models/session-recording/session-recording.model';
import type { ICharacter } from '../../../shared/models/user/character.model';

export function createCharacterSnapshot(character: ICharacter | undefined | null): Partial<ICharacter> | null {
  if (!character) {
    return null;
  }

  return {
    _id: character._id,
    ownerId: character.ownerId,
    name: character.name,
    race: character.race,
    icon: character.icon,
    baseStats: character.baseStats ? { ...character.baseStats } : undefined,
    classes: Array.isArray(character.classes) ? character.classes.map(characterClass => ({ ...characterClass })) : [],
    ac: character.ac
  };
}

export function hasPlayableCallRecording(recording: SessionRecording | null | undefined): boolean {
  return !!recording && (!!recording.media || !!recording.participantMedia?.length);
}

export function hasOptimizedAstralPackage(recording: SessionRecording | null | undefined): boolean {
  const recordingPackage = recording?.package;
  return !!recordingPackage?.path && !!recordingPackage.optimizedAt;
}

export function isAstralPackageAwaitingOptimization(recording: SessionRecording | null | undefined): boolean {
  const recordingPackage = recording?.package;
  return !!recordingPackage?.path
    && !!recordingPackage.originalPath
    && recordingPackage.originalPath === recordingPackage.path
    && !recordingPackage.optimizedAt;
}

export function getDownloadableAstralPackagePath(
  recording: SessionRecording | null | undefined
): string | null {
  const recordingPackage = recording?.package;
  if (!recordingPackage?.path) {
    return null;
  }

  return recordingPackage.path;
}

export function getRecordingPlaybackDurationMs(recording: SessionRecording | null | undefined): number {
  if (!recording) {
    return 0;
  }

  const participantDurationMs = (recording.participantMedia ?? []).reduce(
    (durationMs, participant) => Math.max(durationMs, participant.endedAtMs),
    0
  );

  return Math.max(recording.media?.durationMs ?? 0, recording.durationMs, participantDurationMs);
}

export function getImportedRecordingDurationMs(
  sourceRecording: any,
  participantMedia: SessionRecordingParticipantMedia[]
): number {
  const participantDurationMs = participantMedia.reduce(
    (durationMs, participant) => Math.max(durationMs, participant.endedAtMs),
    0
  );

  return Math.max(toFiniteRecordingNumber(sourceRecording?.durationMs, 0), participantDurationMs);
}

export function toFiniteRecordingNumber(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : fallback;
}

export function normalizeParticipantPlaybackVolume(volumePercent: unknown): number {
  const numericValue = Number(volumePercent);
  if (!Number.isFinite(numericValue)) {
    return 100;
  }

  return Math.min(200, Math.max(0, Math.round(numericValue)));
}

export function hasSameTrackSet(
  firstTracks: MediaStreamTrack[],
  secondTracks: MediaStreamTrack[]
): boolean {
  const firstTrackIds = firstTracks.map(track => track.id).sort();
  const secondTrackIds = secondTracks.map(track => track.id).sort();
  return firstTrackIds.length === secondTrackIds.length &&
    firstTrackIds.every((trackId, index) => trackId === secondTrackIds[index]);
}

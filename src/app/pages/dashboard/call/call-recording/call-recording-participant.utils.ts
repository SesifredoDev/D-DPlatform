import type { CallRecordingParticipant } from '../../../../shared/models/video/video.model';
import type { ICharacter } from '../../../../shared/models/user/character.model';
import type { SessionRecording } from '../../../../shared/models/session-recording/session-recording.model';

export function getRecordableParticipantTracks(
  participant: CallRecordingParticipant
): MediaStreamTrack[] {
  return participant.stream?.getTracks().filter(track => track.readyState === 'live') ?? [];
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

export function getTrackSignature(tracks: MediaStreamTrack[]): string {
  return tracks.map(track => track.id).sort().join('|');
}

export function hasPlayableCallRecording(recording: SessionRecording | null | undefined): boolean {
  return !!recording && (!!recording.media || !!recording.participantMedia?.length);
}

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

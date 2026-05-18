import type {
  SessionRecording,
  SessionRecordingMedia
} from '../../../../shared/models/session-recording/session-recording.model';

export function createAstralRecordingManifest(recording: SessionRecording) {
  return {
    format: 'astral-session-recording',
    formatVersion: 1,
    packagedAt: new Date().toISOString(),
    recording: {
      id: recording.id,
      callRoomId: recording.callRoomId,
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      durationMs: recording.durationMs,
      media: createAstralMediaManifest(recording.media),
      participantMedia: (recording.participantMedia ?? []).map(participant => ({
        participantId: participant.participantId,
        isLocal: participant.isLocal,
        userData: participant.userData,
        participantMeta: participant.participantMeta,
        volumePercent: participant.volumePercent,
        startedAtMs: participant.startedAtMs,
        endedAtMs: participant.endedAtMs,
        media: createAstralMediaManifest(participant.media)
      })),
      vtt: recording.vtt,
      callEnvironment: recording.callEnvironment
    }
  };
}

function createAstralMediaManifest(media: SessionRecordingMedia | null | undefined) {
  if (!media) {
    return null;
  }

  return {
    storage: media.storage,
    mimeType: media.mimeType,
    durationMs: media.durationMs,
    size: media.size,
    path: media.path ?? null
  };
}

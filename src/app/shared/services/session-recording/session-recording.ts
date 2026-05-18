import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { VttRecordingActionSource, RecordedCallEnvironmentAction, RecordedVttAction, RecordedVttTimeline, RecordedCallEnvironmentEvent, RecordedCallEnvironmentTimeline, SessionRecordingMedia, SessionRecordingParticipantMedia, SessionRecordingParticipantMediaInput, SessionRecording, SessionRecordingPackage, SessionRecordingState, SessionPlaybackState } from '../../models/session-recording/session-recording.model';
export type { VttRecordingActionSource, RecordedCallEnvironmentAction, RecordedVttAction, RecordedVttTimeline, RecordedCallEnvironmentEvent, RecordedCallEnvironmentTimeline, SessionRecordingMedia, SessionRecordingParticipantMedia, SessionRecordingParticipantMediaInput, SessionRecording, SessionRecordingPackage, SessionRecordingState, SessionPlaybackState } from '../../models/session-recording/session-recording.model';
@Injectable({ providedIn: 'root' })
export class SessionRecordingService implements OnDestroy {
  private activeRecording: SessionRecording | null = null;
  private recordingStartedAtMs = 0;
  private recordingElapsedTimer: number | null = null;
  private lastRecordingSubject = new BehaviorSubject<SessionRecording | null>(null);
  private recordingStateSubject = new BehaviorSubject<SessionRecordingState>({
    active: false,
    session: null,
    elapsedMs: 0
  });
  private playbackStateSubject = new BehaviorSubject<SessionPlaybackState>({
    active: false,
    paused: true,
    recording: null,
    currentTimeMs: 0,
    durationMs: 0
  });

  readonly lastRecording$ = this.lastRecordingSubject.asObservable();
  readonly recordingState$ = this.recordingStateSubject.asObservable();
  readonly playbackState$ = this.playbackStateSubject.asObservable();

  ngOnDestroy() {
    this.stopRecordingElapsedTimer();
    this.revokeRecordingMedia(this.activeRecording);
    this.revokeRecordingMedia(this.lastRecordingSubject.value);
  }

  startRecording(callRoomId: string | null = null): boolean {
    if (this.activeRecording) {
      return false;
    }

    const now = new Date();
    this.activeRecording = {
      id: this.createId(),
      callRoomId,
      startedAt: now.toISOString(),
      endedAt: null,
      durationMs: 0,
      media: null,
      participantMedia: [],
      package: null,
      vtt: {
        roomId: null,
        initialState: null,
        actions: []
      },
      callEnvironment: {
        initialState: null,
        events: []
      }
    };
    this.recordingStartedAtMs = Date.now();
    this.startRecordingElapsedTimer();
    this.emitRecordingState();
    return true;
  }

  stopRecording(): SessionRecording | null {
    if (!this.activeRecording) {
      return null;
    }

    const finishedRecording = this.activeRecording;
    const durationMs = this.getActiveRecordingElapsedMs();
    finishedRecording.durationMs = durationMs;
    finishedRecording.endedAt = new Date().toISOString();
    this.activeRecording = null;
    this.stopRecordingElapsedTimer();
    this.lastRecordingSubject.next(finishedRecording);
    this.emitRecordingState();
    return finishedRecording;
  }

  abortRecording() {
    this.revokeRecordingMedia(this.activeRecording);
    this.activeRecording = null;
    this.stopRecordingElapsedTimer();
    this.emitRecordingState();
  }

  attachCallMedia(blob: Blob, mimeType: string, durationMs: number): SessionRecording | null {
    const recording = this.lastRecordingSubject.value;
    if (!recording) {
      return null;
    }

    this.revokeMediaUrl(recording.media);
    recording.media = {
      blob,
      storage: 'memory',
      mimeType,
      url: URL.createObjectURL(blob),
      durationMs,
      size: blob.size
    };
    recording.durationMs = Math.max(recording.durationMs, durationMs);
    this.lastRecordingSubject.next(recording);
    return recording;
  }

  attachCallParticipantMedia(
    participant: SessionRecordingParticipantMediaInput,
    blob: Blob,
    mimeType: string,
    durationMs: number
  ): SessionRecording | null {
    const recording = this.activeRecording ?? this.lastRecordingSubject.value;
    if (!recording || !participant?.participantId) {
      return null;
    }

    const startedAtMs = Math.max(0, participant.startedAtMs ?? 0);
    const normalizedDurationMs = Math.max(0, durationMs);
    const participantMedia: SessionRecordingParticipantMedia = {
      participantId: participant.participantId,
      isLocal: !!participant.isLocal,
      userData: this.cloneForRecording(participant.userData ?? null),
      participantMeta: this.cloneForRecording(participant.participantMeta ?? null),
      volumePercent: this.normalizeParticipantVolume(participant.volumePercent),
      startedAtMs,
      endedAtMs: startedAtMs + normalizedDurationMs,
      media: {
        blob,
        storage: 'memory',
        mimeType,
        url: URL.createObjectURL(blob),
        durationMs: normalizedDurationMs,
        size: blob.size
      }
    };

    recording.participantMedia.push(participantMedia);
    recording.durationMs = Math.max(recording.durationMs, participantMedia.endedAtMs);
    if (recording === this.activeRecording) {
      this.emitRecordingState();
    } else {
      this.lastRecordingSubject.next(recording);
    }

    return recording;
  }

  attachCallParticipantExternalMedia(
    participant: SessionRecordingParticipantMediaInput,
    mediaUrl: string,
    mimeType: string,
    durationMs: number,
    size: number,
    path: string | null = null
  ): SessionRecording | null {
    const recording = this.activeRecording ?? this.lastRecordingSubject.value;
    if (!recording || !participant?.participantId || !mediaUrl) {
      return null;
    }

    const startedAtMs = Math.max(0, participant.startedAtMs ?? 0);
    const normalizedDurationMs = Math.max(0, durationMs);
    const participantMedia: SessionRecordingParticipantMedia = {
      participantId: participant.participantId,
      isLocal: !!participant.isLocal,
      userData: this.cloneForRecording(participant.userData ?? null),
      participantMeta: this.cloneForRecording(participant.participantMeta ?? null),
      volumePercent: this.normalizeParticipantVolume(participant.volumePercent),
      startedAtMs,
      endedAtMs: startedAtMs + normalizedDurationMs,
      media: {
        blob: null,
        storage: 'astral',
        mimeType,
        url: mediaUrl,
        durationMs: normalizedDurationMs,
        size,
        path
      }
    };

    recording.participantMedia.push(participantMedia);
    recording.durationMs = Math.max(recording.durationMs, participantMedia.endedAtMs);
    if (recording === this.activeRecording) {
      this.emitRecordingState();
    } else {
      this.lastRecordingSubject.next(recording);
    }

    return recording;
  }

  attachRecordingPackage(recordingId: string, recordingPackage: SessionRecordingPackage): SessionRecording | null {
    const recording = this.activeRecording?.id === recordingId
      ? this.activeRecording
      : this.lastRecordingSubject.value?.id === recordingId
        ? this.lastRecordingSubject.value
        : null;

    if (!recording) {
      return null;
    }

    recording.package = this.cloneForRecording(recordingPackage);
    if (recording === this.activeRecording) {
      this.emitRecordingState();
    } else {
      this.lastRecordingSubject.next(recording);
    }

    return recording;
  }

  loadRecording(recording: SessionRecording): SessionRecording {
    this.revokeRecordingMedia(this.lastRecordingSubject.value);
    const loadedRecording = this.cloneForRecording(recording);
    this.lastRecordingSubject.next(loadedRecording);
    return loadedRecording;
  }

  recordVttInitialState(roomId: string | null, state: any) {
    const recording = this.activeRecording;
    if (!recording || !state) {
      return;
    }

    if (!this.acceptVttRoom(recording, roomId)) {
      return;
    }

    if (!recording.vtt.initialState) {
      recording.vtt.initialState = this.cloneForRecording(state);
      this.emitRecordingState();
    }
  }

  recordVttSnapshot(roomId: string | null, state: any) {
    const recording = this.activeRecording;
    if (!recording || !state) {
      return;
    }

    if (!this.acceptVttRoom(recording, roomId)) {
      return;
    }

    const timeMs = this.getActiveRecordingElapsedMs();
    if (!recording.vtt.initialState && recording.vtt.actions.length === 0 && timeMs < 1000) {
      recording.vtt.initialState = this.cloneForRecording(state);
      this.emitRecordingState();
      return;
    }

    recording.vtt.actions.push({
      timeMs,
      action: 'map-load',
      data: this.cloneForRecording(state),
      source: 'snapshot'
    });
    this.emitRecordingState();
  }

  recordVttAction(
    roomId: string | null,
    action: string,
    data: any,
    source: VttRecordingActionSource = 'remote'
  ) {
    const recording = this.activeRecording;
    if (!recording || !action) {
      return;
    }

    if (!this.acceptVttRoom(recording, roomId)) {
      return;
    }

    recording.vtt.actions.push({
      timeMs: this.getActiveRecordingElapsedMs(),
      action,
      data: this.cloneForRecording(data),
      source
    });
    this.emitRecordingState();
  }

  recordCallEnvironmentInitialState(state: any) {
    const recording = this.activeRecording;
    if (!recording || !state || recording.callEnvironment.initialState) {
      return;
    }

    recording.callEnvironment.initialState = this.cloneForRecording(state);
    this.emitRecordingState();
  }

  recordCallEnvironmentEvent(action: RecordedCallEnvironmentAction, data: any) {
    const recording = this.activeRecording;
    if (!recording || !action) {
      return;
    }

    recording.callEnvironment.events.push({
      timeMs: this.getActiveRecordingElapsedMs(),
      action,
      data: this.cloneForRecording(data)
    });
    this.emitRecordingState();
  }

  startPlayback(recording: SessionRecording | null = this.lastRecordingSubject.value): boolean {
    if (!recording || !this.hasPlayableCallMedia(recording)) {
      return false;
    }

    const durationMs = this.getRecordingPlaybackDurationMs(recording);
    this.playbackStateSubject.next({
      active: true,
      paused: true,
      recording,
      currentTimeMs: 0,
      durationMs
    });
    return true;
  }

  setPlaybackTime(currentTimeMs: number, paused = this.playbackStateSubject.value.paused) {
    const current = this.playbackStateSubject.value;
    if (!current.active || !current.recording) {
      return;
    }

    const durationMs = current.durationMs || current.recording.durationMs;
    const normalizedTimeMs = Math.max(0, Math.min(durationMs || currentTimeMs, currentTimeMs));
    this.playbackStateSubject.next({
      ...current,
      paused,
      currentTimeMs: normalizedTimeMs
    });
  }

  setPlaybackPaused(paused: boolean) {
    const current = this.playbackStateSubject.value;
    if (!current.active) {
      return;
    }

    this.playbackStateSubject.next({
      ...current,
      paused
    });
  }

  stopPlayback() {
    this.playbackStateSubject.next({
      active: false,
      paused: true,
      recording: null,
      currentTimeMs: 0,
      durationMs: 0
    });
  }

  getLastRecording(): SessionRecording | null {
    return this.lastRecordingSubject.value;
  }

  isRecording(): boolean {
    return !!this.activeRecording;
  }

  private acceptVttRoom(recording: SessionRecording, roomId: string | null): boolean {
    if (!roomId) {
      return true;
    }

    if (!recording.vtt.roomId) {
      recording.vtt.roomId = roomId;
      return true;
    }

    return recording.vtt.roomId === roomId;
  }

  private getActiveRecordingElapsedMs(): number {
    return this.activeRecording
      ? Math.max(0, Date.now() - this.recordingStartedAtMs)
      : 0;
  }

  private emitRecordingState() {
    this.recordingStateSubject.next({
      active: !!this.activeRecording,
      session: this.activeRecording,
      elapsedMs: this.getActiveRecordingElapsedMs()
    });
  }

  private startRecordingElapsedTimer() {
    this.stopRecordingElapsedTimer();
    this.recordingElapsedTimer = window.setInterval(() => this.emitRecordingState(), 500);
  }

  private stopRecordingElapsedTimer() {
    if (this.recordingElapsedTimer === null) {
      return;
    }

    window.clearInterval(this.recordingElapsedTimer);
    this.recordingElapsedTimer = null;
  }

  private cloneForRecording<T>(value: T): T {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch {
        // Fall through to JSON cloning for values that contain non-cloneable
        // browser objects. Recording must never interrupt the live interaction.
      }
    }

    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }

  private revokeMediaUrl(media: SessionRecordingMedia | null | undefined) {
    if (media?.url && media.url.startsWith('blob:')) {
      URL.revokeObjectURL(media.url);
    }
  }

  private revokeRecordingMedia(recording: SessionRecording | null | undefined) {
    this.revokeMediaUrl(recording?.media);
    recording?.participantMedia?.forEach(participant => this.revokeMediaUrl(participant.media));
  }

  private hasPlayableCallMedia(recording: SessionRecording): boolean {
    return !!recording.media || !!recording.participantMedia?.length;
  }

  private getRecordingPlaybackDurationMs(recording: SessionRecording): number {
    const participantDurationMs = (recording.participantMedia ?? []).reduce(
      (maxDurationMs, participant) => Math.max(maxDurationMs, participant.endedAtMs),
      0
    );

    return Math.max(recording.media?.durationMs ?? 0, recording.durationMs, participantDurationMs);
  }

  private normalizeParticipantVolume(volumePercent: number | undefined): number {
    if (typeof volumePercent !== 'number' || !Number.isFinite(volumePercent)) {
      return 100;
    }

    return Math.min(200, Math.max(0, Math.round(volumePercent)));
  }

  private createId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

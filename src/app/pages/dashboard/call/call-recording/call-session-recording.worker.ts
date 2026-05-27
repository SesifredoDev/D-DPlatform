import type { CallRecordingParticipant } from '../../../../shared/models/video/video.model';
import type { SessionRecording } from '../../../../shared/models/session-recording/session-recording.model';
import { SessionRecordingService } from '../../../../shared/services/session-recording/session-recording';
import { AstralRecordingService } from '../../../../shared/services/astral-recording/astral-recording';
import { AstralOptimizerService } from '../../../../shared/services/astral-recording/astral-optimizer';
import type {
  CallParticipantIdleState,
  CallParticipantRecorder,
  CallParticipantRecorderStopReason,
  CallSessionRecordingWorkerOptions
} from '../../../../shared/models/pages/dashboard/call/call-recording.workers.model';
import { createParticipantActivityMonitor } from './call-participant-activity-monitor';
import { createAstralRecordingManifest } from './call-recording-astral-manifest';
import {
  captureStillFrameFromStream,
  getSupportedSessionRecordingMimeType
} from './call-recording-media.utils';
import {
  createCharacterSnapshot,
  getRecordableParticipantTracks,
  getTrackSignature,
  hasPlayableCallRecording,
  hasSameTrackSet
} from './call-recording-participant.utils';

export class CallSessionRecordingWorker {
  astralRecordingPath: string | null = null;

  private recordingStartedAt = 0;
  private durationInterval: any;
  private discardOnStop = false;
  private participantRecorders = new Map<string, CallParticipantRecorder>();
  private participantIdleStates = new Map<string, CallParticipantIdleState>();
  private stoppingParticipantRecorders = 0;
  private finalizingRecording = false;
  private astralRecordingSessionId: string | null = null;
  private astralParticipantSegmentCounters = new Map<string, number>();
  private astralManifestCheckpointInterval: any;
  private astralManifestCheckpointTimeout: any;
  private astralManifestCheckpointPendingRecording: SessionRecording | null = null;
  private astralManifestChangeSubscription: { unsubscribe: () => void } | null = null;
  private astralManifestWriteChain: Promise<void> = Promise.resolve();
  private readonly participantIdleThresholdMs = 60000;
  private readonly participantIdleCheckIntervalMs = 250;
  private readonly astralManifestCheckpointIntervalMs = 5000;
  private readonly astralManifestActionCheckpointDelayMs = 250;
  private readonly participantActivityMonitorOptions = {
    audioRmsThreshold: 0.012,
    videoMotionThreshold: 7
  };
  private readonly participantStillFrameMimeType = 'image/webp';

  constructor(
    private readonly sessionRecording: SessionRecordingService,
    private readonly astralRecording: AstralRecordingService,
    private readonly astralOptimizer: AstralOptimizerService,
    private readonly options: CallSessionRecordingWorkerOptions
  ) {}

  get hasActiveWork(): boolean {
    return this.participantRecorders.size > 0 ||
      this.participantIdleStates.size > 0 ||
      this.finalizingRecording;
  }

  get isUsingAstralStorage(): boolean {
    return !!this.astralRecordingSessionId;
  }

  async start(): Promise<boolean> {
    if (!this.sessionRecording.isRecording() || this.finalizingRecording) {
      return false;
    }

    this.astralRecordingPath = null;
    this.astralRecordingSessionId = null;
    this.astralParticipantSegmentCounters.clear();
    this.recordingStartedAt = Date.now();
    this.participantRecorders.clear();
    this.participantIdleStates.clear();
    this.stoppingParticipantRecorders = 0;
    this.finalizingRecording = false;
    this.discardOnStop = false;
    this.options.onDurationChange(0);

    await this.startAstralRecordingSession();
    if (!this.sessionRecording.isRecording() || this.finalizingRecording) {
      await this.abortAstralRecordingSession();
      return false;
    }

    this.syncParticipants();
    if (!this.participantRecorders.size) {
      this.options.setError('No participant streams to record');
      await this.abortAstralRecordingSession();
      this.cleanup();
      return false;
    }

    this.durationInterval = setInterval(() => {
      this.options.onDurationChange(Math.floor((Date.now() - this.recordingStartedAt) / 1000));
      this.options.requestChangeDetection();
    }, 500);

    return true;
  }

  stop(discardRecording: boolean = false) {
    if (!this.sessionRecording.isRecording() && !this.participantRecorders.size && !this.participantIdleStates.size) {
      return;
    }

    this.discardOnStop = this.discardOnStop || discardRecording;
    this.finalizingRecording = true;
    this.clearRecordingTimer();
    this.endAllParticipantIdleStates(!this.discardOnStop);
    if (!this.participantRecorders.size) {
      void this.finishRecordingIfReady();
      return;
    }

    this.stopAllParticipantRecorders();
    void this.finishRecordingIfReady();
  }

  syncParticipants() {
    if (!this.sessionRecording.isRecording() || this.finalizingRecording || this.options.isPlaybackMode()) {
      return;
    }

    const activeParticipantIds = new Set<string>();
    this.options.getParticipants().forEach(participant => {
      const tracks = getRecordableParticipantTracks(participant);
      if (!tracks.length) {
        return;
      }

      activeParticipantIds.add(participant.id);
      const idleState = this.participantIdleStates.get(participant.id);
      if (idleState) {
        idleState.userData = createCharacterSnapshot(participant.userData);
        idleState.participantMeta = participant.participantMeta ?? null;
        idleState.volumePercent = participant.volumePercent;

        const tracksSignature = getTrackSignature(tracks);
        if (idleState.tracksSignature === tracksSignature) {
          return;
        }

        this.endParticipantIdleState(idleState, true);
      }

      const existingRecorder = this.participantRecorders.get(participant.id);
      if (existingRecorder && hasSameTrackSet(existingRecorder.stream.getTracks(), tracks)) {
        existingRecorder.userData = createCharacterSnapshot(participant.userData);
        existingRecorder.participantMeta = participant.participantMeta ?? null;
        existingRecorder.volumePercent = participant.volumePercent;
        return;
      }

      if (existingRecorder) {
        this.stopParticipantRecorder(existingRecorder, 'tracks-changed');
      }

      this.startParticipantRecorder(participant, tracks);
    });

    Array.from(this.participantRecorders.values()).forEach(recorder => {
      if (!activeParticipantIds.has(recorder.participantId)) {
        this.stopParticipantRecorder(recorder, 'removed');
      }
    });

    Array.from(this.participantIdleStates.values()).forEach(idleState => {
      if (!activeParticipantIds.has(idleState.participantId)) {
        this.endParticipantIdleState(idleState, true);
      }
    });
  }

  cleanup() {
    this.clearRecordingTimer();
    this.participantRecorders.forEach(recorder => this.stopParticipantRecorderIdleMonitor(recorder));
    this.participantRecorders.clear();
    this.endAllParticipantIdleStates(false);
    this.stoppingParticipantRecorders = 0;
    this.finalizingRecording = false;
    this.recordingStartedAt = 0;
    this.discardOnStop = false;
    this.options.onDurationChange(0);
  }

  private startParticipantRecorder(participant: CallRecordingParticipant, tracks: MediaStreamTrack[]) {
    const stream = new MediaStream(tracks);
    const startedAtMs = Math.max(0, Date.now() - this.recordingStartedAt);
    let recorder: MediaRecorder;
    let mimeType = getSupportedSessionRecordingMimeType(stream) || '';

    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mimeType = recorder.mimeType || mimeType || 'video/webm';
    } catch (error) {
      this.failRecording('Recording unavailable', 'Failed to create participant recorder', error);
      return;
    }

    const participantRecorder: CallParticipantRecorder = {
      participantId: participant.id,
      isLocal: !!participant.isLocal,
      userData: createCharacterSnapshot(participant.userData),
      participantMeta: participant.participantMeta ?? null,
      volumePercent: participant.volumePercent,
      stream,
      recorder,
      chunks: [],
      mimeType,
      startedAtMs,
      stopping: false,
      astralSegmentIndex: this.astralRecordingSessionId
        ? this.getNextAstralParticipantSegmentIndex(participant.id)
        : null,
      astralFilePath: null,
      astralFileUrl: null,
      astralSize: 0,
      astralWriteChain: Promise.resolve(),
      astralWriteFailed: false,
      stopReason: 'final',
      idleMonitor: null,
      idleMonitorInterval: null,
      idleLastActivityAt: Date.now(),
      idleTransitionInProgress: false,
      pendingIdleStillFrame: null,
      pendingIdleStillMimeType: null
    };

    recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        if (this.astralRecordingSessionId && participantRecorder.astralSegmentIndex !== null) {
          this.queueAstralParticipantChunk(participantRecorder, event.data);
        } else {
          participantRecorder.chunks.push(event.data);
        }
      }
    };
    recorder.onerror = event => {
      this.failRecording('Recording failed', 'Participant session recorder error', event);
      this.options.requestChangeDetection();
    };
    recorder.onstop = () => void this.handleParticipantRecorderStopped(participantRecorder);

    try {
      recorder.start(1000);
      this.participantRecorders.set(participant.id, participantRecorder);
      this.startParticipantRecorderIdleMonitor(participantRecorder);
    } catch (error) {
      this.failRecording('Recording failed', 'Failed to start participant recorder', error);
    }
  }

  private getNextAstralParticipantSegmentIndex(participantId: string): number {
    const nextIndex = this.astralParticipantSegmentCounters.get(participantId) ?? 0;
    this.astralParticipantSegmentCounters.set(participantId, nextIndex + 1);
    return nextIndex;
  }

  private queueAstralParticipantChunk(participantRecorder: CallParticipantRecorder, chunk: Blob) {
    const sessionId = this.astralRecordingSessionId;
    const segmentIndex = participantRecorder.astralSegmentIndex;
    if (!sessionId || segmentIndex === null || participantRecorder.astralWriteFailed) {
      return;
    }

    const chunkStartedAtMs = Math.max(0, Date.now() - this.recordingStartedAt - participantRecorder.startedAtMs);
    participantRecorder.astralWriteChain = participantRecorder.astralWriteChain
      .catch(() => undefined)
      .then(async () => {
        if (participantRecorder.astralWriteFailed) {
          return;
        }

        try {
          const result = await this.astralRecording.writeChunk({
            sessionId,
            participantId: participantRecorder.participantId,
            segmentIndex,
            mimeType: participantRecorder.mimeType,
            startedAtMs: participantRecorder.startedAtMs,
            chunkStartedAtMs,
            isLocal: participantRecorder.isLocal,
            userData: participantRecorder.userData,
            participantMeta: participantRecorder.participantMeta,
            volumePercent: participantRecorder.volumePercent,
            blob: chunk
          });
          participantRecorder.astralFilePath = result.filePath;
          participantRecorder.astralFileUrl = result.fileUrl;
          participantRecorder.astralSize = result.size;
        } catch (error) {
          participantRecorder.astralWriteFailed = true;
          this.failRecording('Recording failed', 'Failed to persist Astral recording chunk', error);
        }
      });
  }

  private startParticipantRecorderIdleMonitor(participantRecorder: CallParticipantRecorder) {
    if (!participantRecorder.stream.getVideoTracks().some(track => track.readyState === 'live')) {
      return;
    }

    const monitor = createParticipantActivityMonitor(
      participantRecorder.stream,
      this.participantActivityMonitorOptions
    );
    if (!monitor) {
      return;
    }

    participantRecorder.idleMonitor = monitor;
    participantRecorder.idleLastActivityAt = Date.now();
    participantRecorder.idleMonitorInterval = setInterval(() => {
      if (
        participantRecorder.stopping ||
        participantRecorder.idleTransitionInProgress ||
        this.finalizingRecording ||
        !this.sessionRecording.isRecording()
      ) {
        return;
      }

      const sample = monitor.getSample();
      if (sample.active) {
        participantRecorder.idleLastActivityAt = Date.now();
        return;
      }

      if (Date.now() - participantRecorder.idleLastActivityAt >= this.participantIdleThresholdMs) {
        void this.transitionParticipantRecorderToIdle(participantRecorder);
      }
    }, this.participantIdleCheckIntervalMs);
  }

  private stopParticipantRecorderIdleMonitor(participantRecorder: CallParticipantRecorder) {
    if (participantRecorder.idleMonitorInterval) {
      clearInterval(participantRecorder.idleMonitorInterval);
      participantRecorder.idleMonitorInterval = null;
    }

    participantRecorder.idleMonitor?.cleanup();
    participantRecorder.idleMonitor = null;
  }

  private async transitionParticipantRecorderToIdle(participantRecorder: CallParticipantRecorder) {
    if (
      participantRecorder.stopping ||
      participantRecorder.idleTransitionInProgress ||
      this.finalizingRecording ||
      this.discardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    participantRecorder.idleTransitionInProgress = true;
    const stillFrame = await captureStillFrameFromStream(
      participantRecorder.stream,
      this.participantStillFrameMimeType
    );
    if (
      !stillFrame ||
      this.participantRecorders.get(participantRecorder.participantId) !== participantRecorder ||
      participantRecorder.stopping ||
      this.finalizingRecording ||
      this.discardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      participantRecorder.idleTransitionInProgress = false;
      participantRecorder.idleLastActivityAt = Date.now();
      return;
    }

    participantRecorder.pendingIdleStillFrame = stillFrame;
    participantRecorder.pendingIdleStillMimeType = stillFrame.type || this.participantStillFrameMimeType;
    this.stopParticipantRecorder(participantRecorder, 'idle');
  }

  private async startParticipantIdleState(participantRecorder: CallParticipantRecorder) {
    const stillFrame = participantRecorder.pendingIdleStillFrame;
    if (
      !stillFrame ||
      this.finalizingRecording ||
      this.discardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const startedAtMs = Math.max(0, Date.now() - this.recordingStartedAt);
    const mimeType = participantRecorder.pendingIdleStillMimeType || stillFrame.type || this.participantStillFrameMimeType;
    let mediaUrl: string | null = null;
    let mediaPath: string | null = null;
    let mediaSize = stillFrame.size;
    let memoryBlob: Blob | null = stillFrame;

    if (this.astralRecordingSessionId) {
      try {
        const result = await this.astralRecording.writeChunk({
          sessionId: this.astralRecordingSessionId,
          participantId: participantRecorder.participantId,
          segmentIndex: this.getNextAstralParticipantSegmentIndex(participantRecorder.participantId),
          mimeType,
          startedAtMs,
          chunkStartedAtMs: 0,
          isLocal: participantRecorder.isLocal,
          userData: participantRecorder.userData,
          participantMeta: participantRecorder.participantMeta,
          volumePercent: participantRecorder.volumePercent,
          blob: stillFrame
        });
        mediaUrl = result.fileUrl;
        mediaPath = result.filePath;
        mediaSize = result.size;
        memoryBlob = null;
      } catch (error) {
        this.failRecording('Recording failed', 'Failed to persist Astral idle still frame', error);
        return;
      }
    }

    if (
      this.finalizingRecording ||
      this.discardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const idleState: CallParticipantIdleState = {
      participantId: participantRecorder.participantId,
      isLocal: participantRecorder.isLocal,
      userData: participantRecorder.userData,
      participantMeta: participantRecorder.participantMeta,
      volumePercent: participantRecorder.volumePercent,
      stream: participantRecorder.stream,
      tracksSignature: getTrackSignature(participantRecorder.stream.getTracks()),
      startedAtMs,
      blob: memoryBlob,
      mimeType,
      mediaUrl,
      mediaPath,
      size: mediaSize,
      activityMonitor: null,
      activityMonitorInterval: null,
      resuming: false
    };

    this.participantIdleStates.set(participantRecorder.participantId, idleState);
    this.startParticipantIdleStateMonitor(idleState);
  }

  private startParticipantIdleStateMonitor(idleState: CallParticipantIdleState) {
    const monitor = createParticipantActivityMonitor(
      idleState.stream,
      this.participantActivityMonitorOptions
    );
    if (!monitor) {
      return;
    }

    idleState.activityMonitor = monitor;
    idleState.activityMonitorInterval = setInterval(() => {
      if (
        idleState.resuming ||
        this.finalizingRecording ||
        !this.sessionRecording.isRecording() ||
        this.participantIdleStates.get(idleState.participantId) !== idleState
      ) {
        return;
      }

      if (monitor.getSample().active) {
        this.resumeParticipantRecordingFromIdle(idleState);
      }
    }, this.participantIdleCheckIntervalMs);
  }

  private resumeParticipantRecordingFromIdle(idleState: CallParticipantIdleState) {
    if (idleState.resuming) {
      return;
    }

    idleState.resuming = true;
    const participant = this.options.getParticipants()
      .find(candidate => candidate.id === idleState.participantId);
    this.endParticipantIdleState(idleState, true);

    if (
      !participant ||
      this.finalizingRecording ||
      this.discardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const tracks = getRecordableParticipantTracks(participant);
    if (tracks.length) {
      this.startParticipantRecorder(participant, tracks);
    }
  }

  private endAllParticipantIdleStates(attachMedia: boolean) {
    Array.from(this.participantIdleStates.values()).forEach(idleState => {
      this.endParticipantIdleState(idleState, attachMedia);
    });
  }

  private endParticipantIdleState(idleState: CallParticipantIdleState, attachMedia: boolean) {
    if (idleState.activityMonitorInterval) {
      clearInterval(idleState.activityMonitorInterval);
      idleState.activityMonitorInterval = null;
    }

    idleState.activityMonitor?.cleanup();
    idleState.activityMonitor = null;

    if (this.participantIdleStates.get(idleState.participantId) === idleState) {
      this.participantIdleStates.delete(idleState.participantId);
    }

    if (!attachMedia || this.discardOnStop) {
      return;
    }

    const durationMs = Math.max(0, Date.now() - this.recordingStartedAt - idleState.startedAtMs);
    const participant = {
      participantId: idleState.participantId,
      isLocal: idleState.isLocal,
      userData: idleState.userData,
      participantMeta: idleState.participantMeta,
      volumePercent: idleState.volumePercent,
      startedAtMs: idleState.startedAtMs
    };

    if (idleState.mediaUrl) {
      this.sessionRecording.attachCallParticipantExternalMedia(
        participant,
        idleState.mediaUrl,
        idleState.mimeType,
        durationMs,
        idleState.size,
        idleState.mediaPath
      );
      return;
    }

    if (idleState.blob) {
      this.sessionRecording.attachCallParticipantMedia(
        participant,
        idleState.blob,
        idleState.mimeType,
        durationMs
      );
    }
  }

  private stopAllParticipantRecorders() {
    Array.from(this.participantRecorders.values()).forEach(recorder => {
      this.stopParticipantRecorder(recorder, 'final');
    });
  }

  private stopParticipantRecorder(
    participantRecorder: CallParticipantRecorder,
    reason: CallParticipantRecorderStopReason = 'final'
  ) {
    if (participantRecorder.stopping) {
      return;
    }

    participantRecorder.stopReason = reason;
    participantRecorder.stopping = true;
    this.stopParticipantRecorderIdleMonitor(participantRecorder);
    if (participantRecorder.recorder.state !== 'inactive') {
      this.stoppingParticipantRecorders += 1;
      participantRecorder.recorder.stop();
      return;
    }

    void this.handleParticipantRecorderStopped(participantRecorder);
  }

  private async handleParticipantRecorderStopped(participantRecorder: CallParticipantRecorder) {
    await participantRecorder.astralWriteChain.catch(() => undefined);
    if (participantRecorder.astralWriteFailed) {
      this.discardOnStop = true;
      this.options.setError('Recording failed');
    }

    const activeRecorder = this.participantRecorders.get(participantRecorder.participantId);
    if (activeRecorder === participantRecorder) {
      this.participantRecorders.delete(participantRecorder.participantId);
    }

    if (participantRecorder.stopping && this.stoppingParticipantRecorders > 0) {
      this.stoppingParticipantRecorders -= 1;
    }

    if (!this.discardOnStop && participantRecorder.astralFileUrl) {
      const durationMs = Math.max(0, Date.now() - this.recordingStartedAt - participantRecorder.startedAtMs);
      this.sessionRecording.attachCallParticipantExternalMedia({
        participantId: participantRecorder.participantId,
        isLocal: participantRecorder.isLocal,
        userData: participantRecorder.userData,
        participantMeta: participantRecorder.participantMeta,
        volumePercent: participantRecorder.volumePercent,
        startedAtMs: participantRecorder.startedAtMs
      }, participantRecorder.astralFileUrl, participantRecorder.mimeType, durationMs, participantRecorder.astralSize, participantRecorder.astralFilePath);
    } else if (!this.discardOnStop && participantRecorder.chunks.length > 0) {
      const durationMs = Math.max(0, Date.now() - this.recordingStartedAt - participantRecorder.startedAtMs);
      this.sessionRecording.attachCallParticipantMedia({
        participantId: participantRecorder.participantId,
        isLocal: participantRecorder.isLocal,
        userData: participantRecorder.userData,
        participantMeta: participantRecorder.participantMeta,
        volumePercent: participantRecorder.volumePercent,
        startedAtMs: participantRecorder.startedAtMs
      }, new Blob(participantRecorder.chunks, { type: participantRecorder.mimeType }), participantRecorder.mimeType, durationMs);
    }

    if (participantRecorder.stopReason === 'idle') {
      await this.startParticipantIdleState(participantRecorder);
    }

    void this.finishRecordingIfReady();
  }

  private async finishRecordingIfReady() {
    if (this.finalizingRecording && this.participantIdleStates.size > 0) {
      this.endAllParticipantIdleStates(!this.discardOnStop);
    }

    if (!this.finalizingRecording || this.stoppingParticipantRecorders > 0 || this.participantRecorders.size > 0 || this.participantIdleStates.size > 0) {
      return;
    }

    const discardRecording = this.discardOnStop;
    this.cleanup();

    if (discardRecording) {
      await this.abortAstralRecordingSession();
      this.sessionRecording.abortRecording();
      this.options.requestChangeDetection();
      return;
    }

    const recording = this.sessionRecording.stopRecording();
    if (hasPlayableCallRecording(recording)) {
      const packagedAsAstral = recording ? await this.finalizeAstralRecordingSession(recording) : false;
      const readyRecording = this.sessionRecording.getLastRecording() ?? recording;
      if (readyRecording) {
        this.options.onRecordingReady(readyRecording, packagedAsAstral);
      }
    } else {
      await this.abortAstralRecordingSession();
      this.options.setError('No participant media captured');
    }

    this.options.requestChangeDetection();
  }

  private async startAstralRecordingSession() {
    try {
      if (!(await this.astralRecording.isAvailable())) {
        return;
      }

      const session = await this.astralRecording.begin(this.options.getCallRoomId());
      this.astralRecordingSessionId = session.sessionId;
      this.startAstralManifestCheckpointing();
    } catch (error) {
      console.warn('Astral local recording storage unavailable; falling back to in-memory recording.', error);
      this.astralRecordingSessionId = null;
      this.astralParticipantSegmentCounters.clear();
    }
  }

  private async abortAstralRecordingSession() {
    const sessionId = this.astralRecordingSessionId;
    this.cleanupAstralRecordingState();
    if (!sessionId) {
      return;
    }

    await this.astralRecording.abort(sessionId).catch(error => {
      console.warn('Failed to abort Astral recording session', error);
    });
  }

  private async finalizeAstralRecordingSession(recording: SessionRecording): Promise<boolean> {
    const sessionId = this.astralRecordingSessionId;
    this.stopAstralManifestCheckpointing();
    this.flushAstralManifestCheckpoint(recording);
    await this.astralManifestWriteChain.catch(() => undefined);
    this.cleanupAstralRecordingState();
    if (!sessionId) {
      return false;
    }

    try {
      const packageResult = await this.astralRecording.finalize(sessionId, createAstralRecordingManifest(recording));
      this.astralRecordingPath = packageResult.astralPath;
      this.sessionRecording.attachRecordingPackage(recording.id, {
        storage: 'astral',
        path: packageResult.astralPath,
        size: packageResult.astralSize,
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        originalPath: packageResult.astralPath,
        originalSize: packageResult.astralSize
      });
      void this.astralOptimizer.optimizeRecordingPackage(recording.id, packageResult.astralPath);
      return true;
    } catch (error) {
      console.error('Failed to finalize Astral recording package', error);
      this.options.setError('Recording playable, but .astral packaging failed');
      return false;
    }
  }

  private cleanupAstralRecordingState() {
    this.stopAstralManifestCheckpointing();
    if (this.astralManifestCheckpointTimeout) {
      clearTimeout(this.astralManifestCheckpointTimeout);
      this.astralManifestCheckpointTimeout = null;
    }
    this.astralManifestChangeSubscription?.unsubscribe();
    this.astralManifestChangeSubscription = null;
    this.astralRecordingSessionId = null;
    this.astralParticipantSegmentCounters.clear();
    this.astralManifestCheckpointPendingRecording = null;
    this.astralManifestWriteChain = Promise.resolve();
  }

  private startAstralManifestCheckpointing() {
    this.stopAstralManifestCheckpointing();
    this.astralManifestChangeSubscription?.unsubscribe();
    this.astralManifestChangeSubscription = this.sessionRecording.recordingManifestChanged$.subscribe(recording => {
      this.queueAstralManifestCheckpoint(recording, this.astralManifestActionCheckpointDelayMs);
    });
    this.queueAstralManifestCheckpoint();
    this.astralManifestCheckpointInterval = setInterval(() => {
      this.queueAstralManifestCheckpoint();
    }, this.astralManifestCheckpointIntervalMs);
  }

  private stopAstralManifestCheckpointing() {
    if (this.astralManifestCheckpointInterval) {
      clearInterval(this.astralManifestCheckpointInterval);
      this.astralManifestCheckpointInterval = null;
    }
  }

  private flushAstralManifestCheckpoint(recording: SessionRecording | null = this.astralManifestCheckpointPendingRecording ?? this.sessionRecording.getCurrentRecording()) {
    if (this.astralManifestCheckpointTimeout) {
      clearTimeout(this.astralManifestCheckpointTimeout);
      this.astralManifestCheckpointTimeout = null;
    }

    this.astralManifestCheckpointPendingRecording = null;
    this.queueAstralManifestCheckpoint(recording);
  }

  private queueAstralManifestCheckpoint(
    recording: SessionRecording | null = this.sessionRecording.getCurrentRecording(),
    delayMs: number = 0
  ) {
    const sessionId = this.astralRecordingSessionId;
    if (!sessionId || !recording) {
      return;
    }

    if (delayMs > 0) {
      this.astralManifestCheckpointPendingRecording = recording;
      if (this.astralManifestCheckpointTimeout) {
        return;
      }

      this.astralManifestCheckpointTimeout = setTimeout(() => {
        const pendingRecording = this.astralManifestCheckpointPendingRecording;
        this.astralManifestCheckpointPendingRecording = null;
        this.astralManifestCheckpointTimeout = null;
        this.queueAstralManifestCheckpoint(pendingRecording);
      }, delayMs);
      return;
    }

    this.astralManifestWriteChain = this.astralManifestWriteChain
      .catch(() => undefined)
      .then(() => this.astralRecording.writeManifest(sessionId, createAstralRecordingManifest(recording)))
      .catch(error => {
        console.warn('Failed to checkpoint Astral recording manifest', error);
      });
  }

  private clearRecordingTimer() {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
  }

  private failRecording(userMessage: string, logMessage: string, error: unknown) {
    console.error(logMessage, error);
    this.options.setError(userMessage);
    this.stop(true);
    this.options.requestChangeDetection();
  }

}

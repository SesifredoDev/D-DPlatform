import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  AstralRecordingFinalizeResponse,
  AstralRecordingService,
  AstralUnpackedRecordingEntry
} from './astral-recording';

export type AstralPackagingJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AstralPackagingJob {
  id: string;
  recordingId: string;
  name: string;
  sessionDir: string;
  status: AstralPackagingJobStatus;
  stage: string;
  message: string;
  currentBytes: number;
  totalBytes: number;
  progressPercent: number;
  startedAt: number;
  finishedAt?: number;
  currentFile?: string;
  astralPath?: string;
  astralSize?: number;
  error?: string;
}

interface AstralPackagingProgressEvent {
  jobId: string;
  stage: string;
  message: string;
  currentBytes: number;
  totalBytes: number;
  progressPercent: number;
  currentFile?: string | null;
  astralPath?: string | null;
  astralSize?: number | null;
  error?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AstralPackagingQueueService implements OnDestroy {
  private readonly jobsSubject = new BehaviorSubject<AstralPackagingJob[]>([]);
  private progressUnlisten: Promise<UnlistenFn> | null = null;
  private isProcessing = false;
  private visibilityRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  readonly jobs$ = this.jobsSubject.asObservable();

  constructor(private astralRecording: AstralRecordingService) {}

  ngOnDestroy() {
    void this.progressUnlisten?.then(unlisten => unlisten()).catch(() => undefined);
    if (this.visibilityRefreshTimer) {
      clearTimeout(this.visibilityRefreshTimer);
      this.visibilityRefreshTimer = null;
    }
  }

  enqueueUnpackedSession(recording: AstralUnpackedRecordingEntry): AstralPackagingJob | null {
    if (recording.readError) {
      return null;
    }

    const activeJob = this.jobsSubject.value.find(job =>
      job.sessionDir === recording.path &&
      (job.status === 'queued' || job.status === 'running')
    );
    if (activeJob) {
      return activeJob;
    }

    const job: AstralPackagingJob = {
      id: this.createJobId(),
      recordingId: recording.id,
      name: recording.name || recording.id,
      sessionDir: recording.path,
      status: 'queued',
      stage: 'queued',
      message: 'Queued Astral packaging',
      currentBytes: 0,
      totalBytes: recording.size || 0,
      progressPercent: 0,
      startedAt: Date.now()
    };
    this.upsertJob(job);
    void this.drainQueue();
    return job;
  }

  dismissJob(jobId: string) {
    this.jobsSubject.next(this.jobsSubject.value.filter(job => job.id !== jobId));
  }

  dismissFinishedJobs() {
    this.jobsSubject.next(this.jobsSubject.value.filter(job => job.status === 'queued' || job.status === 'running'));
  }

  private async drainQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    try {
      while (true) {
        const job = this.jobsSubject.value.find(candidate => candidate.status === 'queued');
        if (!job) {
          break;
        }

        await this.runJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async runJob(job: AstralPackagingJob) {
    try {
      if (!(await this.astralRecording.isAvailable().catch(() => false))) {
        throw new Error('Astral recording storage is only available in the Tauri desktop app.');
      }

      await this.ensureProgressListener();
      this.upsertJob({
        ...(this.getJob(job.id) ?? job),
        status: 'running',
        stage: 'preparing',
        message: 'Preparing unpacked recording',
        progressPercent: Math.max(1, job.progressPercent)
      });

      const response = await this.astralRecording.packageUnpackedSession(job.sessionDir, job.id);
      this.completeJob(job.id, response);
    } catch (error) {
      this.upsertJob({
        ...(this.getJob(job.id) ?? job),
        status: 'failed',
        stage: 'failed',
        message: 'Astral packaging failed',
        progressPercent: 100,
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
      this.scheduleVisibilityRefresh();
    }
  }

  private completeJob(jobId: string, response: AstralRecordingFinalizeResponse) {
    const existing = this.getJob(jobId);
    if (!existing) {
      return;
    }

    this.upsertJob({
      ...existing,
      status: 'completed',
      stage: 'completed',
      message: 'Astral package ready',
      progressPercent: 100,
      currentBytes: response.astralSize,
      totalBytes: response.astralSize,
      finishedAt: Date.now(),
      astralPath: response.astralPath,
      astralSize: response.astralSize
    });
    this.scheduleVisibilityRefresh();
  }

  private async ensureProgressListener() {
    if (this.progressUnlisten) {
      return;
    }

    this.progressUnlisten = import('@tauri-apps/api/event')
      .then(({ listen }) => listen<AstralPackagingProgressEvent>(
        'astral-recording-package-progress',
        event => this.applyProgress(event.payload)
      ));

    await this.progressUnlisten;
  }

  private applyProgress(progress: AstralPackagingProgressEvent) {
    const existing = this.getJob(progress.jobId);
    if (!existing) {
      return;
    }

    const status = this.resolveStatus(progress.stage);
    this.upsertJob({
      ...existing,
      status,
      stage: progress.stage,
      message: progress.message || existing.message,
      currentBytes: Math.max(0, Number(progress.currentBytes) || 0),
      totalBytes: Math.max(0, Number(progress.totalBytes) || existing.totalBytes || 0),
      progressPercent: this.clampProgress(progress.progressPercent, existing.progressPercent),
      currentFile: progress.currentFile || undefined,
      astralPath: progress.astralPath || existing.astralPath,
      astralSize: progress.astralSize ?? existing.astralSize,
      error: progress.error || existing.error,
      finishedAt: status === 'completed' || status === 'failed' ? Date.now() : existing.finishedAt
    });
  }

  private resolveStatus(stage: string): AstralPackagingJobStatus {
    if (stage === 'completed') return 'completed';
    if (stage === 'failed') return 'failed';
    return 'running';
  }

  private clampProgress(progressPercent: number, fallback: number): number {
    const value = Number(progressPercent);
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Math.min(100, Math.max(0, Math.round(value)));
  }

  private upsertJob(job: AstralPackagingJob) {
    const jobs = this.jobsSubject.value.slice();
    const index = jobs.findIndex(candidate => candidate.id === job.id);
    if (index >= 0) {
      jobs[index] = job;
    } else {
      jobs.unshift(job);
    }

    this.jobsSubject.next(jobs.slice(0, 5));
  }

  private getJob(jobId: string): AstralPackagingJob | undefined {
    return this.jobsSubject.value.find(job => job.id === jobId);
  }

  private scheduleVisibilityRefresh() {
    if (this.visibilityRefreshTimer) {
      clearTimeout(this.visibilityRefreshTimer);
    }

    this.visibilityRefreshTimer = setTimeout(() => {
      this.visibilityRefreshTimer = null;
      this.jobsSubject.next(this.jobsSubject.value.slice());
    }, 15000);
  }

  private createJobId(): string {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return `astral_pkg_${Date.now()}_${randomPart}`;
  }
}

import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  AstralRecordingOptimizeOptions,
  AstralRecordingOptimizeResponse,
  AstralRecordingService
} from './astral-recording';
import { SessionRecordingService } from '../session-recording/session-recording';

export type AstralOptimizationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AstralOptimizationJob {
  id: string;
  recordingId: string | null;
  packagePath: string;
  status: AstralOptimizationJobStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  progressPercent: number;
  startedAt: number;
  finishedAt?: number;
  originalSize?: number;
  optimizedSize?: number;
  optimizedPath?: string;
  optimizedSegmentCount?: number;
  skippedSegmentCount?: number;
  error?: string;
}

interface AstralOptimizationProgressEvent {
  jobId: string;
  stage: string;
  message: string;
  current: number;
  total: number;
}

@Injectable({ providedIn: 'root' })
export class AstralOptimizerService implements OnDestroy {
  private readonly jobsSubject = new BehaviorSubject<AstralOptimizationJob[]>([]);
  private progressUnlisten: Promise<UnlistenFn> | null = null;

  readonly jobs$ = this.jobsSubject.asObservable();

  constructor(
    private astralRecording: AstralRecordingService,
    private sessionRecording: SessionRecordingService
  ) {}

  ngOnDestroy() {
    void this.progressUnlisten?.then(unlisten => unlisten()).catch(() => undefined);
  }

  async optimizeRecordingPackage(
    recordingId: string | null,
    packagePath: string,
    options: AstralRecordingOptimizeOptions = {}
  ): Promise<AstralRecordingOptimizeResponse | null> {
    if (!packagePath) {
      return null;
    }

    if (!(await this.astralRecording.isAvailable().catch(() => false))) {
      return null;
    }

    await this.ensureProgressListener();

    const jobId = this.createJobId();
    const job: AstralOptimizationJob = {
      id: jobId,
      recordingId,
      packagePath,
      status: 'queued',
      stage: 'queued',
      message: 'Queued Astral optimization',
      current: 0,
      total: 0,
      progressPercent: 0,
      startedAt: Date.now()
    };
    this.upsertJob(job);

    try {
      const response = await this.astralRecording.optimizePackage(jobId, packagePath, {
        targetVideoBitrateKbps: 1200,
        targetAudioBitrateKbps: 96,
        maxHeight: 720,
        keepOriginal: true,
        ...options
      });

      this.upsertJob({
        ...this.getJob(jobId, job),
        status: 'completed',
        stage: 'completed',
        message: 'Astral optimization complete',
        current: response.segmentCount,
        total: response.segmentCount,
        progressPercent: 100,
        finishedAt: Date.now(),
        originalSize: response.originalSize,
        optimizedSize: response.optimizedSize,
        optimizedPath: response.optimizedPath,
        optimizedSegmentCount: response.optimizedSegmentCount,
        skippedSegmentCount: response.skippedSegmentCount
      });

      if (recordingId) {
        this.sessionRecording.attachRecordingPackage(recordingId, {
          storage: 'astral',
          path: response.optimizedPath,
          size: response.optimizedSize,
          formatVersion: 1,
          createdAt: new Date().toISOString(),
          originalPath: response.originalPath,
          originalSize: response.originalSize,
          optimizedAt: new Date().toISOString()
        });
      }

      return response;
    } catch (error) {
      this.upsertJob({
        ...this.getJob(jobId, job),
        status: 'failed',
        stage: 'failed',
        message: 'Astral optimization failed',
        progressPercent: 100,
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  dismissJob(jobId: string) {
    this.jobsSubject.next(this.jobsSubject.value.filter(job => job.id !== jobId));
  }

  dismissFinishedJobs() {
    this.jobsSubject.next(this.jobsSubject.value.filter(job => job.status === 'queued' || job.status === 'running'));
  }

  private async ensureProgressListener() {
    if (this.progressUnlisten) {
      return;
    }

    this.progressUnlisten = import('@tauri-apps/api/event')
      .then(({ listen }) => listen<AstralOptimizationProgressEvent>(
        'astral-recording-optimize-progress',
        event => this.applyProgress(event.payload)
      ));

    await this.progressUnlisten;
  }

  private applyProgress(progress: AstralOptimizationProgressEvent) {
    const existing = this.jobsSubject.value.find(job => job.id === progress.jobId);
    if (!existing) {
      return;
    }

    const progressPercent = progress.total > 0
      ? Math.min(99, Math.round((progress.current / progress.total) * 100))
      : existing.progressPercent;

    this.upsertJob({
      ...existing,
      status: progress.stage === 'completed' ? 'completed' : 'running',
      stage: progress.stage,
      message: progress.message,
      current: progress.current,
      total: progress.total,
      progressPercent
    });
  }

  private upsertJob(job: AstralOptimizationJob) {
    const jobs = this.jobsSubject.value.slice();
    const index = jobs.findIndex(candidate => candidate.id === job.id);
    if (index >= 0) {
      jobs[index] = job;
    } else {
      jobs.unshift(job);
    }

    this.jobsSubject.next(jobs.slice(0, 5));
  }

  private getJob(jobId: string, fallback: AstralOptimizationJob): AstralOptimizationJob {
    return this.jobsSubject.value.find(job => job.id === jobId) ?? fallback;
  }

  private createJobId(): string {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return `astral_opt_${Date.now()}_${randomPart}`;
  }
}

import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  AstralRecordingOptimizeOptions,
  AstralRecordingOptimizeResponse,
  AstralRecordingService
} from './astral-recording';
import { SessionRecordingService } from '../session-recording/session-recording';
import type { AstralOptimizationJobStatus, AstralOptimizationJob, AstralOptimizationProgressEvent } from '../../models/astral-recording/astral-optimizer.model';
export type { AstralOptimizationJobStatus, AstralOptimizationJob } from '../../models/astral-recording/astral-optimizer.model';

type AstralGpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number;
}

interface AstralOptimizationHardwareProfile {
  cpuCores: number;
  memoryGb: number | null;
  gpuVendor: AstralGpuVendor;
  gpuRenderer: string | null;
  usableGpu: boolean;
  dedicatedGpu: boolean;
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
      const response = await this.astralRecording.optimizePackage(
        jobId,
        packagePath,
        this.buildAdaptiveOptimizationOptions(options)
      );

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

    const maxProgressPercent = progress.stage === 'completed' ? 100 : 99;
    const progressPercent = Number.isFinite(progress.progressPercent)
      ? Math.min(maxProgressPercent, Math.max(0, Math.round(Number(progress.progressPercent))))
      : progress.total > 0
        ? Math.min(maxProgressPercent, Math.round((progress.current / progress.total) * 100))
        : existing.progressPercent;

    this.upsertJob({
      ...existing,
      status: progress.stage === 'completed' ? 'completed' : 'running',
      stage: progress.stage,
      message: progress.message,
      current: progress.current,
      total: progress.total,
      progressPercent,
      segmentIndex: progress.segmentIndex ?? existing.segmentIndex,
      currentSegment: progress.currentSegment || existing.currentSegment,
      currentSegmentSize: progress.currentSegmentSize ?? existing.currentSegmentSize,
      optimizedSegmentSize: progress.optimizedSegmentSize ?? existing.optimizedSegmentSize,
      optimizedSegmentCount: progress.optimizedSegmentCount ?? existing.optimizedSegmentCount,
      skippedSegmentCount: progress.skippedSegmentCount ?? existing.skippedSegmentCount,
      packageCurrentBytes: progress.packageCurrentBytes ?? existing.packageCurrentBytes,
      packageTotalBytes: progress.packageTotalBytes ?? existing.packageTotalBytes
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

  private buildAdaptiveOptimizationOptions(
    options: AstralRecordingOptimizeOptions
  ): AstralRecordingOptimizeOptions {
    const profile = this.detectHardwareProfile();
    const lowMemory = profile.memoryGb !== null && profile.memoryGb <= 4;
    const moderateMemory = profile.memoryGb !== null && profile.memoryGb <= 8;
    const hasRoomFor1080 = profile.memoryGb === null
      ? profile.cpuCores >= 10 && profile.dedicatedGpu
      : profile.memoryGb >= 12;
    const canUse1080 = profile.cpuCores >= 8 && hasRoomFor1080 && profile.usableGpu;
    const maxHeight = lowMemory || profile.cpuCores <= 2
      ? 480
      : canUse1080
        ? 1080
        : 720;
    const targetVideoBitrateKbps = maxHeight >= 1080
      ? profile.dedicatedGpu ? 2400 : 2100
      : maxHeight >= 720
        ? profile.cpuCores >= 6 && !lowMemory ? 1400 : 1100
        : 800;
    const targetAudioBitrateKbps = lowMemory
      ? 64
      : profile.memoryGb !== null && profile.memoryGb >= 16
        ? 128
        : 96;
    const reserveCores = profile.cpuCores >= 8 ? 2 : profile.cpuCores >= 4 ? 1 : 0;
    const maxThreadsForMemory = lowMemory ? 2 : moderateMemory ? 4 : 8;
    const cpuThreads = this.clampNumber(profile.cpuCores - reserveCores, 1, maxThreadsForMemory);
    const memoryLimitMb = profile.memoryGb === null
      ? undefined
      : this.clampNumber(Math.round(profile.memoryGb * 1024 * 0.35), 768, 8192);

    return {
      targetVideoBitrateKbps,
      targetAudioBitrateKbps,
      maxHeight,
      keepOriginal: true,
      cpuThreads,
      memoryLimitMb,
      preferHardwareEncoding: profile.usableGpu && !lowMemory && profile.cpuCores >= 4,
      gpuVendor: profile.gpuVendor,
      gpuRenderer: profile.gpuRenderer ?? undefined,
      ...options
    };
  }

  private detectHardwareProfile(): AstralOptimizationHardwareProfile {
    const cpuCores = this.detectCpuCores();
    const memoryGb = this.detectMemoryGb();
    const gpu = this.detectGpuProfile();

    return {
      cpuCores,
      memoryGb,
      ...gpu
    };
  }

  private detectCpuCores(): number {
    const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency;
    return this.clampNumber(Math.floor(Number(cores) || 4), 1, 32);
  }

  private detectMemoryGb(): number | null {
    if (typeof navigator === 'undefined') {
      return null;
    }

    const memoryGb = (navigator as NavigatorWithDeviceMemory).deviceMemory;
    return Number.isFinite(memoryGb) && Number(memoryGb) > 0 ? Number(memoryGb) : null;
  }

  private detectGpuProfile(): Pick<
    AstralOptimizationHardwareProfile,
    'gpuVendor' | 'gpuRenderer' | 'usableGpu' | 'dedicatedGpu'
  > {
    if (typeof document === 'undefined') {
      return {
        gpuVendor: 'unknown',
        gpuRenderer: null,
        usableGpu: false,
        dedicatedGpu: false
      };
    }

    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2')
      || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      return {
        gpuVendor: 'unknown',
        gpuRenderer: null,
        usableGpu: false,
        dedicatedGpu: false
      };
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER) || '').trim();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return this.classifyGpuRenderer(renderer || null);
  }

  private classifyGpuRenderer(renderer: string | null): Pick<
    AstralOptimizationHardwareProfile,
    'gpuVendor' | 'gpuRenderer' | 'usableGpu' | 'dedicatedGpu'
  > {
    const value = (renderer ?? '').toLowerCase();
    const isSoftware = !value
      || value.includes('swiftshader')
      || value.includes('llvmpipe')
      || value.includes('software')
      || value.includes('basic render')
      || value.includes('warp');
    const gpuVendor: AstralGpuVendor = value.includes('nvidia')
      ? 'nvidia'
      : value.includes('amd') || value.includes('radeon')
        ? 'amd'
        : value.includes('intel')
          ? 'intel'
          : value.includes('apple')
            ? 'apple'
            : 'unknown';
    const dedicatedGpu = !isSoftware && (
      gpuVendor === 'nvidia'
      || gpuVendor === 'amd'
      || gpuVendor === 'apple'
      || value.includes('arc')
    );

    return {
      gpuVendor,
      gpuRenderer: renderer,
      usableGpu: !isSoftware && gpuVendor !== 'unknown',
      dedicatedGpu
    };
  }

  private clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  private createJobId(): string {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return `astral_opt_${Date.now()}_${randomPart}`;
  }
}

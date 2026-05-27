import { AsyncPipe, NgForOf, NgIf } from '@angular/common';
import { Component } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import {
  AstralOptimizationJob,
  AstralOptimizerService
} from '../../../shared/services/astral-recording/astral-optimizer';

@Component({
  selector: 'app-astral-optimization-runner',
  standalone: true,
  imports: [AsyncPipe, NgForOf, NgIf, MatIconModule],
  templateUrl: './astral-optimization-runner.html',
  styleUrl: './astral-optimization-runner.scss'
})
export class AstralOptimizationRunner {
  readonly jobs$;

  constructor(public astralOptimizer: AstralOptimizerService) {
    this.jobs$ = this.astralOptimizer.jobs$;
  }

  visibleJobs(jobs: AstralOptimizationJob[] | null): AstralOptimizationJob[] {
    return (jobs ?? []).filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'failed' || this.isRecent(job));
  }

  isActive(job: AstralOptimizationJob): boolean {
    return job.status === 'queued' || job.status === 'running';
  }

  statusIcon(job: AstralOptimizationJob): string {
    if (job.status === 'completed') return 'task_alt';
    if (job.status === 'failed') return 'error';
    return 'settings_suggest';
  }

  formatBytes(value: number | undefined): string {
    if (!value || value <= 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  sizeDelta(job: AstralOptimizationJob): string {
    if (!job.originalSize || !job.optimizedSize) return '';
    const savedBytes = Math.max(0, job.originalSize - job.optimizedSize);
    const savedPercent = job.originalSize > 0 ? Math.round((savedBytes / job.originalSize) * 100) : 0;
    return `${this.formatBytes(savedBytes)} saved (${savedPercent}%)`;
  }

  segmentProgress(job: AstralOptimizationJob): string {
    if (job.total <= 0) return '';
    if (job.stage === 'packaging') return `${job.current}/${job.total} segments processed`;
    if (job.stage === 'optimized' || job.stage === 'skipped') return `${job.current}/${job.total} segments processed`;
    const segmentIndex = job.segmentIndex ?? Math.min(job.current + 1, job.total);
    return `Segment ${segmentIndex}/${job.total}`;
  }

  segmentCounts(job: AstralOptimizationJob): string {
    const optimized = job.optimizedSegmentCount ?? 0;
    const skipped = job.skippedSegmentCount ?? 0;
    if (optimized <= 0 && skipped <= 0) return '';
    return `${optimized} optimized, ${skipped} skipped`;
  }

  currentSegmentLabel(job: AstralOptimizationJob): string {
    if (!job.currentSegment) return '';
    return job.currentSegment.split(/[\\/]/).filter(Boolean).slice(-3).join('/');
  }

  currentSegmentSize(job: AstralOptimizationJob): string {
    if (!job.currentSegmentSize) return '';
    if (!job.optimizedSegmentSize || job.optimizedSegmentSize >= job.currentSegmentSize) {
      return this.formatBytes(job.currentSegmentSize);
    }

    const savedBytes = job.currentSegmentSize - job.optimizedSegmentSize;
    const savedPercent = Math.round((savedBytes / job.currentSegmentSize) * 100);
    return `${this.formatBytes(savedBytes)} saved on segment (${savedPercent}%)`;
  }

  packageProgress(job: AstralOptimizationJob): string {
    if (!job.packageTotalBytes || job.packageTotalBytes <= 0) return '';
    return `${this.formatBytes(job.packageCurrentBytes)} / ${this.formatBytes(job.packageTotalBytes)} packaged`;
  }

  private isRecent(job: AstralOptimizationJob): boolean {
    return !!job.finishedAt && Date.now() - job.finishedAt < 15000;
  }
}

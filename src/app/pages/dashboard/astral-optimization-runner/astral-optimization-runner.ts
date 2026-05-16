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

  private isRecent(job: AstralOptimizationJob): boolean {
    return !!job.finishedAt && Date.now() - job.finishedAt < 15000;
  }
}

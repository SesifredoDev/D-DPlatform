import { AsyncPipe, NgForOf, NgIf } from '@angular/common';
import { Component } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import {
  AstralPackagingJob,
  AstralPackagingQueueService
} from '../../../shared/services/astral-recording/astral-packaging-queue';

@Component({
  selector: 'app-astral-packaging-runner',
  standalone: true,
  imports: [AsyncPipe, NgForOf, NgIf, MatIconModule],
  templateUrl: './astral-packaging-runner.html',
  styleUrl: './astral-packaging-runner.scss'
})
export class AstralPackagingRunner {
  readonly jobs$;

  constructor(public astralPackagingQueue: AstralPackagingQueueService) {
    this.jobs$ = this.astralPackagingQueue.jobs$;
  }

  visibleJobs(jobs: AstralPackagingJob[] | null): AstralPackagingJob[] {
    return (jobs ?? []).filter(job => job.status === 'queued' || job.status === 'running' || job.status === 'failed' || this.isRecent(job));
  }

  isActive(job: AstralPackagingJob): boolean {
    return job.status === 'queued' || job.status === 'running';
  }

  statusIcon(job: AstralPackagingJob): string {
    if (job.status === 'completed') return 'task_alt';
    if (job.status === 'failed') return 'error';
    if (job.status === 'queued') return 'schedule';
    return 'inventory_2';
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

  progressBytes(job: AstralPackagingJob): string {
    if (job.totalBytes <= 0) {
      return '';
    }

    return `${this.formatBytes(job.currentBytes)} / ${this.formatBytes(job.totalBytes)}`;
  }

  private isRecent(job: AstralPackagingJob): boolean {
    return !!job.finishedAt && Date.now() - job.finishedAt < 15000;
  }
}

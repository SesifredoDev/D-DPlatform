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

export interface AstralOptimizationProgressEvent {
  jobId: string;
  stage: string;
  message: string;
  current: number;
  total: number;
}

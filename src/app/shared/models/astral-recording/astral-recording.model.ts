export interface TauriCoreApi {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  convertFileSrc(filePath: string, protocol?: string): string;
  isTauri(): boolean;
}

export interface AstralRecordingBeginResponse {
  sessionId: string;
  sessionDir: string;
}

export interface AstralRecordingChunkResponse {
  filePath: string;
  size: number;
}

export interface AstralRecordingFinalizeResponse {
  astralPath: string;
  astralSize: number;
}

export interface AstralRecordingExportResponse {
  savedPath: string;
  size: number;
}

export interface AstralRecordingImportBeginResponse {
  sessionId: string;
  packagePath: string;
}

export interface AstralRecordingImportResponse {
  sessionId: string;
  sessionDir: string;
  packagePath: string;
  packageSize: number;
  manifest: any;
  streamingExtraction?: boolean;
  remoteMediaUrlTemplate?: string;
  files?: Record<string, AstralImportedBrowserFile>;
}

export interface AstralLocalRecordingEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  startedAt?: string | null;
  durationMs?: number | null;
  participantCount: number;
  callRoomId?: string | null;
  readError?: string | null;
}

export interface AstralUnpackedRecordingEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  startedAt?: string | null;
  durationMs?: number | null;
  participantCount: number;
  segmentCount: number;
  hasManifest: boolean;
  readError?: string | null;
}

export interface AstralRecordingOptimizeOptions {
  targetVideoBitrateKbps?: number;
  targetAudioBitrateKbps?: number;
  maxHeight?: number;
  keepOriginal?: boolean;
  cpuThreads?: number;
  memoryLimitMb?: number;
  preferHardwareEncoding?: boolean;
  gpuVendor?: 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
  gpuRenderer?: string;
}

export interface AstralRecordingOptimizeResponse {
  jobId: string;
  originalPath: string;
  optimizedPath: string;
  originalSize: number;
  optimizedSize: number;
  segmentCount: number;
  optimizedSegmentCount: number;
  skippedSegmentCount: number;
}

export interface AstralImportedBrowserFile {
  path: string;
  blob: Blob;
  size: number;
  mimeType: string;
  url?: string;
}

export interface AstralRecordingWriteChunkInput {
  sessionId: string;
  participantId: string;
  segmentIndex: number;
  mimeType: string;
  startedAtMs: number;
  chunkStartedAtMs: number;
  isLocal?: boolean;
  userData?: unknown;
  participantMeta?: unknown;
  volumePercent?: number;
  blob: Blob;
}

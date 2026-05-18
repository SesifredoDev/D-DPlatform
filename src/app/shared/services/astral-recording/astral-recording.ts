import { Injectable } from '@angular/core';
import type { TauriCoreApi, AstralRecordingBeginResponse, AstralRecordingChunkResponse, AstralRecordingFinalizeResponse, AstralRecordingExportResponse, AstralRecordingImportBeginResponse, AstralRecordingImportResponse, AstralRecordingOptimizeOptions, AstralRecordingOptimizeResponse, AstralImportedBrowserFile, AstralRecordingWriteChunkInput } from '../../models/astral-recording/astral-recording.model';
export type { AstralRecordingBeginResponse, AstralRecordingChunkResponse, AstralRecordingFinalizeResponse, AstralRecordingExportResponse, AstralRecordingImportBeginResponse, AstralRecordingImportResponse, AstralRecordingOptimizeOptions, AstralRecordingOptimizeResponse, AstralImportedBrowserFile, AstralRecordingWriteChunkInput } from '../../models/astral-recording/astral-recording.model';
const ASTRAL_MAGIC_BYTES = new Uint8Array([65, 83, 84, 82, 65, 76, 49, 0]);

@Injectable({ providedIn: 'root' })
export class AstralRecordingService {
  private corePromise: Promise<TauriCoreApi | null> | null = null;

  async isAvailable(): Promise<boolean> {
    const core = await this.getCore();
    return !!core?.isTauri();
  }

  async begin(callRoomId: string | null): Promise<AstralRecordingBeginResponse> {
    const core = await this.requireCore();
    return core.invoke<AstralRecordingBeginResponse>('astral_recording_begin', { callRoomId });
  }

  async writeChunk(input: AstralRecordingWriteChunkInput): Promise<AstralRecordingChunkResponse & { fileUrl: string }> {
    const core = await this.requireCore();
    const dataBase64 = await this.blobToBase64(input.blob);
    const response = await core.invoke<AstralRecordingChunkResponse>('astral_recording_write_chunk', {
      sessionId: input.sessionId,
      participantId: input.participantId,
      segmentIndex: input.segmentIndex,
      mimeType: input.mimeType,
      startedAtMs: input.startedAtMs,
      chunkStartedAtMs: input.chunkStartedAtMs,
      dataBase64
    });

    return {
      ...response,
      fileUrl: core.convertFileSrc(response.filePath)
    };
  }

  async writeManifest(sessionId: string, manifest: unknown): Promise<void> {
    const core = await this.requireCore();
    await core.invoke<void>('astral_recording_write_manifest', {
      sessionId,
      manifestJson: JSON.stringify(manifest)
    });
  }

  async finalize(sessionId: string, manifest: unknown): Promise<AstralRecordingFinalizeResponse> {
    const core = await this.requireCore();
    return core.invoke<AstralRecordingFinalizeResponse>('astral_recording_finalize', {
      sessionId,
      manifestJson: JSON.stringify(manifest)
    });
  }

  async abort(sessionId: string): Promise<void> {
    const core = await this.requireCore();
    await core.invoke<void>('astral_recording_abort', { sessionId });
  }

  async exportPackage(packagePath: string): Promise<AstralRecordingExportResponse> {
    const core = await this.requireCore();
    return core.invoke<AstralRecordingExportResponse>('astral_recording_export_package', {
      packagePath
    });
  }

  async importPackageFromPath(packagePath: string): Promise<AstralRecordingImportResponse> {
    const core = await this.requireCore();
    return core.invoke<AstralRecordingImportResponse>('astral_recording_import_package', {
      packagePath
    });
  }

  async optimizePackage(
    jobId: string,
    packagePath: string,
    options: AstralRecordingOptimizeOptions
  ): Promise<AstralRecordingOptimizeResponse> {
    const core = await this.requireCore();
    return core.invoke<AstralRecordingOptimizeResponse>('astral_recording_optimize_package', {
      jobId,
      packagePath,
      options
    });
  }

  async importPackageFile(file: File, onProgress?: (progressPercent: number) => void): Promise<AstralRecordingImportResponse> {
    const nativePath = this.getNativeFilePath(file);
    const core = await this.getCore();
    if (nativePath && core?.isTauri()) {
      onProgress?.(100);
      return this.importPackageFromPath(nativePath);
    }

    if (!core?.isTauri()) {
      const imported = await this.importBrowserPackageFromStream(
        file.stream() as ReadableStream<Uint8Array>,
        file.name || 'recording.astral',
        file.size
      );
      onProgress?.(100);
      return imported;
    }

    return this.importPackageFromChunks(file.name || 'recording.astral', async writeChunk => {
      const chunkSize = 1024 * 1024;
      let offset = 0;

      while (offset < file.size) {
        const nextOffset = Math.min(offset + chunkSize, file.size);
        const chunk = file.slice(offset, nextOffset);
        await writeChunk(await this.blobToBase64(chunk));
        offset = nextOffset;
        onProgress?.(Math.round((offset / Math.max(1, file.size)) * 100));
      }
    });
  }

  async importPackageFromUrl(url: string, filename = 'recording.astral', onProgress?: (progressPercent: number) => void): Promise<AstralRecordingImportResponse> {
    const core = await this.getCore();
    if (!core?.isTauri()) {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Could not download Astral recording (${response.status})`);
      }

      const contentLength = Number(response.headers.get('content-length')) || 0;
      if (response.body?.getReader) {
        const imported = await this.importBrowserPackageFromStream(
          response.body as ReadableStream<Uint8Array>,
          filename,
          contentLength
        );
        onProgress?.(100);
        return imported;
      }

      const blob = await response.blob();
      const imported = await this.importBrowserPackageFromStream(
        blob.stream() as ReadableStream<Uint8Array>,
        filename,
        blob.size
      );
      onProgress?.(100);
      return imported;
    }

    return this.importPackageFromChunks(filename, async writeChunk => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Could not download Astral recording (${response.status})`);
      }

      const contentLength = Number(response.headers.get('content-length')) || 0;
      if (!response.body?.getReader) {
        const blob = await response.blob();
        await writeChunk(await this.blobToBase64(blob));
        onProgress?.(100);
        return;
      }

      const reader = response.body.getReader();
      let loadedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (!value?.byteLength) {
            continue;
          }

          await writeChunk(this.bytesToBase64(value));
          loadedBytes += value.byteLength;
          if (contentLength > 0) {
            onProgress?.(Math.round((loadedBytes / contentLength) * 100));
          }
        }
      } finally {
        reader.releaseLock();
      }

      onProgress?.(100);
    });
  }

  private async importPackageFromChunks(
    fileName: string,
    writeChunks: (writeChunk: (dataBase64: string) => Promise<void>) => Promise<void>
  ): Promise<AstralRecordingImportResponse> {
    const core = await this.requireCore();
    const importSession = await core.invoke<AstralRecordingImportBeginResponse>('astral_recording_import_begin', {
      fileName: this.ensureAstralFilename(fileName)
    });

    try {
      await writeChunks(async dataBase64 => {
        await core.invoke<void>('astral_recording_import_write_chunk', {
          sessionId: importSession.sessionId,
          dataBase64
        });
      });

      return core.invoke<AstralRecordingImportResponse>('astral_recording_import_finalize', {
        sessionId: importSession.sessionId
      });
    } catch (error) {
      await core.invoke<void>('astral_recording_import_abort', {
        sessionId: importSession.sessionId
      }).catch(() => undefined);
      throw error;
    }
  }

  async getFileUrl(filePath: string): Promise<string> {
    if (this.isUrlLike(filePath)) {
      return filePath;
    }

    const core = await this.requireCore();
    return core.convertFileSrc(filePath);
  }

  resolveImportedMediaPath(imported: AstralRecordingImportResponse, sourcePath: unknown): string | null {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      return null;
    }

    if (imported.files) {
      return this.resolveBrowserImportedMediaPath(imported, sourcePath);
    }

    return this.resolveDesktopImportedMediaPath(imported.sessionDir, sourcePath);
  }

  async getImportedFileUrl(
    imported: AstralRecordingImportResponse,
    filePath: string,
    mimeType?: string
  ): Promise<string> {
    const browserFile = this.findBrowserImportedFile(imported, filePath);
    if (browserFile) {
      if (!browserFile.url) {
        const blob = mimeType && browserFile.blob.type !== mimeType
          ? browserFile.blob.slice(0, browserFile.blob.size, mimeType)
          : browserFile.blob;
        browserFile.url = URL.createObjectURL(blob);
      }

      return browserFile.url;
    }

    return this.getFileUrl(filePath);
  }

  private async importBrowserPackageFromStream(
    sourceStream: ReadableStream<Uint8Array>,
    fileName: string,
    packageSize: number
  ): Promise<AstralRecordingImportResponse> {
    const DecompressionStreamCtor = (globalThis as any).DecompressionStream;
    if (typeof DecompressionStreamCtor !== 'function') {
      throw new Error('This browser cannot decompress .astral recordings.');
    }

    const gzipStream = await this.stripAstralMagic(sourceStream);
    const decompressedStream = gzipStream.pipeThrough(
      new DecompressionStreamCtor('gzip')
    ) as ReadableStream<Uint8Array>;
    const archive = await this.readBrowserAstralArchive(decompressedStream);
    const sessionId = this.createBrowserImportSessionId(fileName);

    return {
      sessionId,
      sessionDir: `browser:${sessionId}`,
      packagePath: this.ensureAstralFilename(fileName),
      packageSize,
      manifest: archive.manifest,
      files: archive.files
    };
  }

  private async stripAstralMagic(sourceStream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    const reader = sourceStream.getReader();
    let header = new Uint8Array(0);

    while (header.byteLength < ASTRAL_MAGIC_BYTES.byteLength) {
      const { done, value } = await reader.read();
      if (done || !value) {
        reader.releaseLock();
        throw new Error('Invalid .astral recording package.');
      }

      header = this.concatBytes(header, value);
    }

    const magic = header.slice(0, ASTRAL_MAGIC_BYTES.byteLength);
    if (!this.bytesEqual(magic, ASTRAL_MAGIC_BYTES)) {
      reader.releaseLock();
      throw new Error('Invalid .astral recording package.');
    }

    const firstChunk = header.slice(ASTRAL_MAGIC_BYTES.byteLength);
    return new ReadableStream<Uint8Array>({
      start: controller => {
        if (firstChunk.byteLength > 0) {
          controller.enqueue(firstChunk);
        }

        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                break;
              }

              if (value?.byteLength) {
                controller.enqueue(value);
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        };

        void pump();
      },
      cancel: reason => reader.cancel(reason)
    });
  }

  private async readBrowserAstralArchive(
    stream: ReadableStream<Uint8Array>
  ): Promise<{ manifest: any; files: Record<string, AstralImportedBrowserFile> }> {
    const archiveReader = new AstralArchiveByteReader(stream);
    const textDecoder = new TextDecoder();
    const files: Record<string, AstralImportedBrowserFile> = {};
    let manifest: any = null;

    while (true) {
      const pathLengthBytes = await archiveReader.readExact(4);
      const pathLength = this.readUint32Le(pathLengthBytes);
      if (pathLength === 0) {
        break;
      }

      if (pathLength > 4096) {
        throw new Error('Astral package contains a path that is too long.');
      }

      const fileSize = this.readUint64Le(await archiveReader.readExact(8));
      const relativePath = textDecoder.decode(await archiveReader.readExact(pathLength));
      const normalizedPath = this.normalizeArchiveRelativePath(relativePath);
      const mimeType = this.guessMimeType(normalizedPath);
      const blob = await archiveReader.readBlob(fileSize, mimeType);

      files[normalizedPath] = {
        path: normalizedPath,
        blob,
        size: blob.size,
        mimeType
      };

      if (normalizedPath === 'manifest.json') {
        manifest = JSON.parse(await blob.text());
      }
    }

    if (!manifest) {
      throw new Error('Astral package is missing manifest.json.');
    }

    return { manifest, files };
  }

  private resolveBrowserImportedMediaPath(
    imported: AstralRecordingImportResponse,
    sourcePath: string
  ): string | null {
    const candidates = this.getImportedPathCandidates(imported.sessionDir, sourcePath);
    return candidates.find(candidate => !!imported.files?.[candidate]) ?? null;
  }

  private resolveDesktopImportedMediaPath(sessionDir: string, sourcePath: string): string | null {
    const normalizedPath = sourcePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    const participantsMarker = '/participants/';
    const participantsIndex = lowerPath.lastIndexOf(participantsMarker);
    if (participantsIndex >= 0) {
      return this.joinImportedAstralPath(sessionDir, normalizedPath.slice(participantsIndex + 1));
    }

    if (lowerPath.startsWith('participants/')) {
      return this.joinImportedAstralPath(sessionDir, normalizedPath);
    }

    const normalizedSessionDir = sessionDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (lowerPath.startsWith(`${normalizedSessionDir}/`)) {
      return sourcePath;
    }

    if (!normalizedPath.startsWith('/') && !/^[a-zA-Z]:\//.test(normalizedPath)) {
      return this.joinImportedAstralPath(sessionDir, normalizedPath);
    }

    return null;
  }

  private findBrowserImportedFile(
    imported: AstralRecordingImportResponse,
    filePath: string
  ): AstralImportedBrowserFile | null {
    if (!imported.files) {
      return null;
    }

    const candidates = this.getImportedPathCandidates(imported.sessionDir, filePath);
    for (const candidate of candidates) {
      const file = imported.files[candidate];
      if (file) {
        return file;
      }
    }

    return null;
  }

  private getImportedPathCandidates(sessionDir: string, sourcePath: string): string[] {
    const normalizedPath = sourcePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    const candidates = new Set<string>();
    const addCandidate = (candidate: string) => {
      try {
        candidates.add(this.normalizeArchiveRelativePath(candidate));
      } catch {
        // Ignore invalid package paths from old or malformed manifests.
      }
    };

    const participantsMarker = '/participants/';
    const participantsIndex = lowerPath.lastIndexOf(participantsMarker);
    if (participantsIndex >= 0) {
      addCandidate(normalizedPath.slice(participantsIndex + 1));
    }

    const normalizedSessionDir = sessionDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedSessionDir && lowerPath.startsWith(`${normalizedSessionDir}/`)) {
      addCandidate(normalizedPath.slice(normalizedSessionDir.length + 1));
    }

    if (!normalizedPath.startsWith('/') && !/^[a-zA-Z]:\//.test(normalizedPath)) {
      addCandidate(normalizedPath);
    }

    return Array.from(candidates);
  }

  private normalizeArchiveRelativePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').trim();
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
      throw new Error('Astral package contains an invalid path.');
    }

    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      throw new Error('Astral package contains an invalid path.');
    }

    return parts.join('/');
  }

  private joinImportedAstralPath(sessionDir: string, relativePath: string): string {
    const separator = sessionDir.includes('\\') ? '\\' : '/';
    const cleanSessionDir = sessionDir.replace(/[\\/]+$/, '');
    const cleanRelativePath = relativePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, separator);
    return `${cleanSessionDir}${separator}${cleanRelativePath}`;
  }

  private guessMimeType(path: string): string {
    const extension = path.split(/[?#]/)[0].toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (extension === 'webm') return 'video/webm';
    if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
    if (extension === 'mov') return 'video/quicktime';
    if (extension === 'ogg' || extension === 'oga') return 'audio/ogg';
    if (extension === 'opus') return 'audio/ogg; codecs=opus';
    if (extension === 'mp3') return 'audio/mpeg';
    if (extension === 'wav') return 'audio/wav';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'png') return 'image/png';
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'gif') return 'image/gif';
    if (extension === 'json') return 'application/json';
    return 'application/octet-stream';
  }

  private readUint32Le(bytes: Uint8Array): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  }

  private readUint64Le(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const low = view.getUint32(0, true);
    const high = view.getUint32(4, true);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) {
      throw new Error('Astral package contains a file that is too large for browser playback.');
    }

    return value;
  }

  private concatBytes(
    first: Uint8Array<ArrayBufferLike>,
    second: Uint8Array<ArrayBufferLike>
  ): Uint8Array<ArrayBuffer> {
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first, 0);
    combined.set(second, first.byteLength);
    return combined;
  }

  private bytesEqual(first: Uint8Array<ArrayBufferLike>, second: Uint8Array<ArrayBufferLike>): boolean {
    if (first.byteLength !== second.byteLength) {
      return false;
    }

    for (let index = 0; index < first.byteLength; index += 1) {
      if (first[index] !== second[index]) {
        return false;
      }
    }

    return true;
  }

  private isUrlLike(value: string): boolean {
    return /^(blob:|data:|https?:|asset\.localhost\/|ddplatform:)/i.test(value);
  }

  private async requireCore(): Promise<TauriCoreApi> {
    const core = await this.getCore();
    if (!core?.isTauri()) {
      throw new Error('Astral recording storage is only available in the Tauri desktop app.');
    }

    return core;
  }

  private async getCore(): Promise<TauriCoreApi | null> {
    if (!this.corePromise) {
      this.corePromise = import('@tauri-apps/api/core')
        .then(core => core as TauriCoreApi)
        .catch(() => null);
    }

    return this.corePromise;
  }

  private getNativeFilePath(file: File): string | null {
    const candidate = (file as File & { path?: unknown }).path;
    return typeof candidate === 'string' && candidate.trim().toLowerCase().endsWith('.astral')
      ? candidate
      : null;
  }

  private ensureAstralFilename(fileName: string): string {
    return fileName.toLowerCase().endsWith('.astral') ? fileName : `${fileName}.astral`;
  }

  private createBrowserImportSessionId(fileName: string): string {
    const stem = this.ensureAstralFilename(fileName)
      .replace(/\.astral$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'recording';
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

    return `astral-browser-${Date.now()}-${randomPart}-${stem}`;
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    return this.bytesToBase64(new Uint8Array(buffer));
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
  }
}

class AstralArchiveByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private streamDone = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readExact(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Astral package contains an invalid file length.');
    }

    const output = new Uint8Array(length);
    let copied = 0;

    while (copied < length) {
      if (!(await this.ensureAvailable())) {
        throw new Error('Astral package ended unexpectedly.');
      }

      const current = this.chunks[0];
      const available = current.byteLength - this.offset;
      const take = Math.min(available, length - copied);
      output.set(current.subarray(this.offset, this.offset + take), copied);
      copied += take;
      this.offset += take;
      this.discardConsumedChunk();
    }

    return output;
  }

  async readBlob(length: number, mimeType: string): Promise<Blob> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Astral package contains an invalid file length.');
    }

    const parts: BlobPart[] = [];
    let remaining = length;

    while (remaining > 0) {
      if (!(await this.ensureAvailable())) {
        throw new Error('Astral package ended before a file was fully read.');
      }

      const current = this.chunks[0];
      const available = current.byteLength - this.offset;
      const take = Math.min(available, remaining);
      const part = new Uint8Array(take);
      part.set(current.subarray(this.offset, this.offset + take));
      parts.push(part);
      this.offset += take;
      remaining -= take;
      this.discardConsumedChunk();
    }

    return new Blob(parts, { type: mimeType });
  }

  private async ensureAvailable(): Promise<boolean> {
    while (!this.chunks.length && !this.streamDone) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.streamDone = true;
        this.reader.releaseLock();
        break;
      }

      if (value?.byteLength) {
        this.chunks.push(value);
      }
    }

    return this.chunks.length > 0;
  }

  private discardConsumedChunk() {
    if (!this.chunks.length) {
      return;
    }

    if (this.offset >= this.chunks[0].byteLength) {
      this.chunks.shift();
      this.offset = 0;
    }
  }
}

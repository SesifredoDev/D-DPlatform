import { Injectable } from '@angular/core';

interface TauriCoreApi {
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

export interface AstralRecordingWriteChunkInput {
  sessionId: string;
  participantId: string;
  segmentIndex: number;
  mimeType: string;
  startedAtMs: number;
  chunkStartedAtMs: number;
  blob: Blob;
}

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

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
  }
}

import { Injectable } from '@angular/core';
import type { TauriCoreApi } from '../../models/astral-recording/astral-recording.model';

export interface CallStreamingStartOptions {
  sessionId: string;
  outputUrl: string;
  width: number;
  height: number;
  frameRate: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

@Injectable({ providedIn: 'root' })
export class CallStreamingService {
  private corePromise: Promise<TauriCoreApi | null> | null = null;

  async isAvailable(): Promise<boolean> {
    const core = await this.getCore();
    return !!core?.isTauri();
  }

  async start(options: CallStreamingStartOptions): Promise<void> {
    const core = await this.requireCore();
    await core.invoke<void>('call_streaming_start', options as unknown as Record<string, unknown>);
  }

  async writeChunk(sessionId: string, blob: Blob): Promise<void> {
    const core = await this.requireCore();
    await core.invoke<void>('call_streaming_write_chunk', {
      sessionId,
      dataBase64: await this.blobToBase64(blob)
    });
  }

  async stop(sessionId: string): Promise<void> {
    const core = await this.requireCore();
    await core.invoke<void>('call_streaming_stop', { sessionId });
  }

  private async requireCore(): Promise<TauriCoreApi> {
    const core = await this.getCore();
    if (!core?.isTauri()) {
      throw new Error('OBS media output is only available in the Tauri desktop app.');
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

    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
  }
}

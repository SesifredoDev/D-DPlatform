import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface SharedStateEnvelope<T = unknown> {
  key: string;
  value: T | null;
  sourceId: string;
  updatedAt: number;
  sequence: number;
}

type SharedStateMessage<T = unknown> =
  | ({ type: 'state' } & SharedStateEnvelope<T>)
  | { type: 'state-request'; sourceId: string; requestedAt: number };

@Injectable({ providedIn: 'root' })
export class SharedWindowStateService implements OnDestroy {
  private static readonly channelName = 'dd-platform-window-state';
  private static readonly tauriEvent = 'dd-platform-window-state-sync';
  private static readonly storagePrefix = 'dd-platform-shared-state:';

  private readonly instanceId = this.createInstanceId();
  private readonly subjects = new Map<string, BehaviorSubject<unknown | null>>();
  private readonly knownKeys = new Set<string>();
  private readonly broadcastChannel?: BroadcastChannel;
  private tauriUnlisten?: UnlistenFn;
  private sequence = 0;

  constructor() {
    this.broadcastChannel = this.createBroadcastChannel();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
    }

    void this.setupTauriSync().finally(() => {
      queueMicrotask(() => this.requestRemoteState());
    });
  }

  ngOnDestroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
    }

    this.broadcastChannel?.close();
    this.tauriUnlisten?.();
  }

  observe<T>(key: string, fallback: T | null = null): Observable<T | null> {
    return this.getSubject<T>(key, fallback).asObservable();
  }

  getSnapshot<T>(key: string, fallback: T | null = null): T | null {
    this.knownKeys.add(key);
    return this.readStoredEnvelope<T>(key)?.value ?? fallback;
  }

  publish<T>(key: string, value: T | null): void {
    const envelope: SharedStateEnvelope<T> = {
      key,
      value,
      sourceId: this.instanceId,
      updatedAt: Date.now(),
      sequence: ++this.sequence
    };

    this.writeStoredEnvelope(envelope);
    this.applyEnvelope(envelope);
    this.broadcastMessage({ type: 'state', ...envelope });
  }

  private getSubject<T>(key: string, fallback: T | null): BehaviorSubject<T | null> {
    this.knownKeys.add(key);
    const existing = this.subjects.get(key) as BehaviorSubject<T | null> | undefined;
    if (existing) return existing;

    const initialValue = this.readStoredEnvelope<T>(key)?.value ?? fallback;
    const subject = new BehaviorSubject<T | null>(initialValue);
    this.subjects.set(key, subject as BehaviorSubject<unknown | null>);
    return subject;
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (!event.key?.startsWith(SharedWindowStateService.storagePrefix) || !event.newValue) {
      return;
    }

    const envelope = this.parseEnvelope(event.newValue);
    if (envelope) {
      this.applyEnvelope(envelope);
    }
  };

  private handleMessage(message: SharedStateMessage | null | undefined) {
    if (!message || message.sourceId === this.instanceId) return;

    if (message.type === 'state-request') {
      this.broadcastKnownState();
      return;
    }

    this.writeStoredEnvelope(message);
    this.applyEnvelope(message);
  }

  private applyEnvelope<T>(envelope: SharedStateEnvelope<T>) {
    this.knownKeys.add(envelope.key);
    const subject = this.subjects.get(envelope.key) as BehaviorSubject<T | null> | undefined;
    subject?.next(envelope.value);
  }

  private requestRemoteState() {
    this.broadcastMessage({
      type: 'state-request',
      sourceId: this.instanceId,
      requestedAt: Date.now()
    });
  }

  private broadcastKnownState() {
    for (const envelope of this.readAllStoredEnvelopes()) {
      this.broadcastMessage({ type: 'state', ...envelope });
    }
  }

  private broadcastMessage(message: SharedStateMessage) {
    this.broadcastChannel?.postMessage(message);

    if (!this.isTauriRuntime()) return;
    void import('@tauri-apps/api/event')
      .then(({ emit }) => emit(SharedWindowStateService.tauriEvent, message))
      .catch(error => console.warn('Failed to broadcast shared window state', error));
  }

  private createBroadcastChannel(): BroadcastChannel | undefined {
    if (typeof BroadcastChannel === 'undefined') return undefined;

    const channel = new BroadcastChannel(SharedWindowStateService.channelName);
    channel.onmessage = event => this.handleMessage(event.data as SharedStateMessage);
    return channel;
  }

  private async setupTauriSync() {
    if (!this.isTauriRuntime()) return;

    try {
      const { listen } = await import('@tauri-apps/api/event');
      this.tauriUnlisten = await listen<SharedStateMessage>(
        SharedWindowStateService.tauriEvent,
        event => this.handleMessage(event.payload)
      );
    } catch (error) {
      console.warn('Tauri shared window state is unavailable', error);
    }
  }

  private readStoredEnvelope<T>(key: string): SharedStateEnvelope<T> | null {
    try {
      return this.parseEnvelope<T>(
        localStorage.getItem(`${SharedWindowStateService.storagePrefix}${key}`)
      );
    } catch {
      return null;
    }
  }

  private readAllStoredEnvelopes(): SharedStateEnvelope[] {
    const envelopes: SharedStateEnvelope[] = [];

    try {
      for (let index = 0; index < localStorage.length; index++) {
        const storageKey = localStorage.key(index);
        if (!storageKey?.startsWith(SharedWindowStateService.storagePrefix)) continue;

        const envelope = this.parseEnvelope(localStorage.getItem(storageKey));
        if (envelope) {
          envelopes.push(envelope);
        }
      }
    } catch {
      return envelopes;
    }

    return envelopes;
  }

  private writeStoredEnvelope(envelope: SharedStateEnvelope) {
    try {
      localStorage.setItem(
        `${SharedWindowStateService.storagePrefix}${envelope.key}`,
        JSON.stringify(envelope)
      );
    } catch (error) {
      console.warn('Failed to persist shared window state', envelope.key, error);
    }
  }

  private parseEnvelope<T>(value: string | null): SharedStateEnvelope<T> | null {
    if (!value) return null;

    try {
      const envelope = JSON.parse(value) as Partial<SharedStateEnvelope<T>>;
      if (!envelope.key || !envelope.sourceId || !envelope.updatedAt || !envelope.sequence) {
        return null;
      }

      return {
        key: envelope.key,
        value: envelope.value ?? null,
        sourceId: envelope.sourceId,
        updatedAt: envelope.updatedAt,
        sequence: envelope.sequence
      };
    } catch {
      return null;
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  private createInstanceId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

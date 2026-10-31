import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import {
  DEFAULT_PLAYER_SETTINGS,
  IPlayerSettings
} from '../../models/objects/player-settings-dialog/player-settings-dialog.model';

/**
 * Per-device player preferences, persisted to localStorage.
 * Anything that needs a setting should subscribe to `settings$` (or read `snapshot`).
 */
@Injectable({ providedIn: 'root' })
export class PlayerSettingsService {
  private static readonly storageKey = 'player-settings:v1';

  private readonly subject = new BehaviorSubject<IPlayerSettings>(this.load());
  readonly settings$ = this.subject.asObservable();

  constructor() {
    this.applyToDocument(this.subject.value);
  }

  get snapshot(): IPlayerSettings {
    return this.subject.value;
  }

  update(next: IPlayerSettings): void {
    const clean = this.sanitize(next);
    this.persist(clean);
    this.applyToDocument(clean);
    this.subject.next(clean);
  }

  reset(): void {
    this.update(DEFAULT_PLAYER_SETTINGS);
  }

  private load(): IPlayerSettings {
    if (typeof window === 'undefined') return this.sanitize(null);

    try {
      const raw = window.localStorage.getItem(PlayerSettingsService.storageKey);
      return this.sanitize(raw ? JSON.parse(raw) : null);
    } catch {
      return this.sanitize(null);
    }
  }

  private persist(settings: IPlayerSettings): void {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(PlayerSettingsService.storageKey, JSON.stringify(settings));
    } catch (error) {
      console.warn('Failed to persist player settings', error);
    }
  }

  /** Keeps only known keys whose stored type matches the default's type. */
  private sanitize(raw: unknown): IPlayerSettings {
    const base = structuredClone(DEFAULT_PLAYER_SETTINGS) as unknown as Record<string, Record<string, unknown>>;

    if (raw && typeof raw === 'object') {
      for (const section of Object.keys(base)) {
        const incoming = (raw as Record<string, unknown>)[section];
        if (!incoming || typeof incoming !== 'object') continue;

        for (const key of Object.keys(base[section])) {
          const value = (incoming as Record<string, unknown>)[key];
          if (typeof value === typeof base[section][key]) base[section][key] = value;
        }
      }
    }

    return base as unknown as IPlayerSettings;
  }

  private applyToDocument(settings: IPlayerSettings): void {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('reduce-motion', settings.interface.reduceMotion);
  }
}

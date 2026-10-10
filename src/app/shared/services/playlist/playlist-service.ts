import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map, Observable } from 'rxjs';

import { environment } from '../../../../environments/environment';

export interface Tag {
  name: string;
  description: string;
  cover: string;
}

export interface MTag extends Tag {}
export interface ATag extends Tag {}

export interface Song {
  cover: string;
  audioUrl?: string;
  fileName: string;
  attribution?: string;
  moods: MTag[];
  atmosphere: ATag[];
}

interface SongsResponse {
  items?: Song[];
}

@Injectable({ providedIn: 'root' })
export class PlaylistService {
  private readonly baseUrl = new URL('music/', environment.apiURL).toString();

  constructor(private http: HttpClient) {}

  getSongs(): Observable<Song[]> {
    return this.http.get<Song[] | SongsResponse>(new URL('songs', this.baseUrl).toString()).pipe(
      map(response => {
        const items = Array.isArray(response)
          ? response
          : (Array.isArray(response?.items) ? response.items : []);
        return items.map(item => this.normalizeSong(item));
      })
    );
  }

  getMoodNames(): Observable<string[]> {
    return this.getSongs().pipe(
      map(items => this.uniqueSortedNames(
        items.flatMap(song => (song.moods ?? []).map(tag => tag?.name))
      ))
    );
  }

  getAtmosphereNamesByMood(moodName: string): Observable<string[]> {
    const normalizedMood = this.normalizeName(moodName);
    return this.getSongs().pipe(
      map(items => {
        const filtered = !normalizedMood
          ? items
          : items.filter(song => (song.moods ?? []).some(tag => this.normalizeName(tag?.name) === normalizedMood));

        return this.uniqueSortedNames(
          filtered.flatMap(song => (song.atmosphere ?? []).map(tag => tag?.name))
        );
      })
    );
  }

  getSongsByMoodAndAtmosphere(moodName: string, atmosphereName: string): Observable<Song[]> {
    const normalizedMood = this.normalizeName(moodName);
    const normalizedAtmosphere = this.normalizeName(atmosphereName);

    return this.getSongs().pipe(
      map(items => items.filter(song => {
        const moodMatches = !normalizedMood
          || (song.moods ?? []).some(tag => this.normalizeName(tag?.name) === normalizedMood);
        const atmosphereMatches = !normalizedAtmosphere
          || (song.atmosphere ?? []).some(tag => this.normalizeName(tag?.name) === normalizedAtmosphere);
        return moodMatches && atmosphereMatches;
      }))
    );
  }

  searchSongs(query: string): Observable<Song[]> {
    const normalizedQuery = query.trim().toLowerCase();
    return this.getSongs().pipe(
      map(items => {
        if (!normalizedQuery) {
          return items;
        }

        return items.filter(song => {
          const metadata = [
            song.fileName,
            ...(song.moods ?? []).map(tag => tag.name),
            ...(song.atmosphere ?? []).map(tag => tag.name)
          ].join(' ').toLowerCase();

          return metadata.includes(normalizedQuery);
        });
      })
    );
  }

  getSongByFileName(fileName: string): Observable<Song | null> {
    return this.getSongs().pipe(
      map(items => items.find(song => song.fileName === fileName) ?? null)
    );
  }

  getSongStreamUrl(fileName: string): string {
    return new URL(`stream/${encodeURIComponent(fileName)}`, this.baseUrl).toString();
  }

  private resolveFileUrl(value: string | undefined | null): string {
    const raw = `${value ?? ''}`.trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (parsed.pathname.startsWith('/api/files/')) {
          return new URL(parsed.pathname.replace(/^\/api\//, ''), environment.apiURL).toString();
        }
        return raw;
      } catch {
        return raw;
      }
    }

    const normalizedPath = raw.startsWith('/api/files/')
      ? raw
      : `/api/files/${raw.replace(/^\/+/, '')}`;

    return new URL(normalizedPath.replace(/^\/api\//, ''), environment.apiURL).toString();
  }

  private normalizeSong(song: Song): Song {
    return {
      ...song,
      cover: this.resolveFileUrl(song.cover),
      audioUrl: this.resolveFileUrl(song.audioUrl),
      moods: (song.moods ?? []).map(tag => ({ ...tag, cover: this.resolveFileUrl(tag.cover) })),
      atmosphere: (song.atmosphere ?? []).map(tag => ({ ...tag, cover: this.resolveFileUrl(tag.cover) }))
    };
  }

  private uniqueSortedNames(values: Array<string | undefined | null>): string[] {
    const seen = new Map<string, string>();
    for (const value of values) {
      const original = `${value ?? ''}`.trim();
      if (!original) continue;
      const normalized = this.normalizeName(original);
      if (!seen.has(normalized)) {
        seen.set(normalized, original);
      }
    }

    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }

  private normalizeName(value: string | undefined | null): string {
    return `${value ?? ''}`.trim().toLowerCase();
  }
}

import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type { AstralPlaybackDropRequest } from '../../models/astral-recording/astral-playback-drop.model';
export type { AstralPlaybackDropRequest } from '../../models/astral-recording/astral-playback-drop.model';
@Injectable({ providedIn: 'root' })
export class AstralPlaybackDropService {
  private readonly requestSubject = new Subject<AstralPlaybackDropRequest>();
  private readonly pendingRequests = new Map<string, AstralPlaybackDropRequest>();
  readonly requests$ = this.requestSubject.asObservable();

  requestPlayback(request: AstralPlaybackDropRequest) {
    this.pendingRequests.set(request.channelId, request);
    this.requestSubject.next(request);
  }

  takePendingRequest(channelId: string): AstralPlaybackDropRequest | null {
    const request = this.pendingRequests.get(channelId) ?? null;
    if (request) {
      this.pendingRequests.delete(channelId);
    }

    return request;
  }

  clearPendingRequest(request: AstralPlaybackDropRequest) {
    if (this.pendingRequests.get(request.channelId) === request) {
      this.pendingRequests.delete(request.channelId);
    }
  }
}

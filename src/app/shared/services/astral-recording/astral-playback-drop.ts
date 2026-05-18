import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type { AstralPlaybackDropRequest } from '../../models/astral-recording/astral-playback-drop.model';
export type { AstralPlaybackDropRequest } from '../../models/astral-recording/astral-playback-drop.model';
@Injectable({ providedIn: 'root' })
export class AstralPlaybackDropService {
  private readonly requestSubject = new Subject<AstralPlaybackDropRequest>();
  readonly requests$ = this.requestSubject.asObservable();

  requestPlayback(request: AstralPlaybackDropRequest) {
    this.requestSubject.next(request);
  }
}

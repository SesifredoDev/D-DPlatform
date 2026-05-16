import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface AstralPlaybackDropRequest {
  channelId: string;
  file?: File;
  url?: string;
  filename?: string;
}

@Injectable({ providedIn: 'root' })
export class AstralPlaybackDropService {
  private readonly requestSubject = new Subject<AstralPlaybackDropRequest>();
  readonly requests$ = this.requestSubject.asObservable();

  requestPlayback(request: AstralPlaybackDropRequest) {
    this.requestSubject.next(request);
  }
}

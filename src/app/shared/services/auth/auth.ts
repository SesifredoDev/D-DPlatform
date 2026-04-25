import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, finalize, map, shareReplay, tap } from 'rxjs/operators';
import { Observable, of } from 'rxjs';
import { TokenService } from './token';
import {environment} from '../../../../environments/environment';
import {Router} from '@angular/router';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly API = environment.apiURL + 'auth';
  private restoreSessionRequest$?: Observable<boolean>;
  private hasAttemptedSessionRestore = false;

  constructor(
    private http: HttpClient,
    private tokenService: TokenService,
    private router: Router,
  ) {}

  login(email: string, password: string): Observable<{ accessToken: string }> {
    return this.http
      .post<{ accessToken: string }>(
        `${this.API}/login`,
        { email, password },
        { withCredentials: true }
      )
      .pipe(
        tap(res => {
          this.tokenService.setAccessToken(res.accessToken);
          this.hasAttemptedSessionRestore = true;
          this.router.navigate(['']);
        })
      );
  }

  register(username:string,email: string, password: string): Observable<any> {
    return this.http.post(`${this.API}/register`, { username, email, password },  { withCredentials: true });
  }

  refresh(): Observable<{ accessToken: string }> {
    return this.http
      .post<{ accessToken: string }>(
        `${this.API}/refresh`,
        {},
        { withCredentials: true }
      )
      .pipe(
        tap(res => {
          this.tokenService.setAccessToken(res.accessToken);
          this.hasAttemptedSessionRestore = true;
        })
      );
  }

  logout(): void {
    this.tokenService.clear();
    this.hasAttemptedSessionRestore = false;
    this.restoreSessionRequest$ = undefined;

    this.http.post<void>(
      `${this.API}/logout`,
      {},
      { withCredentials: true }
    ).subscribe({
      error: () => {
        // Local logout should still complete even if the backend request fails.
      }
    });

    this.router.navigate(['auth']);
  }

  restoreSession(): Observable<boolean> {
    if (this.tokenService.getAccessToken()) {
      this.hasAttemptedSessionRestore = true;
      return of(true);
    }

    if (this.restoreSessionRequest$) {
      return this.restoreSessionRequest$;
    }

    if (this.hasAttemptedSessionRestore) {
      return of(false);
    }

    this.hasAttemptedSessionRestore = true;
    this.restoreSessionRequest$ = this.refresh().pipe(
      map(() => true),
      catchError(() => {
        this.tokenService.clear();
        return of(false);
      }),
      finalize(() => {
        this.restoreSessionRequest$ = undefined;
      }),
      shareReplay(1)
    );

    return this.restoreSessionRequest$;
  }

  getCurrentUserId(): string | null {
    const token = this.tokenService.getAccessToken();
    if (!token) return null;

    try {
      const payload = token.split('.')[1];
      if (!payload) return null;

      const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decodedPayload = atob(normalizedPayload);
      const parsed = JSON.parse(decodedPayload);

      return parsed.userId || parsed._id || parsed.sub || parsed.id || null;
    } catch {
      return null;
    }
  }
}

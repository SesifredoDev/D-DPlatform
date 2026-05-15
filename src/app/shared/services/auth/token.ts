import { Injectable } from '@angular/core';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';

const ACCESS_TOKEN_KEY = 'access_token';
const ACCESS_TOKEN_STATE_KEY = 'auth:access-token';

@Injectable({
  providedIn: 'root',
})
export class TokenService {
  constructor(private sharedWindowState: SharedWindowStateService) {
    const sharedToken = this.sharedWindowState.getSnapshot<string>(ACCESS_TOKEN_STATE_KEY, null);
    if (sharedToken) {
      localStorage.setItem(ACCESS_TOKEN_KEY, sharedToken);
    } else {
      const localToken = localStorage.getItem(ACCESS_TOKEN_KEY);
      if (localToken) {
        this.sharedWindowState.publish(ACCESS_TOKEN_STATE_KEY, localToken);
      }
    }

    this.sharedWindowState.observe<string>(ACCESS_TOKEN_STATE_KEY, null)
      .subscribe(token => {
        const currentToken = localStorage.getItem(ACCESS_TOKEN_KEY);
        if (token && token !== currentToken) {
          localStorage.setItem(ACCESS_TOKEN_KEY, token);
        } else if (!token && currentToken) {
          localStorage.removeItem(ACCESS_TOKEN_KEY);
        }
      });
  }

  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  setAccessToken(token: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
    this.sharedWindowState.publish(ACCESS_TOKEN_STATE_KEY, token);
  }

  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    this.sharedWindowState.publish(ACCESS_TOKEN_STATE_KEY, null);
  }

  isLoggedIn(): boolean {
    return this.hasValidAccessToken();
  }

  hasValidAccessToken(): boolean {
    const token = this.getAccessToken();
    return !!token && !this.isTokenExpired(token);
  }

  isTokenExpired(token: string): boolean {
    try {
      const payload = this.parseJwtPayload(token);
      const exp = payload?.['exp'];

      if (typeof exp !== 'number') {
        return true;
      }

      return exp * 1000 <= Date.now();
    } catch {
      return true;
    }
  }

  private parseJwtPayload(token: string): Record<string, unknown> | null {
    const payload = token.split('.')[1];
    if (!payload) {
      return null;
    }

    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - normalizedPayload.length % 4) % 4),
      '='
    );

    return JSON.parse(atob(paddedPayload)) as Record<string, unknown>;
  }
}

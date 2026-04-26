import { Injectable } from '@angular/core';

const ACCESS_TOKEN_KEY = 'access_token';

@Injectable({
  providedIn: 'root',
})
export class TokenService {
  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  setAccessToken(token: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  }

  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
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
      const exp = payload?.exp;

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

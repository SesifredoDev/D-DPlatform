import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
  HttpErrorResponse,
} from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, throwError, switchMap, catchError } from 'rxjs';
import {TokenService} from '../services/auth/token';
import {AuthService} from '../services/auth/auth';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(
    private tokenService: TokenService,
    private authService: AuthService
  ) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // 1. Skip if it's an external API (like Spotify)
    if (req.url.includes('api.spotify.com')) {
      return next.handle(req);
    }

    // 2. Skip if it's the auth endpoint itself
    if (req.url.includes('/auth')){
      return next.handle(req);
    }

    const token = this.tokenService.getAccessToken();
    const authReq = token
      ? req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
        withCredentials: true,
      })
      : req.clone({ withCredentials: true });

    return next.handle(authReq).pipe(
      catchError(err => {
        if (err instanceof HttpErrorResponse && err.status === 401) {
          return this.handleRefresh(authReq, next);
        }
        return throwError(() => err);
      })
    );
  }

  private handleRefresh(
    req: HttpRequest<any>,
    next: HttpHandler
  ): Observable<HttpEvent<any>> {
    return this.authService.refresh().pipe(
      switchMap(res => {
        const retryReq = req.clone({
          setHeaders: {
            Authorization: `Bearer ${res.accessToken}`,
          },
        });
        return next.handle(retryReq);
      }),
      catchError(err => {
        this.tokenService.clear();
        return throwError(() => err);
      })
    );
  }
}

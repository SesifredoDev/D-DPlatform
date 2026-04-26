import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { TokenService } from '../services/auth/token';
import { AuthService } from '../services/auth/auth';

@Injectable({
  providedIn: 'root',
})
export class AuthGuard implements CanActivate {
  constructor(
    private tokenService: TokenService,
    private authService: AuthService,
    private router: Router
  ) {}

  canActivate(): boolean | UrlTree | Observable<boolean | UrlTree> {
    if (this.tokenService.hasValidAccessToken()) {
      return true;
    }

    return this.authService.restoreSession().pipe(
      map((isAuthenticated) => isAuthenticated ? true : this.router.createUrlTree(['auth']))
    );
  }
}

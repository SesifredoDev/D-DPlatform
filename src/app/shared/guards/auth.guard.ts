import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import {TokenService} from '../services/auth/token';

@Injectable({
  providedIn: 'root',
})
export class AuthGuard implements CanActivate {
  constructor(
    private tokenService: TokenService,
    private router: Router
  ) {}

  canActivate(): boolean {
    const token = this.tokenService.getAccessToken();

    if (!token) {
      console.warn('AUTH GUARD → NO TOKEN, REDIRECTING');
      this.router.navigate(['']);
      return false;
    }

    console.log('AUTH GUARD → TOKEN FOUND');
    return true;
  }
}

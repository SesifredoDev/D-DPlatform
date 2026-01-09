import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { TokenService } from './token';
import {environment} from '../../../../environments/environment';
import {Router} from '@angular/router';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly API = environment.apiURL + 'auth';

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
        tap(res => {this.tokenService.setAccessToken(res.accessToken)
          this.router.navigate(['dashboard']);
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
        tap(res => this.tokenService.setAccessToken(res.accessToken))
      );
  }

  logout(): void {
    this.tokenService.clear();
    this.http.post<void>(
      `${this.API}/logout`,
      {},
      { withCredentials: true }
    );

    this.router.navigate(['']);
  }
}

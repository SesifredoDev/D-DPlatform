import { Injectable } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { IUser } from '../../models/user/user.model';

export interface ProfileIconUploadResponse {
  message: string;
  user: IUser;
}

@Injectable({
  providedIn: 'root',
})
export class UserService {
  private readonly API = environment.apiURL + 'users';

  constructor(private http: HttpClient) {}

  getMe(): Observable<IUser> {
    console.log('USER SERVICE -> FETCH ME');

    return this.http.get<IUser>(this.API + '/me', { withCredentials: true }).pipe(
      tap(user => {
        console.log('USER SERVICE -> USER:', user);
      })
    );
  }

  uploadProfileIcon(icon: File): Observable<ProfileIconUploadResponse> {
    const formData = new FormData();
    formData.append('icon', icon, icon.name);

    return this.http.post<ProfileIconUploadResponse>(
      `${this.API}/profile-icon`,
      formData,
      { withCredentials: true }
    );
  }
}

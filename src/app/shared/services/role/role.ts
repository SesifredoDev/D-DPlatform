import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { Observable } from 'rxjs';
import {environment} from '../../../../environments/environment';
import {handleApiError} from '../../utils/api-error.util';

@Injectable({
  providedIn: 'root',
})
export class Role {
  private baseUrl = environment.apiURL+'server';

  constructor(private http: HttpClient) {}

  createRole(serverId: string, payload: any): Observable<any> {
    return this.http
      .post(`${this.baseUrl}/${serverId}/roles`, payload, {
        withCredentials: true
      })
      .pipe(catchError(handleApiError));
  }

  updateRole(
    serverId: string,
    roleId: string,
    payload: any
  ): Observable<any> {
    return this.http
      .put(
        `${this.baseUrl}/${serverId}/roles/${roleId}`,
        payload,
        { withCredentials: true }
      )
      .pipe(catchError(handleApiError));
  }

  deleteRole(serverId: string, roleId: string): Observable<any> {
    return this.http
      .delete(
        `${this.baseUrl}/${serverId}/roles/${roleId}`,
        { withCredentials: true }
      )
      .pipe(catchError(handleApiError));
  }
}

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { Observable } from 'rxjs';
import {environment} from '../../../../environments/environment';
import {handleApiError} from '../../utils/api-error.util';
import type { IRolePayload } from '../../models/role/role.model';
export type { IRolePayload } from '../../models/role/role.model';
@Injectable({
  providedIn: 'root',
})
export class Role {
  private baseUrl = environment.apiURL+'server';

  constructor(private http: HttpClient) {}

  createRole(serverId: string, payload: IRolePayload): Observable<any> {
    return this.http
      .post(`${this.baseUrl}/${serverId}/role`, payload, { withCredentials: true })
      .pipe(catchError(handleApiError));
  }

  updateRole(serverId: string, roleId: string, payload: Partial<IRolePayload>): Observable<any> {
    return this.http
      .patch(`${this.baseUrl}/${serverId}/role/${roleId}`, payload, { withCredentials: true })
      .pipe(catchError(handleApiError));
  }

  deleteRole(serverId: string, roleId: string): Observable<any> {
    return this.http
      .delete(`${this.baseUrl}/${serverId}/role/${roleId}`, { withCredentials: true })
      .pipe(catchError(handleApiError));
  }
}

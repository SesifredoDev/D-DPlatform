import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, tap } from 'rxjs/operators';
import { BehaviorSubject, firstValueFrom, Observable, of } from 'rxjs';
import { handleApiError } from '../../utils/api-error.util';
import { environment } from '../../../../environments/environment';
import { IServer } from '../../models/server/server.model';

@Injectable({
  providedIn: 'root',
})
export class ServerService {
  private baseUrl = `${environment.apiURL}server`;

  private myServersSubject = new BehaviorSubject<IServer[]>([]);
  private serverDetailsSubject = new BehaviorSubject<IServer | null>(null);

  constructor(private http: HttpClient) {}

  getMyServersObservable(): Observable<IServer[]> {
    return this.myServersSubject.asObservable();
  }

  getServerDetailsObservable(): Observable<IServer | null> {
    return this.serverDetailsSubject.asObservable();
  }

  getCurrentServer(): IServer | null {
    return this.serverDetailsSubject.value;
  }

  async getMyServers(): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.http.get<IServer[]>(`${this.baseUrl}/list`, { withCredentials: true })
          .pipe(catchError(handleApiError))
      );
      this.myServersSubject.next(data);
    } catch (error) {
      console.error('Failed to fetch servers', error);
    }
  }

  async getServerDetails(serverId: string): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.http.get<IServer>(`${this.baseUrl}/${serverId}`, { withCredentials: true })
          .pipe(catchError(handleApiError))
      );
      this.serverDetailsSubject.next(data);
    } catch (error) {
      console.error('Failed to fetch server details', error);
    }
  }

  // Unified Refresh Helper
  private async refreshData(serverId?: string) {
    await this.getMyServers();
    if (serverId) await this.getServerDetails(serverId);
  }

  async updateServer(serverId: string, name?: string, iconFile?: File | null): Promise<void> {
    const formData = new FormData();
    if (name) formData.append('name', name);
    if (iconFile) formData.append('icon', iconFile);

    // Changed to match the controller logic: /server/:serverId/update
    const updated = await firstValueFrom(
      this.http.post<IServer>(`${this.baseUrl}/${serverId}/update`, formData, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );

    this.serverDetailsSubject.next(updated);
    await this.getMyServers();
  }

  async updateMemberRoles(serverId: string, memberId: string, roles: string[]): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<any>(
        `${this.baseUrl}/${serverId}/role/member/${memberId}`,
        { roles },
        { withCredentials: true }
      ).pipe(catchError(handleApiError))
    );

    // Refreshing details to get the populated role/user objects back
    await this.getServerDetails(serverId);
  }

  async deleteServer(serverId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.baseUrl}/${serverId}`, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    if (this.serverDetailsSubject.value?._id === serverId) {
      this.serverDetailsSubject.next(null);
    }
    await this.getMyServers();
  }

  async leaveServer(serverId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.baseUrl}/${serverId}/leave`, {}, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    if (this.serverDetailsSubject.value?._id === serverId) {
      this.serverDetailsSubject.next(null);
    }
    await this.getMyServers();
  }
  async createServer(name: string, iconFile?: null | File): Promise<void> {
    const formData = new FormData();
    formData.append('name', name);
    if (iconFile) {
      formData.append('icon', iconFile);
    }

    await firstValueFrom(
      this.http.post<IServer>(this.baseUrl, formData, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    await this.getMyServers();
  }

  async joinServer(code: string): Promise<void> {
    await firstValueFrom(
      this.http
        .post(`${this.baseUrl}/join`, { code }, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    await this.getMyServers();
  }

}

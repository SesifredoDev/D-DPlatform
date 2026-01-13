import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';
import { handleApiError } from '../../utils/api-error.util';
import { environment } from '../../../../environments/environment';
import { IServer } from '../../models/server/server.model';

@Injectable({
  providedIn: 'root',
})
export class ServerService {
  private baseUrl = environment.apiURL + 'server';

  private myServersSubject = new BehaviorSubject<IServer[]>([]);
  private serverDetailsSubject = new BehaviorSubject<IServer | null>(null);

  constructor(private http: HttpClient) {}

  getMyServersObservable(): Observable<IServer[]> {
    return this.myServersSubject.asObservable();
  }

  getServerDetailsObservable(): Observable<any | null> {
    return this.serverDetailsSubject.asObservable();
  }

  async getMyServers(): Promise<void> {
    try {
      const data = await firstValueFrom(
        this.http
          .get<IServer[]>(`${this.baseUrl}/list`, { withCredentials: true })
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
        this.http
          .get<IServer>(`${this.baseUrl}/${serverId}`, { withCredentials: true })
          .pipe(catchError(handleApiError))
      );
      this.serverDetailsSubject.next(data);
    } catch (error) {
      console.error('Failed to fetch server details', error);
    }
  }


  async createServer(data: FormData): Promise<void> {
    await firstValueFrom(
      this.http
        .post<IServer>(this.baseUrl, data, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    await this.getMyServers(); // Refresh the list after creation
  }

  async updateServer(serverId: string, data: FormData): Promise<void> {
    const updated = await firstValueFrom(
      this.http
        .put<IServer>(`${this.baseUrl}/${serverId}`, data, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    this.serverDetailsSubject.next(updated); // Update detail view
    await this.getMyServers(); // Update list view
  }

  async deleteServer(serverId: string): Promise<void> {
    await firstValueFrom(
      this.http
        .delete(`${this.baseUrl}/${serverId}`, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );

    if (this.serverDetailsSubject.value?._id === serverId) {
      this.serverDetailsSubject.next(null);
    }
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

  async leaveServer(serverId: string): Promise<void> {
    await firstValueFrom(
      this.http
        .post(`${this.baseUrl}/${serverId}/leave`, {}, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );
    if (this.serverDetailsSubject.value?._id === serverId) {
      this.serverDetailsSubject.next(null);
    }
    await this.getMyServers();
  }

  async updateMemberRoles(serverId: string, memberId: string, roles: string[]): Promise<void> {
    const updated = await firstValueFrom(
      this.http
        .put<IServer>(
          `${this.baseUrl}/${serverId}/members/${memberId}/roles`,
          { roles },
          { withCredentials: true }
        )
        .pipe(catchError(handleApiError))
    );
    this.serverDetailsSubject.next(updated);
  }
}

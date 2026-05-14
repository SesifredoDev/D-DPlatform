import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, tap } from 'rxjs/operators';
import { BehaviorSubject, firstValueFrom, Observable, of } from 'rxjs';
import { handleApiError } from '../../utils/api-error.util';
import { environment } from '../../../../environments/environment';
import { IServer, IServerTheme, ServerMember, TemporaryDmDuration, TemporaryDmGrant } from '../../models/server/server.model';
import { IChannel } from '../../models/server/channel.model';
import { FileService } from '../file/file';
import { ThemeService } from '../theme/theme.service';

@Injectable({
  providedIn: 'root',
})
export class ServerService {
  private baseUrl = `${environment.apiURL}server`;

  private myServersSubject = new BehaviorSubject<IServer[]>([]);
  private serverDetailsSubject = new BehaviorSubject<IServer | null>(null);

  constructor(
    private http: HttpClient,
    private fileService: FileService,
    private themeService: ThemeService
  ) {}

  getMyServersObservable(): Observable<IServer[]> {
    return this.myServersSubject.asObservable();
  }

  getServerDetailsObservable(): Observable<IServer | null> {
    return this.serverDetailsSubject.asObservable();
  }

  getCurrentServer(): IServer | null {
    return this.serverDetailsSubject.value;
  }

  updateCurrentServerMembers(members: ServerMember[]): void {
    const currentServer = this.serverDetailsSubject.value;
    if (!currentServer) return;

    this.serverDetailsSubject.next({
      ...currentServer,
      members
    });
  }

  getServerOwnerId(server: IServer | null | undefined): string {
    if (!server?.owner) return '';
    return typeof server.owner === 'string' ? server.owner : server.owner._id;
  }

  getMemberUserId(member: ServerMember | null | undefined): string {
    const user = member?.user as any;
    if (!user) return '';
    return typeof user === 'string' ? user : user._id;
  }

  isTemporaryDmGrantActive(grant: TemporaryDmGrant | null | undefined): boolean {
    if (!grant?.enabled) return false;
    if (!grant.expiresAt) return true;

    const expiresAt = grant.expiresAt instanceof Date
      ? grant.expiresAt.getTime()
      : new Date(grant.expiresAt).getTime();

    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  isUserTemporaryDm(server: IServer | null | undefined, userId: string | null | undefined): boolean {
    if (!server || !userId) return false;

    const member = server.members?.find(candidate => this.getMemberUserId(candidate) === userId);
    return this.isTemporaryDmGrantActive(member?.temporaryDm);
  }

  canUserDm(server: IServer | null | undefined, userId: string | null | undefined): boolean {
    if (!server || !userId) return false;
    return this.getServerOwnerId(server) === userId || this.isUserTemporaryDm(server, userId);
  }

  async getMyServers(): Promise<void> {
    try {
      let data = await firstValueFrom(
        this.http.get<IServer[]>(`${this.baseUrl}/list`, { withCredentials: true })
          .pipe(catchError(handleApiError))
      );

      // Resolve icon URLs
      data = data.map(server => ({
        ...server,
        icon: server.icon ? this.fileService.resolveFileUrl(server.icon) : null,
        defaultTheme: this.resolveServerThemeAssets(server.defaultTheme)
      }));

      this.myServersSubject.next(data);
    } catch (error) {
      console.error('Failed to fetch servers', error);
    }
  }

  async getServerDetails(serverId: string): Promise<void> {
    try {
      let data = await firstValueFrom(
        this.http.get<IServer>(`${this.baseUrl}/${serverId}`, { withCredentials: true })
          .pipe(catchError(handleApiError))
      );

      // Resolve icon URL
      data = {
        ...data,
        icon: data.icon ? this.fileService.resolveFileUrl(data.icon) : null,
        defaultTheme: this.resolveServerThemeAssets(data.defaultTheme)
      };

      this.themeService.applyServerTheme(data.defaultTheme);
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

  async updateServer(
    serverId: string,
    name?: string,
    iconFile?: File | null,
    defaultTheme?: IServerTheme,
    themeBackgroundImageFile?: File | null
  ): Promise<void> {
    const formData = new FormData();
    if (name) formData.append('name', name);
    if (iconFile) formData.append('icon', iconFile);
    if (defaultTheme) formData.append('defaultTheme', JSON.stringify(defaultTheme));
    if (themeBackgroundImageFile) formData.append('themeBackgroundImage', themeBackgroundImageFile);

    // Changed to match the controller logic: /server/:serverId/update
    let updated = await firstValueFrom(
      this.http.post<IServer>(`${this.baseUrl}/${serverId}/update`, formData, { withCredentials: true })
        .pipe(catchError(handleApiError))
    );

    // Resolve icon URL
    updated = {
      ...updated,
      icon: updated.icon ? this.fileService.resolveFileUrl(updated.icon) : null,
      defaultTheme: this.resolveServerThemeAssets(updated.defaultTheme)
    };

    this.themeService.applyServerTheme(updated.defaultTheme);
    const currentServer = this.serverDetailsSubject.value;
    if (currentServer?._id === serverId) {
      this.serverDetailsSubject.next({
        ...currentServer,
        name: updated.name ?? currentServer.name,
        icon: updated.icon ?? currentServer.icon,
        defaultTheme: updated.defaultTheme ?? currentServer.defaultTheme,
        joinCode: updated.joinCode ?? currentServer.joinCode
      });
    }

    await this.getMyServers();
    await this.getServerDetails(serverId);
  }

  private resolveServerThemeAssets(theme: IServerTheme | undefined): IServerTheme | undefined {
    if (!theme) return undefined;

    return {
      ...theme,
      backgroundImage: theme.backgroundImage
        ? this.fileService.resolveFileUrl(theme.backgroundImage)
        : null
    };
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

  async updateTemporaryDm(serverId: string, memberId: string, duration: TemporaryDmDuration): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/${serverId}/temporary-dm/${memberId}`,
        { duration },
        { withCredentials: true }
      ).pipe(catchError(handleApiError))
    );

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

  async refreshJoinCode(serverId: string): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<{ joinCode: string }>(
        `${this.baseUrl}/${serverId}/refresh-join-code`,
        {},
        { withCredentials: true }
      ).pipe(catchError(handleApiError))
    );
    // Refresh local state
    if (this.serverDetailsSubject.value?._id === serverId) {
      this.serverDetailsSubject.next({
        ...this.serverDetailsSubject.value,
        joinCode: response.joinCode
      });
    }
    return response.joinCode;
  }

  getOrCreateWhisperChannel(serverId: string, recipientId?: string): Observable<IChannel> {
    return this.http.post<IChannel>(`${this.baseUrl}/whisper/create`, { serverId, recipientId }, { withCredentials: true })
      .pipe(catchError(handleApiError));
  }

}

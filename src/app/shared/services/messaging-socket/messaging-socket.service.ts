import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../../environments/environment';
import { TokenService } from '../auth/token';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { ICharacter } from '../../models/user/character.model';

@Injectable({
  providedIn: 'root'
})
export class MessagingSocketService {
  private socket: Socket | null = null;
  private serverId: string | null = null;

  private _memberUpdate = new Subject<any[]>();
  public readonly memberUpdate$: Observable<any[]> = this._memberUpdate.asObservable();

  private _characterUpdate = new Subject<{serverId: string, data: any}>();
  public readonly characterUpdate$: Observable<{serverId: string, data: any}> = this._characterUpdate.asObservable();

  constructor(private tokenService: TokenService) { }

  public connect(): void {
    if (this.socket && this.socket.connected) {
      return;
    }

    this.socket = io(`${environment.messageUrl}`, {
      path: '/socket.io/',
      withCredentials: true,
      transports: ['websocket'],
      auth: (cb) => {
        cb({ token: this.tokenService.getAccessToken() });
      }
    });

    this.socket.on('connect', () => {
      console.log('Connected to messaging socket');
      if (this.serverId) {
        this.joinServerRoom(this.serverId);
      }
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from messaging socket');
    });

    this.socket.on('member_update', (members: any[]) => {
      console.log('Received member_update:', members);
      this._memberUpdate.next(members);
    });

    this.socket.on('character_update', (data: any) => {
      console.log('Received character_update:', data);
      // character_update event payload in messaging-service is just the 'data' part of SERVER_UPDATES
      // but the messaging-service broadcasts to rooms.
      // Wait, let's look at messaging-service/index.js again.
      // io.to(`server:${payload.serverId}`).emit('character_update', payload.data);
      // So character_update gets the payload.data which is the character object or { _id, deleted: true }.
      this._characterUpdate.next({serverId: this.serverId!, data});
    });

    this.socket.on('connect_error', (err) => {
      console.error('Messaging Socket Connection Error:', err.message);
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.serverId = null;
    }
  }

  public joinServerRoom(serverId: string): void {
    this.serverId = serverId;
    if (this.socket && this.socket.connected) {
      this.socket.emit('join_server', serverId);
      console.log(`Joined server room: ${serverId}`);
    } else {
      this.connect();
    }
  }

  public leaveServerRoom(serverId: string): void {
    if (this.socket && this.socket.connected && this.serverId === serverId) {
      // messaging-service doesn't have an explicit 'leave_server' listener, but socket.io handles room leaving on disconnect or manual join/leave
      // the messaging-service doesn't handle a 'leave_server' event, so we just stop tracking it locally or we could add a leave event if needed.
      // For now, let's just clear the local serverId.
      this.serverId = null;
    }
  }
}

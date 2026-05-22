import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../../environments/environment';
import { TokenService } from '../auth/token';
import { Observable, Subject } from 'rxjs';
import type { MessageData } from '../../models/message/message.model';

@Injectable({
  providedIn: 'root'
})
export class MessagingSocketService {
  private socket: Socket | null = null;
  private serverId: string | null = null;
  private joinedChannelIds = new Set<string>();

  private _memberUpdate = new Subject<any[]>();
  public readonly memberUpdate$: Observable<any[]> = this._memberUpdate.asObservable();

  private _characterUpdate = new Subject<{serverId: string, data: any}>();
  public readonly characterUpdate$: Observable<{serverId: string, data: any}> = this._characterUpdate.asObservable();

  private _newMessage = new Subject<MessageData>();
  public readonly newMessage$: Observable<MessageData> = this._newMessage.asObservable();

  constructor(private tokenService: TokenService) { }

  public connect(): void {
    if (this.socket) {
      if (!this.socket.connected && !this.socket.active) {
        this.socket.connect();
      }
      return;
    }

    this.socket = io(`${environment.messageUrl}`, {
      path: '/socket.io/',
      withCredentials: true,
      autoConnect: false,
      auth: (cb) => {
        cb(this.getSocketAuth());
      }
    });

    this.socket.on('connect', () => {
      console.log('Connected to messaging socket');
      if (this.serverId) {
        this.joinServerRoom(this.serverId);
      }
      this.joinedChannelIds.forEach(channelId => {
        this.socket?.emit('join_channel', channelId);
      });
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

    this.socket.on('new_message', (message: MessageData) => {
      this._newMessage.next(message);
    });

    this.socket.on('connect_error', (err) => {
      console.error('Messaging Socket Connection Error:', err.message);
    });

    this.socket.connect();
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.serverId = null;
      this.joinedChannelIds.clear();
    }
  }

  public joinServerRoom(serverId: string): void {
    const previousServerId = this.serverId;
    this.serverId = serverId;
    if (this.socket && this.socket.connected) {
      if (previousServerId && previousServerId !== serverId) {
        this.socket.emit('leave_server', previousServerId);
      }
      this.socket.emit('join_server', serverId);
      console.log(`Joined server room: ${serverId}`);
    } else {
      this.connect();
    }
  }

  public leaveServerRoom(serverId: string): void {
    if (this.socket && this.socket.connected && this.serverId === serverId) {
      this.socket.emit('leave_server', serverId);
      this.serverId = null;
    }
  }

  public setJoinedChannelRooms(channelIds: string[]): void {
    const nextChannelIds = new Set(channelIds.filter(Boolean));

    this.joinedChannelIds.forEach(channelId => {
      if (!nextChannelIds.has(channelId)) {
        this.leaveChannelRoom(channelId);
      }
    });

    nextChannelIds.forEach(channelId => this.joinChannelRoom(channelId));
  }

  public joinChannelRoom(channelId: string): void {
    if (!channelId) return;

    this.joinedChannelIds.add(channelId);
    if (this.socket && this.socket.connected) {
      this.socket.emit('join_channel', channelId);
    } else {
      this.connect();
    }
  }

  public leaveChannelRoom(channelId: string): void {
    if (!channelId) return;

    this.joinedChannelIds.delete(channelId);
    if (this.socket && this.socket.connected) {
      this.socket.emit('leave_channel', channelId);
    }
  }

  private getSocketAuth(): { token: string | null; userId?: string } {
    const token = this.tokenService.getAccessToken();
    const userId = this.getUserIdFromToken(token);
    return userId ? { token, userId } : { token };
  }

  private getUserIdFromToken(token: string | null): string | undefined {
    if (!token) return undefined;

    try {
      const payload = token.split('.')[1];
      if (!payload) return undefined;

      const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
      const paddedPayload = normalizedPayload.padEnd(
        normalizedPayload.length + ((4 - normalizedPayload.length % 4) % 4),
        '='
      );
      const decodedPayload = atob(paddedPayload);
      const parsed = JSON.parse(decodedPayload);

      return parsed.sub || parsed.userId || parsed._id || parsed.id || undefined;
    } catch {
      return undefined;
    }
  }
}

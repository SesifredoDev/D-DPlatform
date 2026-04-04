import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable } from 'rxjs';

import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class Message {
  private socket: Socket;
  private channelMessages = new Map<string, BehaviorSubject<any[]>>();

  constructor(private http: HttpClient) {
    this.socket = io(`${environment.messageUrl}`, {
      path: '/socket.io/',
      withCredentials: true,
      transports: ['websocket'] // Force websocket to see clear errors if it fails
    });
    this.socket.on('new_message', (message: any) => {
      const channelId = message.channelId ?? message.channel;
      const subject = this.channelMessages.get(channelId);

      if (subject) {
        subject.next([...subject.value, message]);
      }
    });
  }

  joinChannel(channelId: string): Observable<any[]> {

    if (!this.channelMessages.has(channelId)) {
      this.channelMessages.set(channelId, new BehaviorSubject<any[]>([]));
    }

    if (this.socket.connected) {
      this.socket.emit('join_channel', channelId);
    } else {
      this.socket.once('connect', () => {
        this.socket.emit('join_channel', channelId);
      });
    }

    this.getHistory(channelId).subscribe(history => {
      this.channelMessages.get(channelId)!.next(history.reverse());
    });

    return this.channelMessages.get(channelId)!.asObservable();
  }

  leaveChannel(channelId: string) {
    this.socket.emit('leave_channel', channelId);
    this.channelMessages.delete(channelId);
  }

  getHistory(channelId: string) {
    return this.http.get<any[]>(`${environment.apiURL}message/${channelId}`);
  }

  sendMessage(channelId: string, content: string, characterId?: string) {
    return this.http.post(`${environment.apiURL}message/${channelId}`, {
      content,
      characterId
    });
  }
}

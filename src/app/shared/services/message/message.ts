import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { UserService } from '../user/user';

export interface Attachment {
  url: string;
  name: string;
  contentType: string;
  filename: string; // Added filename property
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface MessageData {
  _id: string;
  channel: string;
  server: string;
  author: any;
  character?: any;
  content: string;
  attachments: Attachment[];
  reactions: Reaction[];
  replyTo?: any;
  isWhisper?: boolean;
  recipient?: any;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class Message {
  private socket: Socket;
  private channelMessages = new Map<string, BehaviorSubject<MessageData[]>>();
  private joinedChannels = new Set<string>();
  private socketAuthReady = false;

  constructor(private http: HttpClient, private userService: UserService) {
    this.socket = io(`${environment.messageUrl}`, {
      path: '/socket.io/',
      withCredentials: true,
      transports: ['websocket'],
      autoConnect: false
    });

    this.socket.on('connect', () => {
      this.joinedChannels.forEach(channelId => {
        this.socket.emit('join_channel', channelId);
      });
    });

    this.socket.on('new_message', (message: MessageData) => {
      const channelId = message.channel;
      const subject = this.channelMessages.get(channelId);
      if (subject) {
        subject.next([...subject.value, message]);
      }
    });

    this.socket.on('reaction_update', (data: { messageId: string, reactions: Reaction[], channelId: string }) => {
      const subject = this.channelMessages.get(data.channelId);
      if (subject) {
        const messages = subject.value.map(m => {
          if (m._id === data.messageId) {
            return { ...m, reactions: data.reactions };
          }
          return m;
        });
        subject.next(messages);
      }
    });

    this.userService.getMe().subscribe({
      next: (user) => {
        this.socket.auth = { userId: user._id };
        this.socketAuthReady = true;
        this.connectSocket();
      },
      error: (err) => {
        console.error('Failed to resolve socket user identity', err);
      }
    });
  }

  private connectSocket() {
    if (!this.socketAuthReady) {
      return;
    }

    if (!this.socket.connected && !this.socket.active) {
      this.socket.connect();
    }
  }

  joinChannel(channelId: string): Observable<MessageData[]> {
    if (!this.channelMessages.has(channelId)) {
      this.channelMessages.set(channelId, new BehaviorSubject<MessageData[]>([]));
    }

    this.joinedChannels.add(channelId);

    if (this.socket.connected) {
      this.socket.emit('join_channel', channelId);
    } else {
      this.connectSocket();
    }

    this.getHistory(channelId).subscribe(history => {
      this.channelMessages.get(channelId)!.next(history.reverse());
    });

    return this.channelMessages.get(channelId)!.asObservable();
  }

  leaveChannel(channelId: string) {
    this.socket.emit('leave_channel', channelId);
    this.joinedChannels.delete(channelId);
    this.channelMessages.delete(channelId);
  }

  getHistory(channelId: string) {
    return this.http.get<MessageData[]>(`${environment.apiURL}message/${channelId}`, {
      withCredentials: true
    });
  }

  sendMessage(channelId: string, content: string, characterId?: string, attachments?: Attachment[], replyTo?: string, isWhisper?: boolean, recipientId?: string) {
    return this.http.post<MessageData>(`${environment.apiURL}message/${channelId}`, {
      content,
      characterId,
      attachments,
      replyTo,
      isWhisper,
      recipientId
    });
  }

  addReaction(messageId: string, emoji: string) {
    return this.http.post(`${environment.apiURL}message/reaction/${messageId}`, { emoji });
  }

  removeReaction(messageId: string, emoji: string) {
    return this.http.delete(`${environment.apiURL}message/reaction/${messageId}`, { body: { emoji } });
  }
}

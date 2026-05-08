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
  id?: string;
  key?: string;
  filename?: string;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface MessageData {
  _id: string;
  channel: string;
  channelId?: string;
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
      autoConnect: false
    });

    this.socket.on('connect', () => {
      this.joinedChannels.forEach(channelId => {
        this.socket.emit('join_channel', channelId);
      });
    });

    this.socket.on('new_message', (message: MessageData) => {
      const normalizedMessage = this.normalizeMessage(message);
      const channelId = normalizedMessage.channel;
      const subject = this.channelMessages.get(channelId);
      if (subject) {
        subject.next([...subject.value, normalizedMessage]);
      }
    });

    this.socket.on('reaction_update', (data: { messageId: string, reactions: Reaction[], channelId: string }) => {
      const channelId = String(data.channelId);
      const subject = this.channelMessages.get(channelId);
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
      this.channelMessages.get(channelId)!.next(
        history
          .map(message => this.normalizeMessage(message))
          .reverse()
      );
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
      attachments: attachments?.map(attachment => this.normalizeAttachment(attachment)),
      replyTo,
      isWhisper,
      recipientId
    }, {
      withCredentials: true
    });
  }

  addReaction(messageId: string, emoji: string) {
    return this.http.post(`${environment.apiURL}message/reaction/${messageId}`, { emoji }, {
      withCredentials: true
    });
  }

  removeReaction(messageId: string, emoji: string) {
    return this.http.delete(`${environment.apiURL}message/reaction/${messageId}`, {
      body: { emoji },
      withCredentials: true
    });
  }

  private normalizeAttachment(attachment: Attachment): Attachment {
    const filename = attachment.filename || attachment.name;
    const key = this.buildAttachmentKey({ ...attachment, filename });

    return {
      ...attachment,
      id: attachment.id,
      key,
      url: this.buildAttachmentUrl({ ...attachment, filename, key }),
      name: attachment.name || filename,
      filename
    };
  }

  private buildAttachmentKey(attachment: Partial<Attachment>): string | undefined {
    if (attachment.key) {
      return attachment.key;
    }

    if (attachment.id && attachment.filename) {
      return `${attachment.id}-${attachment.filename}`;
    }

    if (attachment.id && attachment.name) {
      return `${attachment.id}-${attachment.name}`;
    }

    return attachment.id;
  }

  private buildAttachmentUrl(attachment: Partial<Attachment> & { key?: string; filename?: string }): string {
    const key = attachment.key || this.buildAttachmentKey(attachment);
    const currentUrl = attachment.url || '';

    if (key) {
      if (currentUrl) {
        try {
          const parsedUrl = new URL(currentUrl, environment.apiURL);
          const segments = (parsedUrl.pathname || '').split('/').filter(Boolean);
          if (segments.includes('files')) {
            segments[segments.length - 1] = key;
            parsedUrl.pathname = `/${segments.join('/')}`;
            return parsedUrl.origin === new URL(environment.apiURL).origin
              ? parsedUrl.toString()
              : parsedUrl.toString();
          }
        } catch {
          if (/\/files\/[^/]+$/i.test(currentUrl)) {
            return currentUrl.replace(/\/files\/[^/]+$/i, `/files/${key}`);
          }
        }
      }

      return `${environment.apiURL}files/${key}`;
    }

    return currentUrl;
  }

  private normalizeMessage(message: MessageData): MessageData {
    const channelId = String(message.channelId || message.channel);

    return {
      ...message,
      channel: channelId,
      channelId,
      attachments: (message.attachments || []).map(attachment => this.normalizeAttachment(attachment)),
      reactions: message.reactions || []
    };
  }
}

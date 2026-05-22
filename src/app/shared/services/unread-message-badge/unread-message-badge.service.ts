import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import { ChannelService } from '../channel/channel';
import { MessagingSocketService } from '../messaging-socket/messaging-socket.service';
import type { IChannel } from '../../models/server/channel.model';
import type { MessageData } from '../../models/message/message.model';

export interface UnreadMessageBadgeState {
  channels: Record<string, number>;
  whispers: Record<string, number>;
  whisperChannels: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class UnreadMessageBadgeService implements OnDestroy {
  private static readonly storageKeyPrefix = 'unread-message-badges';

  private readonly countsSubject = new BehaviorSubject<UnreadMessageBadgeState>({
    channels: {},
    whispers: {},
    whisperChannels: {}
  });
  readonly counts$ = this.countsSubject.asObservable();

  private readonly subscriptions = new Subscription();
  private currentUserId: string | null = null;
  private currentChannelId: string | null = null;
  private seenMessageIds = new Set<string>();

  constructor(
    private channelService: ChannelService,
    private messagingSocketService: MessagingSocketService
  ) {
    this.subscriptions.add(this.channelService.currentChannel$.subscribe(channel => {
      this.currentChannelId = channel?._id ?? null;
      if (this.currentChannelId) {
        this.markChannelRead(this.currentChannelId);
      }
    }));

    this.subscriptions.add(this.messagingSocketService.newMessage$.subscribe(message => {
      this.handleMessage(message);
    }));
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  setCurrentUser(userId: string | null) {
    if (this.currentUserId === userId) {
      return;
    }

    this.currentUserId = userId;
    this.seenMessageIds.clear();
    this.countsSubject.next(this.readStoredState());
  }

  watchChannels(channels: IChannel[]) {
    const channelIds = channels
      .map(channel => channel._id)
      .filter((channelId): channelId is string => !!channelId);

    this.messagingSocketService.setJoinedChannelRooms(channelIds);
  }

  markChannelRead(channelId: string | null | undefined) {
    if (!channelId) return;

    const current = this.countsSubject.value;
    const peerId = current.whisperChannels[channelId];
    if (!current.channels[channelId] && (!peerId || !current.whispers[peerId])) {
      return;
    }

    const next = this.cloneState(current);
    delete next.channels[channelId];
    if (peerId) {
      delete next.whispers[peerId];
    }
    this.publish(next);
  }

  markWhisperRead(peerId: string | null | undefined, channelId?: string | null) {
    if (!peerId && !channelId) return;

    const current = this.countsSubject.value;
    const resolvedPeerId = peerId || (channelId ? current.whisperChannels[channelId] : null);
    if (!resolvedPeerId) {
      if (channelId) this.markChannelRead(channelId);
      return;
    }

    if (!current.whispers[resolvedPeerId] && (!channelId || !current.channels[channelId])) {
      return;
    }

    const next = this.cloneState(current);
    delete next.whispers[resolvedPeerId];
    if (channelId) {
      delete next.channels[channelId];
      next.whisperChannels[channelId] = resolvedPeerId;
    }
    this.publish(next);
  }

  getChannelUnreadCount(channelId: string | null | undefined): number {
    return channelId ? this.countsSubject.value.channels[channelId] || 0 : 0;
  }

  getWhisperUnreadCount(peerId: string | null | undefined): number {
    return peerId ? this.countsSubject.value.whispers[peerId] || 0 : 0;
  }

  private handleMessage(message: MessageData) {
    if (!this.currentUserId) {
      return;
    }

    const channelId = this.getChannelId(message);
    if (!channelId || this.isOwnMessage(message)) {
      return;
    }

    if (message._id) {
      if (this.seenMessageIds.has(message._id)) {
        return;
      }
      this.seenMessageIds.add(message._id);
    }

    const peerId = message.isWhisper ? this.getWhisperPeerId(message) : null;
    if (channelId === this.currentChannelId) {
      if (peerId) {
        this.rememberWhisperChannel(channelId, peerId);
      }
      this.markChannelRead(channelId);
      return;
    }

    const next = this.cloneState(this.countsSubject.value);
    if (peerId) {
      next.whisperChannels[channelId] = peerId;
      next.whispers[peerId] = (next.whispers[peerId] || 0) + 1;
    } else {
      next.channels[channelId] = (next.channels[channelId] || 0) + 1;
    }
    this.publish(next);
  }

  private rememberWhisperChannel(channelId: string, peerId: string) {
    const current = this.countsSubject.value;
    if (current.whisperChannels[channelId] === peerId) {
      return;
    }

    const next = this.cloneState(current);
    next.whisperChannels[channelId] = peerId;
    this.publish(next);
  }

  private getChannelId(message: MessageData): string {
    return String(message.channelId || message.channel || '');
  }

  private getWhisperPeerId(message: MessageData): string | null {
    const authorId = this.getEntityId(message.author);
    const recipientId = this.getEntityId(message.recipient);

    if (authorId && authorId !== this.currentUserId) return authorId;
    if (recipientId && recipientId !== this.currentUserId) return recipientId;
    return authorId || recipientId || null;
  }

  private isOwnMessage(message: MessageData): boolean {
    const authorId = this.getEntityId(message.author);
    return !!this.currentUserId && authorId === this.currentUserId;
  }

  private getEntityId(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const maybeEntity = value as { _id?: unknown; id?: unknown };
      if (typeof maybeEntity._id === 'string') return maybeEntity._id;
      if (typeof maybeEntity.id === 'string') return maybeEntity.id;
    }
    return null;
  }

  private publish(state: UnreadMessageBadgeState) {
    const cleanedState = this.cleanState(state);
    this.countsSubject.next(cleanedState);
    this.writeStoredState(cleanedState);
  }

  private cleanState(state: UnreadMessageBadgeState): UnreadMessageBadgeState {
    return {
      channels: this.cleanCounts(state.channels),
      whispers: this.cleanCounts(state.whispers),
      whisperChannels: { ...state.whisperChannels }
    };
  }

  private cleanCounts(counts: Record<string, number>): Record<string, number> {
    return Object.entries(counts).reduce<Record<string, number>>((next, [key, value]) => {
      const count = Math.max(0, Math.round(Number(value) || 0));
      if (key && count > 0) {
        next[key] = count;
      }
      return next;
    }, {});
  }

  private cloneState(state: UnreadMessageBadgeState): UnreadMessageBadgeState {
    return {
      channels: { ...state.channels },
      whispers: { ...state.whispers },
      whisperChannels: { ...state.whisperChannels }
    };
  }

  private readStoredState(): UnreadMessageBadgeState {
    if (typeof window === 'undefined' || !this.currentUserId) {
      return { channels: {}, whispers: {}, whisperChannels: {} };
    }

    try {
      const rawState = window.localStorage.getItem(this.getStorageKey());
      if (!rawState) {
        return { channels: {}, whispers: {}, whisperChannels: {} };
      }

      const parsed = JSON.parse(rawState) as Partial<UnreadMessageBadgeState>;
      return this.cleanState({
        channels: parsed.channels || {},
        whispers: parsed.whispers || {},
        whisperChannels: parsed.whisperChannels || {}
      });
    } catch {
      return { channels: {}, whispers: {}, whisperChannels: {} };
    }
  }

  private writeStoredState(state: UnreadMessageBadgeState) {
    if (typeof window === 'undefined' || !this.currentUserId) {
      return;
    }

    try {
      window.localStorage.setItem(this.getStorageKey(), JSON.stringify(state));
    } catch {
      // Non-critical local notification state.
    }
  }

  private getStorageKey(): string {
    return `${UnreadMessageBadgeService.storageKeyPrefix}:${this.currentUserId}`;
  }
}

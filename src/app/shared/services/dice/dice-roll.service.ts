import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChannelType, IChannel } from '../../models/server/channel.model';
import { Message } from '../message/message';
import { ServerService } from '../server/server';
import { DiceRoll, rollDice, rollMessage } from './dice';

/** How long a roll stays on screen (paused while the pointer is over the overlay). */
export const SHOW_FOR_MS = 5000;
/** At most this many rolls are shown at once; older ones drop off. */
const MAX_SHOWN = 4;
const CHANNEL_STORAGE_PREFIX = 'dice.channel.';

export interface ShownRoll {
  id: number;
  roll: DiceRoll;
  /** Where it was rolled from, e.g. "Goblin · Scimitar". */
  label?: string;
  /** Server whose channels it can be posted to. */
  serverId: string | null;
  /** The channel picker is open (also keeps the roll on screen). */
  picking: boolean;
  posting: boolean;
  /** Name of the channel it was posted to. */
  postedTo: string | null;
  error: string | null;
  /** When its 5-second countdown (re)started; null while paused. Drives the overlay's timer bar. */
  countdownFrom: number | null;
}

export interface RollOptions {
  label?: string;
  /** Also post it to chat (Shift+click): to the channel used last, or ask which one. */
  post?: boolean;
}

/**
 * Rolls dice clicked in notes and statblocks and shows them in the bottom-right overlay
 * (DiceRollOverlayComponent). Rolls are private unless posted to a text channel.
 */
@Injectable({ providedIn: 'root' })
export class DiceRollService {
  private readonly messages = inject(Message);
  private readonly serverService = inject(ServerService);

  readonly rolls = signal<ShownRoll[]>([]);

  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private held = false;

  roll(expression: string, options: RollOptions = {}): DiceRoll | null {
    const roll = rollDice(expression);
    if (!roll) return null;

    const shown: ShownRoll = {
      id: this.nextId++,
      roll,
      label: options.label,
      serverId: this.serverService.getCurrentServer()?._id ?? null,
      picking: false,
      posting: false,
      postedTo: null,
      error: null,
      countdownFrom: null,
    };
    const kept = this.rolls().slice(-(MAX_SHOWN - 1));
    this.rolls().filter(old => !kept.includes(old)).forEach(old => this.clearTimer(old.id));
    this.rolls.set([...kept, shown]);
    if (!this.held) this.startTimer(shown.id);

    if (options.post) {
      const channelId = this.rememberedChannel(shown.serverId);
      if (channelId) void this.post(shown.id, channelId);
      else this.openPicker(shown.id);
    }
    return roll;
  }

  /** The current server's text channels, for the picker. */
  textChannels(): IChannel[] {
    const server = this.serverService.getCurrentServer();
    return (server?.channels ?? []).filter(channel => channel.type === ChannelType.Text && !!channel._id);
  }

  rememberedChannel(serverId: string | null): string | null {
    if (!serverId) return null;
    try {
      const id = localStorage.getItem(CHANNEL_STORAGE_PREFIX + serverId);
      return id && this.textChannels().some(channel => channel._id === id) ? id : null;
    } catch {
      return null;
    }
  }

  openPicker(id: number): void {
    this.update(id, { picking: true, error: null });
    this.clearTimer(id);
  }

  closePicker(id: number): void {
    this.update(id, { picking: false });
    if (!this.held) this.startTimer(id);
  }

  async post(id: number, channelId: string): Promise<void> {
    const shown = this.rolls().find(item => item.id === id);
    const channel = this.textChannels().find(item => item._id === channelId);
    if (!shown || !channel || shown.posting) return;

    this.update(id, { posting: true, picking: false, error: null });
    this.clearTimer(id);
    try {
      await firstValueFrom(this.messages.sendMessage(channelId, rollMessage(shown.roll, shown.label)));
      if (shown.serverId) {
        try {
          localStorage.setItem(CHANNEL_STORAGE_PREFIX + shown.serverId, channelId);
        } catch {
          /* storage unavailable */
        }
      }
      this.update(id, { posting: false, postedTo: channel.name });
    } catch (error) {
      console.warn('[Dice] Failed to post roll', error);
      this.update(id, { posting: false, error: 'Couldn’t post to chat.' });
    } finally {
      if (!this.held) this.startTimer(id);
    }
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this.rolls.update(rolls => rolls.filter(item => item.id !== id));
  }

  /** The pointer is over the overlay: keep every roll on screen. */
  hold(): void {
    this.held = true;
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    this.rolls.update(rolls => rolls.map(item => ({ ...item, countdownFrom: null })));
  }

  /** The pointer left the overlay: the 5 seconds start again. */
  release(): void {
    this.held = false;
    this.rolls().filter(item => !item.picking && !item.posting).forEach(item => this.startTimer(item.id));
  }

  private startTimer(id: number): void {
    this.clearTimer(id);
    this.timers.set(id, setTimeout(() => this.dismiss(id), SHOW_FOR_MS));
    this.update(id, { countdownFrom: Date.now() });
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    if (this.timers.delete(id)) this.update(id, { countdownFrom: null });
  }

  private update(id: number, changes: Partial<ShownRoll>): void {
    this.rolls.update(rolls => rolls.map(item => (item.id === id ? { ...item, ...changes } : item)));
  }
}

import { Component, inject } from '@angular/core';
import { IChannel } from '../../models/server/channel.model';
import { DiceRollPart } from '../../services/dice/dice';
import { DiceRollService, SHOW_FOR_MS, ShownRoll } from '../../services/dice/dice-roll.service';

/**
 * Bottom-right overlay for dice rolled from notes and statblocks. Each roll shows its total, the
 * dice that made it and a bar counting down its 5 seconds (paused while the pointer is over it),
 * plus "Post to chat" to share it in a text channel.
 */
@Component({
  selector: 'app-dice-roll-overlay',
  standalone: true,
  templateUrl: './dice-roll-overlay.component.html',
  styleUrl: './dice-roll-overlay.component.scss',
})
export class DiceRollOverlayComponent {
  readonly dice = inject(DiceRollService);
  readonly showForMs = SHOW_FOR_MS;

  channels(): IChannel[] {
    return this.dice.textChannels();
  }

  /** Each die as its own chip; flat numbers as a modifier chip. */
  chips(part: DiceRollPart): { value: string; max: boolean; min: boolean }[] {
    if (!part.rolls.length) return [{ value: `${part.sign < 0 ? '−' : '+'}${part.subtotal}`, max: false, min: false }];
    return part.rolls.map(roll => ({
      value: `${part.sign < 0 ? '−' : ''}${roll}`,
      max: roll === part.sides && part.sides > 1,
      min: roll === 1 && part.sides > 1,
    }));
  }

  togglePicker(item: ShownRoll): void {
    if (item.picking) this.dice.closePicker(item.id);
    else this.dice.openPicker(item.id);
  }

  postLabel(item: ShownRoll): string {
    if (item.posting) return 'Posting…';
    if (item.postedTo) return `Posted to #${item.postedTo}`;
    return 'Post to chat';
  }
}

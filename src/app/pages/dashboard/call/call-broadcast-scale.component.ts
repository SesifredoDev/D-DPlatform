import { Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { BROADCAST_SCALE_MAX, BROADCAST_SCALE_MIN, BroadcastScale } from './call-broadcast-scale';

/** − 80 % + in a broadcast's toolbar. Clicking the percentage fills the space again. */
@Component({
  selector: 'app-broadcast-scale-controls',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="scale" role="group" [attr.aria-label]="label + ' size'">
      <button type="button" (click)="scale.shrink()" [disabled]="!scale.canShrink" [attr.aria-label]="'Smaller ' + label.toLowerCase()" title="Smaller">
        <mat-icon>remove</mat-icon>
      </button>
      <button type="button" class="value" (click)="scale.reset()" [disabled]="!scale.canGrow" title="Fill the space" [attr.aria-label]="label + ' at ' + scale.percent + ' percent. Fill the space'">
        {{ scale.percent }}%
      </button>
      <button type="button" (click)="scale.grow()" [disabled]="!scale.canGrow" [attr.aria-label]="'Bigger ' + label.toLowerCase()" title="Bigger">
        <mat-icon>add</mat-icon>
      </button>
    </div>
  `,
  styles: [`
    :host { display: inline-flex; flex: none; }
    .scale {
      display: inline-flex; align-items: center; height: 34px; overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; background: rgba(255, 255, 255, 0.06);
    }
    button {
      display: grid; place-items: center; height: 100%; min-width: 32px; padding: 0 6px;
      border: 0; background: transparent; color: inherit; font: inherit; font-size: 0.8rem;
      font-variant-numeric: tabular-nums; cursor: pointer;
    }
    button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
    button:disabled { opacity: 0.45; cursor: default; }
    button:focus-visible { outline: 2px solid var(--primary, #7289da); outline-offset: -2px; }
    .value { min-width: 48px; border-inline: 1px solid rgba(255, 255, 255, 0.1); }
    .value:disabled { opacity: 1; }
    mat-icon { width: 18px; height: 18px; font-size: 18px; }
  `],
})
export class BroadcastScaleControlsComponent {
  @Input({ required: true }) scale!: BroadcastScale;
  @Input() label = 'Image';
}

/** The drag handle in a broadcast's bottom-right corner. */
@Component({
  selector: 'app-broadcast-resize-handle',
  standalone: true,
  template: `
    <span
      class="handle"
      [class.is-active]="scale.resizing"
      tabindex="0"
      role="slider"
      [attr.aria-label]="label + ' size'"
      [attr.aria-valuenow]="scale.percent"
      [attr.aria-valuemin]="min"
      [attr.aria-valuemax]="max"
      [attr.aria-valuetext]="scale.percent + '%'"
      title="Drag to resize. Double-click to fill the space."
      (pointerdown)="scale.onHandlePointerDown($event)"
      (pointermove)="scale.onHandlePointerMove($event)"
      (pointerup)="scale.onHandlePointerUp($event)"
      (pointercancel)="scale.onHandlePointerUp($event)"
      (dblclick)="scale.reset()"
      (keydown)="scale.onHandleKeydown($event)"></span>
  `,
  styles: [`
    :host { position: absolute; right: 0; bottom: 0; z-index: 2; }
    .handle {
      display: block; width: 22px; height: 22px; cursor: nwse-resize; touch-action: none;
      background:
        linear-gradient(135deg, transparent 45%, rgba(255, 255, 255, 0.75) 45%, rgba(255, 255, 255, 0.75) 52%, transparent 52%,
          transparent 64%, rgba(255, 255, 255, 0.75) 64%, rgba(255, 255, 255, 0.75) 71%, transparent 71%);
      opacity: 0.55; transition: opacity 120ms;
    }
    .handle:hover, .handle.is-active, .handle:focus-visible { opacity: 1; }
    .handle:focus-visible { outline: 2px solid var(--primary, #7289da); outline-offset: -2px; }
  `],
})
export class BroadcastResizeHandleComponent {
  @Input({ required: true }) scale!: BroadcastScale;
  @Input() label = 'Image';
  readonly min = Math.round(BROADCAST_SCALE_MIN * 100);
  readonly max = Math.round(BROADCAST_SCALE_MAX * 100);
}

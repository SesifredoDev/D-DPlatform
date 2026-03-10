import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ViewChild,
  ElementRef
} from '@angular/core';
import { Subscription } from 'rxjs';
import { Message } from '../../../shared/services/message/message';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatInput } from '@angular/material/input';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import { TextFieldModule } from '@angular/cdk/text-field';

@Component({
  selector: 'app-text-channel',
  templateUrl: 'text-channel.html',
  styleUrls: ['./text-channel.scss'],
  imports: [
    DatePipe,
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatIconButton,
    MatInput,
    MarkdownComponent,
    TextFieldModule
  ],
  providers: [provideMarkdown()]
})
export class TextChannel implements OnChanges, OnDestroy {
  @Input() channelId!: string;
  @Input() currentCharacterId?: string;


  private isAtBottom = true;
  private justOpened = true;

  showNewMessageIndicator = false;


  messages: any[] = [];
  newMessageContent = '';
  private msgSub?: Subscription;

  @ViewChild('messageContainer') container!: ElementRef;

  constructor(private messageService: Message) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['channelId'] && this.channelId) {
      this.loadChannel();
    }
  }

  loadChannel() {
    this.msgSub?.unsubscribe();

    this.msgSub = this.messageService
      .joinChannel(this.channelId)
      .subscribe(msgs => {
        const hadMessages = this.messages.length > 0;
        this.messages = msgs;

        if (this.isAtBottom || this.justOpened) {
          this.scrollToBottom();
        } else if (hadMessages) {
          this.showNewMessageIndicator = true;
        }
      });
  }



  sendMessage() {
    if (!this.newMessageContent.trim()) return;

    this.messageService
      .sendMessage(
        this.channelId,
        this.newMessageContent,
        this.currentCharacterId
      )
      .subscribe({
        next: () => {
          this.newMessageContent = '';
          this.scrollToBottom(true);
        },
        error: err => console.error('Failed to send message', err)
      });
  }

  handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  onScroll() {
    if (!this.container) return;

    const el = this.container.nativeElement;
    const threshold = 50; // px from bottom

    this.isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    if (this.isAtBottom) {
      this.showNewMessageIndicator = false;
    }
  }

  scrollToBottom(force = false) {
    setTimeout(() => {
      if (!this.container) return;

      if (force || this.isAtBottom || this.justOpened) {
        this.container.nativeElement.scrollTop =
          this.container.nativeElement.scrollHeight;

        this.showNewMessageIndicator = false;
        this.justOpened = false;
      }
    }, 50);
  }

  ngOnDestroy() {
    this.msgSub?.unsubscribe();
    this.messageService.leaveChannel(this.channelId);
  }
}

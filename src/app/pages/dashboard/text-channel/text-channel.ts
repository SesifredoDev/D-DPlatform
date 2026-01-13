import { Component, Input, OnChanges, SimpleChanges, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import {Message} from '../../../shared/services/message/message';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import { MatCardModule} from '@angular/material/card';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatIconButton} from '@angular/material/button';
import {MatInput} from '@angular/material/input';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import {TextFieldModule} from '@angular/cdk/text-field';

@Component({
  selector: 'app-text-channel',
  templateUrl: 'text-channel.html',
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
  providers: [
    provideMarkdown() // <--- Add this for global config
  ],

  styleUrls: ['./text-channel.scss']
})
export class TextChannel implements OnChanges, OnDestroy {
  @Input() channelId!: string;
  @Input() currentCharacterId?: string; // Optional: for sending as a character

  messages: any[] = [];
  newMessageContent: string = '';
  private msgSub?: Subscription;

  constructor(private messageService: Message) {}

  ngOnChanges(changes: SimpleChanges): void {
    // When channelId changes, re-initialize the stream
    if (changes['channelId'] && this.channelId) {
      this.loadChannel();
    }
  }

  loadChannel() {
    this.messageService.joinChannel(this.channelId);

    this.msgSub?.unsubscribe();
    this.msgSub = this.messageService.messages$.subscribe(msgs => {
      this.messages = msgs;
      this.scrollToBottom();
    });
  }

  sendMessage() {
    console.log(this.currentCharacterId);

    if (!this.newMessageContent.trim()) return;

    this.messageService.sendMessage(
      this.channelId,
      this.newMessageContent,
      this.currentCharacterId
    ).subscribe({
      next: () => {
        this.newMessageContent = ''; // Clear input on success
      },
      error: (err) => console.error('Failed to send message', err)
    });
  }

  private scrollToBottom() {
    setTimeout(() => {
      const container = document.getElementById('message-container');
      if (container) container.scrollTop = container.scrollHeight;
    }, 100);
  }


  handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); // Prevents a new line from being added
      this.sendMessage();
    }
    // If Shift + Enter is pressed, the default behavior (new line) occurs
  }


  ngOnDestroy() {
    this.msgSub?.unsubscribe();
  }
}

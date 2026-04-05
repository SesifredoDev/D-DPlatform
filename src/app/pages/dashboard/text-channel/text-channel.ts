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
import { Message, MessageData, Reaction, Attachment } from '../../../shared/services/message/message';
import { UserService } from '../../../shared/services/user/user';
import { DatePipe, NgClass, NgForOf, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatIconButton, MatButtonModule } from '@angular/material/button';
import { MatInput } from '@angular/material/input';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import { TextFieldModule } from '@angular/cdk/text-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-text-channel',
  templateUrl: 'text-channel.html',
  styleUrls: ['./text-channel.scss'],
  standalone: true,
  imports: [
    DatePipe,
    NgClass,
    NgForOf,
    NgIf,
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatIconButton,
    MatButtonModule,
    MatInput,
    MarkdownComponent,
    TextFieldModule,
    MatTooltipModule,
    MatMenuModule
  ],
  providers: [provideMarkdown()]
})
export class TextChannel implements OnChanges, OnDestroy {
  @Input() channelId!: string;
  @Input() currentCharacterId?: string;

  private isAtBottom = true;
  private justOpened = true;

  showNewMessageIndicator = false;

  messages: MessageData[] = [];
  newMessageContent = '';
  replyingTo: MessageData | null = null;
  currentUserId: string | null = null;

  attachments: Attachment[] = [];
  isUploading = false;

  private msgSub?: Subscription;

  @ViewChild('messageContainer') container!: ElementRef;

  constructor(
    private messageService: Message,
    private userService: UserService,
    private http: HttpClient
  ) {
    this.userService.getMe().subscribe(user => this.currentUserId = user._id);
  }

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
    if (!this.newMessageContent.trim() && this.attachments.length === 0) return;

    this.messageService
      .sendMessage(
        this.channelId,
        this.newMessageContent,
        this.currentCharacterId,
        this.attachments,
        this.replyingTo?._id
      )
      .subscribe({
        next: () => {
          this.newMessageContent = '';
          this.replyingTo = null;
          this.attachments = [];
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
    const threshold = 50;

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

  setReply(message: MessageData) {
    this.replyingTo = message;
  }

  cancelReply() {
    this.replyingTo = null;
  }

  addReaction(messageId: string, emoji: string) {
    this.messageService.addReaction(messageId, emoji).subscribe();
  }

  toggleReaction(message: MessageData, emoji: string) {
    const reaction = message.reactions.find(r => r.emoji === emoji);
    const hasReacted = reaction?.users.includes(this.currentUserId!);

    if (hasReacted) {
      this.messageService.removeReaction(message._id, emoji).subscribe();
    } else {
      this.messageService.addReaction(message._id, emoji).subscribe();
    }
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.isUploading = true;
      const formData = new FormData();
      formData.append('file', file);

      this.http.post<any>(`${environment.apiURL}files/upload`, formData, { withCredentials: true })
        .subscribe({
          next: (res) => {
            this.attachments.push({
              url: `${environment.apiURL}files/${res.id}`,
              name: res.filename,
              contentType: res.contentType
            });
            this.isUploading = false;
          },
          error: (err) => {
            console.error('Upload failed', err);
            this.isUploading = false;
          }
        });
    }
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
  }

  ngOnDestroy() {
    this.msgSub?.unsubscribe();
    this.messageService.leaveChannel(this.channelId);
  }
}

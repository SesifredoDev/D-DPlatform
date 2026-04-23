import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ViewChild,
  ElementRef, OnInit
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
import { ServerService } from '../../../shared/services/server/server';
import { IServer } from '../../../shared/models/server/server.model';
import {ChannelType, IChannel} from '../../../shared/models/server/channel.model';
import { IUser } from '../../../shared/models/user/user.model';

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
export class TextChannel implements OnChanges, OnDestroy, OnInit {
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

  // Whisper state
  isWhisperMode = false;
  whisperRecipient: any = null;
  serverOwner: any = null;

  private msgSub?: Subscription;
  private serverSub?: Subscription;

  @ViewChild('messageContainer') container!: ElementRef;

  constructor(
    private messageService: Message,
    private userService: UserService,
    private serverService: ServerService,
    private http: HttpClient
  ) {
    this.userService.getMe().subscribe(user => {
      this.currentUserId = user._id;
      const server = this.serverService.getCurrentServer();
      if (server) {
        this.updateWhisperState(server);
      }
    });
  }

  ngOnInit() {
    this.serverSub = this.serverService.getServerDetailsObservable().subscribe(server => {
      if (server) {
        this.serverOwner = server.owner;
        this.updateWhisperState(server);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['channelId'] && this.channelId) {
      this.loadChannel();
      const server = this.serverService.getCurrentServer();
      if (server) {
        this.updateWhisperState(server);
      }
    }
  }

  updateWhisperState(server: IServer) {
    const channel = server.channels.find(c => c._id === this.channelId);
    if (channel && channel.type === ChannelType.Whisper) {
      this.isWhisperMode = true;

      const ownerId = typeof server.owner === 'string' ? server.owner : (server.owner as IUser)._id;
      const isOwner = ownerId === this.currentUserId;

      if (isOwner) {
         // Owner is whispering to the stored recipient
         this.whisperRecipient = server.members.find(m => m.user._id === channel.recipient)?.user || { username: channel.name };
      } else {
         // Recipient is whispering to the owner
         this.whisperRecipient = typeof server.owner === 'object' ? server.owner : { username: 'the DM', _id: server.owner };
      }
    } else {
      this.isWhisperMode = false;
      this.whisperRecipient = null;
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

    // In a whisper channel, every message is a whisper
    const isWhisper = this.isWhisperMode;
    const recipientId = isWhisper ? (this.whisperRecipient?._id) : null;

    this.messageService
      .sendMessage(
        this.channelId,
        this.newMessageContent,
        this.currentCharacterId,
        this.attachments,
        this.replyingTo?._id,
        isWhisper,
        recipientId
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
              filename: res.filename, // Added missing filename property
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
    this.serverSub?.unsubscribe();
    this.messageService.leaveChannel(this.channelId);
  }
}

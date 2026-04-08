import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ServerService } from '../../shared/services/server/server';
import { IChannel } from '../../shared/models/server/channel.model';
import { Message } from '../../shared/services/message/message';
import { Video } from '../../shared/services/video/video';
import { VttSync } from '../../shared/services/vttsync/vttsync';
import { FileService } from '../../shared/services/file/file';

@Component({
  selector: 'app-broadcast-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatListModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './broadcast-dialog.html',
  styleUrls: ['./broadcast-dialog.scss']
})
export class BroadcastDialog implements OnInit {
  imagePreview: string = '';
  textChannels: IChannel[] = [];
  selectedChannels: string[] = [];
  broadcastToCall: boolean = false;
  broadcastToVtt: boolean = false;

  isCallActive: boolean = false;
  isVttActive: boolean = false;
  uploading: boolean = false;
  uploadProgress: number = 0;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: { file: File },
    private dialogRef: MatDialogRef<BroadcastDialog>,
    private serverService: ServerService,
    private messageService: Message,
    private videoService: Video,
    private vttSync: VttSync,
    private fileService: FileService
  ) {
    const reader = new FileReader();
    reader.onload = (e: any) => this.imagePreview = e.target.result;
    reader.readAsDataURL(data.file);
  }

  ngOnInit() {
    const currentServer = this.serverService.getCurrentServer();
    if (currentServer) {
      this.textChannels = currentServer.channels.filter(c => c.type === 'text');
    }

    this.isCallActive = !!this.videoService.currentChannelId;
    this.isVttActive = this.vttSync.isConnected;
  }

  canBroadcast() {
    return this.selectedChannels.length > 0 || this.broadcastToCall || this.broadcastToVtt;
  }

  async broadcast() {
    this.uploading = true;
    this.uploadProgress = 0;
    try {
      // Always use chunked upload to ensure consistent behavior across all file sizes
      const uploadedFile = await this.fileService.uploadFileInChunks(this.data.file, (progress) => {
        this.uploadProgress = progress;
      });

      // 1. Send to Text Channels
      for (const channelId of this.selectedChannels) {
        await this.messageService.sendMessage(channelId, '', undefined, [uploadedFile]).toPromise();
      }

      // 2. Broadcast to Call (Overlay)
      if (this.broadcastToCall && this.isCallActive) {
        this.videoService.broadcastOverlayImage(uploadedFile.url);
      }

      // 3. Add to VTT
      if (this.broadcastToVtt && this.isVttActive) {
        const engine = this.vttSync.getEngine();
        if (engine) {
          const tokenOptions = {
            id: crypto.randomUUID(),
            name: uploadedFile.filename || this.data.file.name,
            icon: uploadedFile.url,
            isPlayer: false
          };
          engine.addToken(100, 100, tokenOptions, false);
          this.vttSync.broadcastAction('token-added', {
            x: 100,
            y: 100,
            options: tokenOptions
          });
        }
      }

      this.dialogRef.close();
    } catch (error) {
      console.error('Broadcast failed', error);
    } finally {
      this.uploading = false;
    }
  }
}

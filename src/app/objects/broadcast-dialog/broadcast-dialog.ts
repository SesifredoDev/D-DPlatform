import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { ServerService } from '../../shared/services/server/server';
import { IChannel } from '../../shared/models/server/channel.model';
import { Message, Attachment } from '../../shared/services/message/message';
import { Video } from '../../shared/services/video/video';
import { VttSync } from '../../shared/services/vttsync/vttsync';
import { FileService } from '../../shared/services/file/file';
import { UserService } from '../../shared/services/user/user';
import { DomSanitizer, SafeHtml, SafeUrl } from '@angular/platform-browser';

export interface BroadcastData {
  file?: File;
  text?: string;
  htmlContent?: string;
  imageUrl?: string;
  source?: string;
  filename?: string;
  embeddedFiles?: BroadcastEmbeddedFile[];
  preferTextForBroadcast?: boolean;
  composeMode?: boolean;
}

export interface BroadcastEmbeddedFile {
  tokenUrl: string;
  file: File;
}

interface UploadedBroadcastAsset {
  url: string;
  filename: string;
  contentType: string;
}

interface BroadcastProcessingContext {
  standaloneImageForCallVtt?: string;
  embeddedImageForVtt?: string;
  textForCall?: string;
  attachments: Attachment[];
  embeddedFileMap: Map<string, File>;
  uploadedEmbeddedFiles: Map<string, UploadedBroadcastAsset>;
  uploadedBlobImageIndex: number;
}

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
    MatProgressSpinnerModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule
  ],
  templateUrl: './broadcast-dialog.html',
  styleUrls: ['./broadcast-dialog.scss']
})
export class BroadcastDialog implements OnInit {
  imagePreview: SafeUrl | null = null;
  textPreview: string | null = null;
  htmlPreview: SafeHtml | null = null;
  draftText: string = '';
  selectedFilename: string | null = null;
  selectedFileContentType: string | null = null;
  selectedFileIsImage: boolean = false;

  textChannels: IChannel[] = [];
  selectedChannels: string[] = [];

  serverMembers: any[] = [];
  selectedMembers: string[] = [];

  broadcastToCall: boolean = false;
  broadcastToVtt: boolean = false;
  setTemporaryAtmosphereBackground: boolean = false;
  setVttBackground: boolean = false;

  isCallActive: boolean = false;
  isVttActive: boolean = false;
  uploading: boolean = false;
  uploadProgress: number = 0;

  hasFile: boolean = false;
  hasText: boolean = false;
  hasHtml: boolean = false;
  hasImageUrl: boolean = false;

  currentServerId: string | null = null;
  readonly isComposerMode: boolean;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: BroadcastData,
    private dialogRef: MatDialogRef<BroadcastDialog>,
    private serverService: ServerService,
    private messageService: Message,
    private videoService: Video,
    private vttSync: VttSync,
    private fileService: FileService,
    private userService: UserService,
    private sanitizer: DomSanitizer
  ) {
    this.isComposerMode = !!data.composeMode;

    if (data.file) {
      this.setFilePreview(data.file);
    } else if (data.imageUrl) {
      this.hasImageUrl = true;
      this.imagePreview = this.sanitizer.bypassSecurityTrustUrl(data.imageUrl);
      this.selectedFilename = data.filename || 'image';
      this.selectedFileContentType = 'image';
      this.selectedFileIsImage = true;
    }

    if (data.text) {
      this.hasText = true;
      this.textPreview = data.text;
      this.draftText = data.text;
    }

    if (data.htmlContent) {
      this.hasHtml = true;
      this.htmlPreview = this.sanitizer.bypassSecurityTrustHtml(data.htmlContent);
    }
  }

  get hasContent(): boolean {
    return this.hasFile || this.hasImageUrl || this.hasText || this.hasHtml;
  }

  get hasImageContentForVtt(): boolean {
    return this.hasImageUrl || (this.hasFile && this.selectedFileIsImage) || this.hasEmbeddedImageContent();
  }

  get hasCallOverlayContent(): boolean {
    return this.hasText || this.hasHtml || this.hasImageContentForVtt;
  }

  get canSetVttBackground(): boolean {
    return this.hasImageContentForVtt && this.vttSync.canSetBroadcastBackground();
  }

  ngOnInit() {
    const currentServer = this.serverService.getCurrentServer();
    if (currentServer) {
      this.currentServerId = currentServer._id;
      this.textChannels = currentServer.channels.filter(c => c.type === 'text');

      this.userService.getMe().subscribe(me => {
        this.serverMembers = (currentServer.members || []).filter((m: any) => m.user._id !== me._id);
      });
    }

    this.isCallActive = !!this.videoService.currentChannelId;
    this.isVttActive = this.vttSync.isConnected;
  }

  canBroadcast() {
    const canBroadcastToCall = this.hasCallOverlayContent && this.isCallActive && this.broadcastToCall;
    const canBroadcastToVtt = this.hasImageContentForVtt && this.isVttActive && this.broadcastToVtt;
    const canSetTemporaryAtmosphere = this.hasImageContentForVtt && this.isCallActive && this.setTemporaryAtmosphereBackground;
    const canSetVttBackground = this.canSetVttBackground && this.setVttBackground;
    const canBroadcastToTextChannels = this.hasContent && this.selectedChannels.length > 0;
    const canBroadcastToWhispers = this.hasContent && this.selectedMembers.length > 0;
    return canBroadcastToCall || canBroadcastToVtt || canSetTemporaryAtmosphere || canSetVttBackground || canBroadcastToTextChannels || canBroadcastToWhispers;
  }

  onDraftTextChange(value: string) {
    this.draftText = value;
    const hasDraftText = value.trim().length > 0;
    this.data.text = hasDraftText ? value : undefined;
    this.textPreview = hasDraftText ? value : null;
    this.hasText = hasDraftText;
  }

  onComposerFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.data.file = file;
    this.data.filename = file.name;
    this.data.imageUrl = undefined;
    this.hasImageUrl = false;
    this.setFilePreview(file);
    if (!this.hasImageContentForVtt) {
      this.broadcastToVtt = false;
      this.setTemporaryAtmosphereBackground = false;
      this.setVttBackground = false;
    }
    input.value = '';
  }

  clearComposerFile() {
    this.data.file = undefined;
    this.data.filename = undefined;
    this.data.imageUrl = undefined;
    this.hasFile = false;
    this.hasImageUrl = false;
    this.selectedFilename = null;
    this.selectedFileContentType = null;
    this.selectedFileIsImage = false;
    this.imagePreview = null;
    const hasRemainingImageContent = this.hasImageContentForVtt;
    this.broadcastToVtt = hasRemainingImageContent && this.broadcastToVtt;
    this.setTemporaryAtmosphereBackground = hasRemainingImageContent && this.setTemporaryAtmosphereBackground;
    this.setVttBackground = hasRemainingImageContent && this.setVttBackground;
  }

  async broadcast() {
    console.log('[BroadcastDialog] Starting broadcast', { data: this.data });
    this.uploading = true;
    this.uploadProgress = 0;
    try {
      let finalMessageContent: string = '';
      const context = this.createProcessingContext();

      // 1. Pre-upload explicitly embedded files
      await this.uploadEmbeddedFiles(context);

      // 2. Handle primary File if present
      if (this.data.file) {
        console.log('[BroadcastDialog] Handling primary file', this.data.file.name);
        const uploaded = await this.uploadFile(this.data.file);
        if (this.isImageContentType(uploaded.contentType)) {
          context.standaloneImageForCallVtt = uploaded.url;
        }
        this.addAttachment(context, uploaded);
        const uploadedMarkdown = this.formatUploadedAssetForMessage(uploaded);

        if (!this.data.text && !this.data.htmlContent) {
          finalMessageContent = uploadedMarkdown;
        } else {
          finalMessageContent = `${uploadedMarkdown}\n\n`;
        }
      }

      // 3. Process Content (HTML or Markdown or Standalone Image)
      let contentResult = '';
      if (this.data.preferTextForBroadcast && this.data.text) {
        console.log('[BroadcastDialog] Processing preferred Markdown text content');
        contentResult = await this.rewriteMarkdownImages(this.data.text, context);
      } else if (this.data.htmlContent) {
        console.log('[BroadcastDialog] Processing HTML content');
        contentResult = await this.processHtmlContent(this.data.htmlContent, context);
      } else if (this.data.text) {
        console.log('[BroadcastDialog] Processing Markdown text content');
        contentResult = await this.rewriteMarkdownImages(this.data.text, context);
      } else if (this.data.imageUrl && !this.data.file) {
        console.log('[BroadcastDialog] Processing standalone image URL content', this.data.imageUrl);
        const asset = await this.processImageReference(this.data.imageUrl, this.data.filename || 'image', context);
        context.standaloneImageForCallVtt = asset.url;
        contentResult = `![${asset.filename}](${asset.url})`;
      }

      finalMessageContent += contentResult;
      finalMessageContent = finalMessageContent.replace(/\n{3,}/g, '\n\n').trim();
      context.textForCall = contentResult;
      console.log('[BroadcastDialog] Final content compiled', { finalMessageContent, contextAttachments: context.attachments.length });

      // 4. Send to Text Channels
      if (this.selectedChannels.length > 0) {
        for (const channelId of this.selectedChannels) {
          console.log(`[BroadcastDialog] Sending message to channel ${channelId}`);
          await this.messageService.sendMessage(channelId, finalMessageContent, undefined, context.attachments).toPromise();
        }
      }

      // 4b. Send to Whispers
      if (this.selectedMembers.length > 0 && this.currentServerId) {
        for (const memberId of this.selectedMembers) {
           console.log(`[BroadcastDialog] Initiating whisper for member ${memberId}`);
           const channel: any = await this.serverService.getOrCreateWhisperChannel(this.currentServerId, memberId).toPromise();
           if (channel && channel._id) {
             console.log(`[BroadcastDialog] Sending whisper to channel ${channel._id}`);
             await this.messageService.sendMessage(channel._id, finalMessageContent, undefined, context.attachments).toPromise();
           }
        }
      }

      // 5. Call Overlay Broadcast
      if (this.broadcastToCall && this.isCallActive) {
        if (context.textForCall) {
          console.log('[BroadcastDialog] Broadcasting overlay text');
          this.videoService.broadcastOverlayText(context.textForCall);
        } else if (context.standaloneImageForCallVtt) {
          console.log('[BroadcastDialog] Broadcasting overlay image');
          this.videoService.broadcastOverlayImage(context.standaloneImageForCallVtt);
        }
      }

      // 6. Temporary Call Atmosphere Background
      const imageForVtt = context.standaloneImageForCallVtt || context.embeddedImageForVtt;
      if (this.setTemporaryAtmosphereBackground && this.isCallActive && imageForVtt) {
        console.log('[BroadcastDialog] Setting temporary atmosphere background', imageForVtt);
        this.videoService.broadcastTemporaryAtmosphereBackground(imageForVtt);
      }

      // 7. VTT Background Broadcast
      if (this.setVttBackground && imageForVtt) {
        console.log('[BroadcastDialog] Setting VTT background from broadcast', imageForVtt);
        await this.vttSync.setBroadcastBackground(imageForVtt);
      }

      // 8. VTT Token Broadcast
      if (this.broadcastToVtt && this.isVttActive && imageForVtt) {
        console.log('[BroadcastDialog] Adding token to VTT', imageForVtt);
        const engine = this.vttSync.getEngine();
        if (engine) {
          const tokenOptions = {
            id: crypto.randomUUID(),
            name: this.data.filename || 'broadcast-item',
            icon: imageForVtt,
            isPlayer: false
          };
          engine.addToken(100, 100, tokenOptions, false);
          this.vttSync.broadcastAction('token-added', { x: 100, y: 100, options: tokenOptions });
        }
      }

      this.dialogRef.close();
    } catch (error) {
      console.error('[BroadcastDialog] Broadcast failed', error);
    } finally {
      this.uploading = false;
    }
  }

  private createProcessingContext(): BroadcastProcessingContext {
    return {
      attachments: [],
      embeddedFileMap: new Map((this.data.embeddedFiles || []).map(file => [file.tokenUrl, file.file])),
      uploadedEmbeddedFiles: new Map<string, UploadedBroadcastAsset>(),
      uploadedBlobImageIndex: 0
    };
  }

  private async processImageReference(url: string, alt: string, context: BroadcastProcessingContext): Promise<UploadedBroadcastAsset> {
    console.log(`[BroadcastDialog] Processing image ref: ${url} (alt: ${alt})`);

    // 1. Check if it's a pre-uploaded embedded file
    if (context.embeddedFileMap.has(url)) {
      const uploaded = context.uploadedEmbeddedFiles.get(url);
      if (uploaded) {
        console.log(`[BroadcastDialog] Found pre-uploaded file for token: ${url} -> ${uploaded.url}`);
        this.markEmbeddedImageForVtt(context, uploaded.url);
        return uploaded;
      }
    }

    // 2. Check if it's a blob URL that needs uploading
    if (url.startsWith('blob:')) {
      console.log(`[BroadcastDialog] Uploading blob URL: ${url}`);
      const filename = alt?.trim() || this.nextGeneratedImageName(context);
      const uploaded = await this.uploadBlobImage(url, filename);
      console.log(`[BroadcastDialog] Blob upload complete: ${uploaded.url}`);
      this.markEmbeddedImageForVtt(context, uploaded.url);
      this.addAttachment(context, uploaded);
      return uploaded;
    }

    // 3. Otherwise, normalize and return existing URL
    const asset: UploadedBroadcastAsset = {
      url: this.normalizeFileUrl(url),
      filename: alt || 'image',
      contentType: 'image/png'
    };
    console.log(`[BroadcastDialog] Using existing URL: ${asset.url}`);
    this.markEmbeddedImageForVtt(context, asset.url);
    return asset;
  }

  private async rewriteMarkdownImages(text: string, context: BroadcastProcessingContext): Promise<string> {
    const markdownImageRegex = /!\[(.*?)\]\(([^)]+)\)/g;
    const matches = Array.from(text.matchAll(markdownImageRegex));
    let result = '';
    let lastIndex = 0;

    for (const match of matches) {
      result += text.slice(lastIndex, match.index);
      const [fullMatch, alt, url] = match;
      const asset = await this.processImageReference(url, alt, context);
      result += `![${asset.filename}](${asset.url})`;
      lastIndex = (match.index || 0) + fullMatch.length;
    }

    result += text.slice(lastIndex);
    return result;
  }

  private async processHtmlContent(htmlContent: string, context: BroadcastProcessingContext): Promise<string> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    const imgs = Array.from(doc.querySelectorAll('img'));
    console.log(`[BroadcastDialog] HTML parser found ${imgs.length} images`);
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src) continue;
      const alt = img.getAttribute('alt') || 'image';

      const asset = await this.processImageReference(src, alt, context);
      img.replaceWith(doc.createTextNode(`![${asset.filename}](${asset.url})`));
    }

    // Convert common HTML elements to Markdown
    doc.querySelectorAll('strong, b').forEach(el => el.replaceWith(`**${el.textContent}**`));
    doc.querySelectorAll('em, i').forEach(el => el.replaceWith(`*${el.textContent}*`));
    doc.querySelectorAll('h1').forEach(el => el.replaceWith(`\n# ${el.textContent}\n`));
    doc.querySelectorAll('h2').forEach(el => el.replaceWith(`\n## ${el.textContent}\n`));
    doc.querySelectorAll('h3').forEach(el => el.replaceWith(`\n### ${el.textContent}\n`));
    doc.querySelectorAll('li').forEach(el => el.replaceWith(`\n- ${el.textContent}`));

    let html = doc.body.innerHTML;
    html = html.replace(/<p.*?>/gi, '\n').replace(/<\/p>/gi, '\n')
      .replace(/<div.*?>/gi, '\n').replace(/<\/div>/gi, '\n')
      .replace(/<br.*?>/gi, '\n');

    return html.replace(/<[^>]+>/g, '').trim();
  }

  private async uploadFile(file: File, filenameSuggestion?: string): Promise<UploadedBroadcastAsset> {
    const finalFile = filenameSuggestion && filenameSuggestion !== file.name
      ? new File([file], filenameSuggestion, { type: file.type })
      : file;

    const uploaded = await this.fileService.uploadFileInChunks(finalFile, (progress) => {
      this.uploadProgress = progress;
    });

    return {
      url: uploaded.url,
      filename: uploaded.filename,
      contentType: uploaded.contentType
    };
  }

  private async uploadBlobImage(blobUrl: string, filenameSuggestion: string): Promise<UploadedBroadcastAsset> {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    const extension = blob.type.split('/')[1] || 'png';
    const filename = filenameSuggestion.includes('.') ? filenameSuggestion : `${filenameSuggestion}-${Date.now()}.${extension}`;
    const file = new File([blob], filename, { type: blob.type });
    return this.uploadFile(file);
  }

  private normalizeFileUrl(url: string): string {
    return this.fileService.resolveFileUrl(url);
  }

  private markEmbeddedImageForVtt(context: BroadcastProcessingContext, url: string) {
    if (!context.embeddedImageForVtt) {
      context.embeddedImageForVtt = url;
    }
  }

  private addAttachment(context: BroadcastProcessingContext, asset: UploadedBroadcastAsset) {
    context.attachments.push({
      url: asset.url,
      name: asset.filename,
      filename: asset.filename,
      contentType: asset.contentType
    });
  }

  private nextGeneratedImageName(context: BroadcastProcessingContext): string {
    context.uploadedBlobImageIndex += 1;
    return `image-${context.uploadedBlobImageIndex}`;
  }

  private setFilePreview(file: File) {
    this.hasFile = true;
    this.selectedFilename = file.name;
    this.selectedFileContentType = file.type || 'unknown file type';
    this.selectedFileIsImage = file.type.startsWith('image/');

    if (!this.selectedFileIsImage) {
      this.imagePreview = null;
      return;
    }

    const reader = new FileReader();
    reader.onload = (e: ProgressEvent<FileReader>) => {
      if (typeof e.target?.result === 'string') {
        this.imagePreview = this.sanitizer.bypassSecurityTrustUrl(e.target.result);
      }
    };
    reader.readAsDataURL(file);
  }

  private formatUploadedAssetForMessage(asset: UploadedBroadcastAsset): string {
    return this.isImageContentType(asset.contentType)
      ? `![${asset.filename}](${asset.url})`
      : `[${asset.filename}](${asset.url})`;
  }

  private isImageContentType(contentType: string | null | undefined): boolean {
    return !!contentType && contentType.startsWith('image/');
  }

  private hasEmbeddedImageContent(): boolean {
    const text = this.data.text || this.draftText || '';
    const html = this.data.htmlContent || '';
    const embeddedFiles = this.data.embeddedFiles || [];

    return /!\[[^\]]*\]\([^)]+\)/.test(text) ||
      /<img\s/i.test(html) ||
      embeddedFiles.some(embedded => this.isImageContentType(embedded.file?.type));
  }

  private async uploadEmbeddedFiles(context: BroadcastProcessingContext) {
    console.log(`[BroadcastDialog] Pre-uploading ${context.embeddedFileMap.size} embedded files`);
    for (const [tokenUrl, file] of context.embeddedFileMap.entries()) {
      const filenameBase = file.name || this.nextGeneratedImageName(context);
      const uploaded = await this.uploadFile(file, filenameBase);
      context.uploadedEmbeddedFiles.set(tokenUrl, uploaded);
      this.addAttachment(context, uploaded); // Ensure they are added as message attachments
      console.log(`[BroadcastDialog] Pre-upload complete for ${tokenUrl} -> ${uploaded.url}`);
    }
  }
}

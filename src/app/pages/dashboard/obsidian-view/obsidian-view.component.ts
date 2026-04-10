import { Component, OnInit, Input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ObsidianVaultService, VaultEntry } from '../../../shared/services/ObsidianVault/obsidian-vault-service';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTreeModule } from '@angular/material/tree';
import { MarkdownComponent } from 'ngx-markdown';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BroadcastDialog, BroadcastData, BroadcastEmbeddedFile } from '../../../objects/broadcast-dialog/broadcast-dialog';

@Component({
  selector: 'app-obsidian-view',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    MatExpansionModule,
    MatTreeModule,
    MarkdownComponent,
    MatTooltipModule,
    MatMenuModule,
    MatDialogModule
  ],
  templateUrl: './obsidian-view.component.html',
  styleUrl: './obsidian-view.component.scss'
})
export class ObsidianViewComponent implements OnInit, OnDestroy {
  @Input() serverId!: string;
  vaultName: string | null = null;
  localhostRoute: string | null = null;
  vaultEntries: VaultEntry[] = [];

  selectedFileContent: string = '';
  processedContent: string = '';

  selectedFileName: string = ''; // Full filename with extension
  selectedFileDisplayName: string = ''; // Name without extension for editing
  selectedFileRelativePath: string = '';
  isEditing: boolean = false;
  isPreview: boolean = true;
  permissionGranted: boolean = false;
  fileSystemApiSupported: boolean = false;

  // For non-markdown files
  nonMarkdownUrl: SafeUrl | null = null;
  isImage: boolean = false;
  isPdf: boolean = false;

  // Context Menu Support
  contextMenuPosition = { x: '0px', y: '0px' };

  private objectUrls: string[] = [];
  private contentChanged = new Subject<void>();
  private autoSaveSubscription?: Subscription;

  constructor(
    private obsidianVaultService: ObsidianVaultService,
    private route: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private dialog: MatDialog
  ) {}

  ngOnInit(): void {
    this.fileSystemApiSupported = this.obsidianVaultService.isFileSystemApiSupported();

    if (!this.serverId) {
      this.route.paramMap.subscribe(params => {
        const id = params.get('serverId');
        if (id) {
          this.serverId = id;
          this.loadVaultInfo();
        }
      });
    } else {
      this.loadVaultInfo();
    }

    // Set up auto-save
    this.autoSaveSubscription = this.contentChanged.pipe(
      debounceTime(1000) // Auto-save after 1 second of inactivity
    ).subscribe(() => {
      this.saveFile();
    });
  }

  ngOnDestroy(): void {
    this.revokeObjectUrls();
    this.autoSaveSubscription?.unsubscribe();
  }

  async loadVaultInfo(): Promise<void> {
    if (this.serverId) {
      this.localhostRoute = this.obsidianVaultService.getVaultLocalhostRoute(this.serverId);

      const handle = await this.obsidianVaultService.getVaultHandle(this.serverId);
      if (handle) {
        this.vaultName = handle.name;
        const options = { mode: 'readwrite' };
        if ((await (handle as any).queryPermission(options)) === 'granted') {
          this.permissionGranted = true;
          this.loadVaultEntries();
        }
      }
    }
  }

  async attachVault(): Promise<void> {
    if (!this.fileSystemApiSupported) return;

    if (this.serverId) {
      try {
        this.vaultName = await this.obsidianVaultService.attachVaultToServer(this.serverId);
        this.permissionGranted = true;
        await this.loadVaultEntries();
      } catch (err) {
        console.error('Failed to attach vault:', err);
      }
    }
  }

  async requestPermission(): Promise<void> {
    const handle = await this.obsidianVaultService.getVaultHandle(this.serverId);
    if (handle) {
      this.permissionGranted = await this.obsidianVaultService.requestPermission(handle);
      if (this.permissionGranted) {
        this.loadVaultEntries();
      }
    }
  }

  async loadVaultEntries(): Promise<void> {
    this.vaultEntries = await this.obsidianVaultService.listVaultFiles(this.serverId);
    console.log('Vault entries loaded:', this.vaultEntries);
  }

  async selectFile(entry: VaultEntry): Promise<void> {
    if (entry.kind === 'directory') return;

    this.revokeObjectUrls();
    this.selectedFileName = entry.name;
    this.selectedFileDisplayName = this.getDisplayName(entry.name);
    this.selectedFileRelativePath = entry.relativePath;
    this.isEditing = true;

    if (entry.name.toLowerCase().endsWith('.md')) {
      this.isImage = false;
      this.isPdf = false;
      this.nonMarkdownUrl = null;
      this.selectedFileContent = await this.obsidianVaultService.readFile(this.serverId, entry.relativePath);
      this.isPreview = true;
      await this.processContent();
    } else {
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, entry.relativePath);
      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      this.nonMarkdownUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
      this.isImage = this.isImageFile(entry.name);
      this.isPdf = this.isPdfFile(entry.name);
      this.isPreview = true;
      this.selectedFileContent = '';
    }
  }

  async createNewFile(): Promise<void> {
    const fileName = prompt('Enter the name of the new note:');
    if (!fileName) return;

    const fullFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;

    try {
      await this.obsidianVaultService.writeFile(this.serverId, fullFileName, '');
      await this.loadVaultEntries();

      const newEntry = this.findEntryByPath(fullFileName, this.vaultEntries);
      if (newEntry) {
        await this.selectFile(newEntry);
        this.isPreview = false;
      }
    } catch (err) {
      console.error('Failed to create file:', err);
    }
  }

  async renameSelectedFile(): Promise<void> {
    const currentDisplayName = this.getDisplayName(this.selectedFileName);
    const newDisplayName = this.selectedFileDisplayName;

    if (!newDisplayName || newDisplayName === currentDisplayName) {
      this.selectedFileDisplayName = currentDisplayName;
      return;
    }

    const extension = this.selectedFileName.includes('.') ? this.selectedFileName.split('.').pop() : 'md';
    const fullNewName = newDisplayName.endsWith(`.${extension}`) ? newDisplayName : `${newDisplayName}.${extension}`;

    try {
      const newPath = await this.obsidianVaultService.renameFile(this.serverId, this.selectedFileRelativePath, fullNewName);
      this.selectedFileName = fullNewName;
      this.selectedFileDisplayName = newDisplayName;
      this.selectedFileRelativePath = newPath;
      await this.loadVaultEntries();
    } catch (err) {
      console.error('Failed to rename file:', err);
      this.selectedFileDisplayName = currentDisplayName;
    }
  }

  getDisplayName(name: string): string {
    return name.endsWith('.md') ? name.slice(0, -3) : name;
  }

  onContentChange(): void {
    this.contentChanged.next();
  }

  onDragStart(event: DragEvent, entry: VaultEntry): void {
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', entry.relativePath);
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  async onDrop(event: DragEvent, targetEntry?: VaultEntry): Promise<void> {
    event.preventDefault();
    const sourcePath = event.dataTransfer?.getData('text/plain');
    if (!sourcePath) return;

    const targetDirPath = (targetEntry && targetEntry.kind === 'directory') ? targetEntry.relativePath : '';

    if (sourcePath === targetDirPath || sourcePath.startsWith(targetDirPath + '/')) {
      return;
    }

    try {
      await this.obsidianVaultService.moveEntry(this.serverId, sourcePath, targetDirPath);
      await this.loadVaultEntries();

      if (this.selectedFileRelativePath === sourcePath) {
        const fileName = sourcePath.split('/').pop()!;
        this.selectedFileRelativePath = targetDirPath ? `${targetDirPath}/${fileName}` : fileName;
      }
    } catch (err) {
      console.error('Failed to move entry:', err);
    }
  }

  async deleteEntry(entry: VaultEntry, event?: Event): Promise<void> {
    if (event) event.stopPropagation();

    if (confirm(`Are you sure you want to delete ${entry.name}?`)) {
      try {
        await this.obsidianVaultService.deleteEntry(this.serverId, entry.relativePath);
        if (this.selectedFileRelativePath === entry.relativePath) {
          this.cancelEdit();
        }
        await this.loadVaultEntries();
      } catch (err) {
        console.error('Failed to delete entry:', err);
      }
    }
  }

  onContextMenu(event: MouseEvent, trigger: MatMenuTrigger): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuPosition.x = event.clientX + 'px';
    this.contextMenuPosition.y = event.clientY + 'px';
    trigger.openMenu();
  }

  private findEntryByPath(path: string, entries: VaultEntry[]): VaultEntry | null {
    const lowerPath = path.toLowerCase();
    for (const entry of entries) {
      if (entry.relativePath.toLowerCase() === lowerPath) return entry;
      if (entry.children) {
        const found = this.findEntryByPath(path, entry.children);
        if (found) return found;
      }
    }
    return null;
  }

  async saveFile(): Promise<void> {
    if (this.selectedFileRelativePath && this.selectedFileName.endsWith('.md')) {
      try {
        await this.obsidianVaultService.writeFile(
          this.serverId,
          this.selectedFileRelativePath,
          this.selectedFileContent
        );
      } catch (err) {
        console.error('Failed to auto-save file:', err);
      }
    }
  }

  async toggleEditMode(): Promise<void> {
    if (!this.selectedFileName.endsWith('.md')) return; // Non-editable

    this.isPreview = !this.isPreview;
    if (this.isPreview) {
      await this.processContent();
    }
  }

  private async processContent(): Promise<void> {
    console.log('processContent: Starting...');
    this.revokeObjectUrls();
    let content = this.selectedFileContent;
    const currentFileDir = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');
    console.log('processContent: Current file directory:', currentFileDir);

    const embedRegex = /!\[\[(.*?)\]\]/g;
    let match;
    const replacements: { original: string, replacement: string }[] = [];

    while ((match = embedRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const linkContent = match[1].trim(); // Trim whitespace
      const parts = linkContent.split('|');
      const filePath = parts[0].trim(); // Trim whitespace
      const width = parts[1] ? parts[1].trim() : ''; // Obsidian supports width like ![[img.png|300]]
      console.log(`processContent: Found embed: "${fullMatch}", extracted filePath: "${filePath}", width: "${width}"`);

      let resolvedPath: string | null = null;

      // 1. Try exact path from root
      try {
        await this.obsidianVaultService.readFileAsBlob(this.serverId, filePath);
        resolvedPath = filePath;
        console.log(`processContent: Resolved by direct path: "${resolvedPath}"`);
      } catch (e) {
        console.log(`processContent: Direct path failed for "${filePath}". Error:`, e);
        // 2. Try relative to current file
        const relativeToCurrent = this.obsidianVaultService.resolveRelativePath(currentFileDir, filePath);
        try {
          await this.obsidianVaultService.readFileAsBlob(this.serverId, relativeToCurrent);
          resolvedPath = relativeToCurrent;
          console.log(`processContent: Resolved by relative path: "${resolvedPath}"`);
        } catch (e2) {
          console.log(`processContent: Relative path failed for "${relativeToCurrent}". Error:`, e2);
          // 3. Global search by filename
          const filenameOnly = filePath.split('/').pop()?.split('\\').pop(); // Get just the filename
          if (filenameOnly) {
            resolvedPath = await this.obsidianVaultService.findFileByFilename(this.serverId, filenameOnly);
            console.log(`processContent: Resolved by global filename search for "${filenameOnly}": "${resolvedPath}"`);
          } else {
            console.log(`processContent: Could not extract filename from "${filePath}" for global search.`);
          }
        }
      }

      if (resolvedPath) {
        try {
          const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
          const url = URL.createObjectURL(blob);
          this.objectUrls.push(url);
          console.log(`processContent: Created object URL: "${url}" for resolved path: "${resolvedPath}"`);

          let replacement = '';
          const style = width ? `width: ${width}px; max-width: 100%;` : `max-width: 100%;`;

          if (this.isImageFile(resolvedPath)) {
            replacement = `<img src="${url}" alt="${filePath}" style="${style} border-radius: 4px;">`;
          } else if (this.isPdfFile(resolvedPath)) {
            replacement = `<embed src="${url}" type="application/pdf" width="100%" height="600px">`;
          } else {
            replacement = `<a href="${url}" target="_blank">Download ${filePath}</a>`;
          }
          replacements.push({ original: fullMatch, replacement });
          console.log(`processContent: Generated replacement HTML for "${fullMatch}":`, replacement);
        } catch (e) {
          console.warn('processContent: Could not load embed after resolution:', resolvedPath, 'Error:', e);
        }
      } else {
        console.warn(`processContent: No resolved path found for embed: "${fullMatch}"`);
      }
    }

    for (const r of replacements) {
      content = content.replace(r.original, r.replacement);
    }

    const linkRegex = /\[\[(.*?)\]\]/g;
    content = content.replace(linkRegex, (match, p1) => {
      const parts = p1.split('|');
      const targetPath = parts[0].trim();
      const displayName = parts[1] ? parts[1].trim() : targetPath;
      // Use both data-path and title to avoid sanitization issues
      return `<a class="internal-link" data-path="${targetPath}" title="${targetPath}" style="color: #00a8fc; cursor: pointer;">${displayName}</a>`;
    });

    this.processedContent = content;
    console.log('processContent: Finished. Processed content updated.');
  }

  private isImageFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '');
  }

  private isPdfFile(path: string): boolean {
    return path.toLowerCase().endsWith('.pdf');
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  handleMarkdownClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const link = target.closest('.internal-link');

    if (link) {
      console.log('handleMarkdownClick: INTERNAL LINK CLICKED');
      // Try multiple attributes in case sanitizer strips data-path
      let path = link.getAttribute('data-path') || link.getAttribute('title');

      // If attributes are stripped, fallback to text content (only if no alias was used)
      if (!path) {
        path = link.textContent?.trim() || null;
        console.log('handleMarkdownClick: Fallback to text content:', path);
      }

      console.log('handleMarkdownClick: Path extracted:', path);
      if (path) {
        event.preventDefault();
        event.stopPropagation();
        this.openInternalLink(path);
      }
    }
  }

  private async openInternalLink(linkPath: string): Promise<void> {
    // Clean up input: trim and remove invisible characters (like zero-width spaces)
    linkPath = linkPath.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    console.log(`openInternalLink: Triggered for path "${linkPath}"`);

    const currentFileDir = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');

    // 1. Try exact match from root or with .md
    let entry = this.findEntryByPath(linkPath, this.vaultEntries);
    if (!entry && !linkPath.toLowerCase().endsWith('.md')) {
      entry = this.findEntryByPath(`${linkPath}.md`, this.vaultEntries);
    }

    // 2. Try relative to current file
    if (!entry) {
      const relativePath = this.obsidianVaultService.resolveRelativePath(currentFileDir, linkPath);
      entry = this.findEntryByPath(relativePath, this.vaultEntries);
      if (!entry && !relativePath.toLowerCase().endsWith('.md')) {
        entry = this.findEntryByPath(`${relativePath}.md`, this.vaultEntries);
      }
    }

    // 3. Global search by filename (anywhere in the vault) - this satisfies "find filename.md in any folder"
    if (!entry) {
      const fileName = linkPath.split('/').pop()!;
      entry = this.findEntryByName(fileName, this.vaultEntries);

      if (!entry && !fileName.toLowerCase().endsWith('.md')) {
        const fileNameWithMd = `${fileName}.md`;
        entry = this.findEntryByName(fileNameWithMd, this.vaultEntries);
      }
    }

    // 4. Try global search by base name (ignore extension)
    if (!entry) {
      const fileName = linkPath.split('/').pop()!;
      const baseName = fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
      entry = this.findEntryByBaseName(baseName, this.vaultEntries);
    }

    if (entry) {
      console.log(`openInternalLink: Found matching entry at "${entry.relativePath}"`);
      await this.selectFile(entry);
    } else {
      console.warn(`Internal link target not found: ${linkPath}`);
    }
  }

  private findEntryByName(name: string, entries: VaultEntry[]): VaultEntry | null {
    const lowerName = name.toLowerCase();
    for (const entry of entries) {
      if (entry.name.toLowerCase() === lowerName) return entry;
      if (entry.children) {
        const found = this.findEntryByName(name, entry.children);
        if (found) return found;
      }
    }
    return null;
  }

  private findEntryByBaseName(baseName: string, entries: VaultEntry[]): VaultEntry | null {
    const lowerBase = baseName.toLowerCase();
    for (const entry of entries) {
      if (entry.kind === 'file') {
        const entryName = entry.name;
        const entryBaseName = entryName.includes('.')
          ? entryName.substring(0, entryName.lastIndexOf('.'))
          : entryName;

        if (entryBaseName.toLowerCase() === lowerBase) {
          return entry;
        }
      }
      if (entry.children) {
        const found = this.findEntryByBaseName(baseName, entry.children);
        if (found) return found;
      }
    }
    return null;
  }

  cancelEdit(): void {
    this.isEditing = false;
    this.selectedFileName = '';
    this.selectedFileDisplayName = '';
    this.selectedFileRelativePath = '';
    this.selectedFileContent = '';
    this.processedContent = '';
    this.nonMarkdownUrl = null;
    this.isImage = false;
    this.isPdf = false;
    this.revokeObjectUrls();
  }

  openObsidianVault(): void {
    if (this.localhostRoute) {
      window.open(this.localhostRoute, '_blank');
    }
  }

  // --- Broadcast Functionality ---

  async broadcastFullDocument(): Promise<void> {
    if (!this.selectedFileContent && !this.nonMarkdownUrl) return;

    let data: BroadcastData = {
      source: 'obsidian-view',
      filename: this.selectedFileName
    };

    if (this.selectedFileName.endsWith('.md')) {
      const markdownBroadcast = await this.buildBroadcastMarkdown(this.selectedFileContent);
      data.text = markdownBroadcast.markdown;
      data.embeddedFiles = markdownBroadcast.embeddedFiles;
    } else {
      // For images/PDFs, we need to get the actual file blob or use the URL
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, this.selectedFileRelativePath);
      data.file = new File([blob], this.selectedFileName, { type: blob.type });
    }

    this.dialog.open(BroadcastDialog, {
      data: data,
      maxWidth: '600px',
      width: '100%'
    });
  }

  async broadcastSelection(): Promise<void> {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());

    // Check if the selection is within our markdown content
    let node: Node | null = range.commonAncestorContainer;
    let withinMarkdown = false;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('obsidian-markdown')) {
        withinMarkdown = true;
        break;
      }
      node = node.parentNode;
    }

    if (!withinMarkdown) return;

    const data: BroadcastData = {
      text: selection.toString(),
      htmlContent: container.innerHTML,
      source: 'obsidian-view-selection'
    };

    // If only an image is selected, handle it as an image broadcast
    const images = container.getElementsByTagName('img');
    if (images.length === 1 && container.innerText.trim() === '') {
       data.imageUrl = images[0].src;
    }

    this.dialog.open(BroadcastDialog, {
      data: data,
      maxWidth: '600px',
      width: '100%'
    });
  }

  private async buildBroadcastMarkdown(content: string): Promise<{ markdown: string; embeddedFiles: BroadcastEmbeddedFile[] }> {
    const embedRegex = /!\[\[(.*?)\]\]/g;
    let rebuiltContent = '';
    let lastIndex = 0;
    const embeddedFiles: BroadcastEmbeddedFile[] = [];

    for (const match of content.matchAll(embedRegex)) {
      const fullMatch = match[0];
      const linkContent = match[1].trim();
      const startIndex = match.index ?? 0;

      rebuiltContent += content.slice(lastIndex, startIndex);
      rebuiltContent += await this.convertObsidianEmbedToMarkdown(linkContent, embeddedFiles);
      lastIndex = startIndex + fullMatch.length;
    }

    rebuiltContent += content.slice(lastIndex);
    return { markdown: rebuiltContent, embeddedFiles };
  }

  private async convertObsidianEmbedToMarkdown(linkContent: string, embeddedFiles: BroadcastEmbeddedFile[]): Promise<string> {
    const parts = linkContent.split('|');
    const filePath = parts[0].trim();
    const resolvedPath = await this.resolveEmbedPath(filePath);

    if (!resolvedPath) {
      return `![[${linkContent}]]`;
    }

    const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.push(objectUrl);

    if (this.isImageFile(resolvedPath)) {
      const altText = filePath.split('/').pop()?.split('\\').pop() || filePath;
      const file = new File([blob], altText, { type: blob.type });
      const tokenUrl = `broadcast-file://${crypto.randomUUID()}`;
      embeddedFiles.push({ tokenUrl, file });
      return `![${altText}](${tokenUrl})`;
    }

    if (this.isPdfFile(resolvedPath)) {
      const fileName = filePath.split('/').pop()?.split('\\').pop() || filePath;
      return `[${fileName}](${objectUrl})`;
    }

    const fileName = filePath.split('/').pop()?.split('\\').pop() || filePath;
    return `[${fileName}](${objectUrl})`;
  }

  private async resolveEmbedPath(filePath: string): Promise<string | null> {
    const currentFileDir = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');

    try {
      await this.obsidianVaultService.readFileAsBlob(this.serverId, filePath);
      return filePath;
    } catch {
      const relativeToCurrent = this.obsidianVaultService.resolveRelativePath(currentFileDir, filePath);

      try {
        await this.obsidianVaultService.readFileAsBlob(this.serverId, relativeToCurrent);
        return relativeToCurrent;
      } catch {
        const filenameOnly = filePath.split('/').pop()?.split('\\').pop();
        return filenameOnly
          ? await this.obsidianVaultService.findFileByFilename(this.serverId, filenameOnly)
          : null;
      }
    }
  }
}

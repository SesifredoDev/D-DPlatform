import { Component, OnInit, Input, OnDestroy, ChangeDetectorRef, OnChanges, SimpleChanges } from '@angular/core';
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
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { BroadcastDialog, BroadcastData, BroadcastEmbeddedFile } from '../../../objects/broadcast-dialog/broadcast-dialog';
import { MilkdownEditorComponent } from '../../../shared/components/milkdown-editor/milkdown-editor.component';

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
    MatTooltipModule,
    MatMenuModule,
    MatDialogModule,
    MilkdownEditorComponent
  ],
  templateUrl: './obsidian-view.component.html',
  styleUrl: './obsidian-view.component.scss'
})
export class ObsidianViewComponent implements OnInit, OnDestroy, OnChanges {
  @Input() serverId!: string;
  @Input() openPath: string | null = null;
  @Input() openRequestId: number | null = null;
  vaultName: string | null = null;
  localhostRoute: string | null = null;
  vaultEntries: VaultEntry[] = [];

  selectedFileContent: string = '';
  // processedContent is not needed for Milkdown as it handles its own rendering

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

  hasActiveSelection: boolean = false;

  private objectUrls: string[] = [];
  private contentChanged = new Subject<void>();
  private autoSaveSubscription?: Subscription;
  private pendingOpenPath: string | null = null;

  constructor(
    private obsidianVaultService: ObsidianVaultService,
    private route: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private dialog: MatDialog,
    private cdr: ChangeDetectorRef
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

    document.addEventListener('selectionchange', this.handleSelectionChange);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['openPath'] || changes['openRequestId']) && this.openPath) {
      void this.openRequestedPath(this.openPath);
    }
  }

  ngOnDestroy(): void {
    this.revokeObjectUrls();
    this.autoSaveSubscription?.unsubscribe();
    document.removeEventListener('selectionchange', this.handleSelectionChange);
  }

  private handleSelectionChange = () => {
    const selection = window.getSelection();
    const hasSelection = !!(selection && !selection.isCollapsed && this.isSelectionInEditor(selection));

    if (this.hasActiveSelection !== hasSelection) {
      this.hasActiveSelection = hasSelection;
      this.cdr.detectChanges();
    }
  };

  private isSelectionInEditor(selection: Selection): boolean {
    if (selection.rangeCount === 0) return false;
    let node: Node | null = selection.getRangeAt(0).commonAncestorContainer;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('milkdown-container')) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
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
    await this.openPendingPath();
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

  onContentChange(newContent?: string): void {
    if (newContent !== undefined) {
      this.selectedFileContent = newContent;
    }
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

  private async openRequestedPath(relativePath: string): Promise<void> {
    this.pendingOpenPath = relativePath;

    if (!this.permissionGranted) {
      return;
    }

    if (this.vaultEntries.length === 0) {
      await this.loadVaultEntries();
      return;
    }

    await this.openPendingPath();
  }

  private async openPendingPath(): Promise<void> {
    if (!this.pendingOpenPath || this.vaultEntries.length === 0) {
      return;
    }

    const entry = this.findEntryByPath(this.pendingOpenPath, this.vaultEntries);
    if (!entry || entry.kind !== 'file') {
      return;
    }

    this.pendingOpenPath = null;
    await this.selectFile(entry);
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
  }

  private isImageFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'].includes(ext || '');
  }

  private isPdfFile(path: string): boolean {
    return path.toLowerCase().endsWith('.pdf');
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  onWikilinkClick(path: string): void {
    if (path) {
      this.openInternalLink(path);
    }
  }

  private async openInternalLink(linkPath: string): Promise<void> {
    linkPath = linkPath.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    const currentFileDir = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');

    let entry = this.findEntryByPath(linkPath, this.vaultEntries);
    if (!entry && !linkPath.toLowerCase().endsWith('.md')) {
      entry = this.findEntryByPath(`${linkPath}.md`, this.vaultEntries);
    }

    if (!entry) {
      const relativePath = this.obsidianVaultService.resolveRelativePath(currentFileDir, linkPath);
      entry = this.findEntryByPath(relativePath, this.vaultEntries);
      if (!entry && !relativePath.toLowerCase().endsWith('.md')) {
        entry = this.findEntryByPath(`${relativePath}.md`, this.vaultEntries);
      }
    }

    if (!entry) {
      const fileName = linkPath.split('/').pop()!;
      entry = this.findEntryByName(fileName, this.vaultEntries);

      if (!entry && !fileName.toLowerCase().endsWith('.md')) {
        const fileNameWithMd = `${fileName}.md`;
        entry = this.findEntryByName(fileNameWithMd, this.vaultEntries);
      }
    }

    if (!entry) {
      const fileName = linkPath.split('/').pop()!;
      const baseName = fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
      entry = this.findEntryByBaseName(baseName, this.vaultEntries);
    }

    if (entry) {
      await this.selectFile(entry);
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

  /**
   * Unified broadcast method that decides whether to broadcast
   * the selection or the full document.
   */
  async broadcast(): Promise<void> {
    const broadcastedSelection = await this.broadcastSelection();
    if (!broadcastedSelection) {
      await this.broadcastFullDocument();
    }
  }

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
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, this.selectedFileRelativePath);
      data.file = new File([blob], this.selectedFileName, { type: blob.type });
    }

    this.dialog.open(BroadcastDialog, {
      data: data,
      maxWidth: '600px',
      width: '100%'
    });
  }

  async broadcastSelection(): Promise<boolean> {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;

    const range = selection.getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());

    let node: Node | null = range.commonAncestorContainer;
    let withinMarkdown = false;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('milkdown-container')) {
        withinMarkdown = true;
        break;
      }
      node = node.parentNode;
    }

    if (!withinMarkdown) return false;

    const embeddedFiles: BroadcastEmbeddedFile[] = [];
    const tokenCache = new Map<string, string>();

    // 1. Resolve images in the HTML selection (rendered <img> tags)
    const imgs = Array.from(container.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src) {
        const tokenizedUrl = await this.resolveAndTokenizeImage(src, img.getAttribute('alt') || 'image', embeddedFiles, tokenCache);
        img.setAttribute('src', tokenizedUrl);
      }
    }

    // 2. Resolve markdown in the text part of the selection
    const markdownBroadcast = await this.buildBroadcastMarkdown(selection.toString(), embeddedFiles, tokenCache);

    const data: BroadcastData = {
      text: markdownBroadcast.markdown,
      embeddedFiles: markdownBroadcast.embeddedFiles,
      htmlContent: container.innerHTML,
      source: 'obsidian-view-selection'
    };

    // Special case for single image selection
    if (imgs.length === 1 && container.innerText.trim() === '') {
       data.imageUrl = imgs[0].src;
    }

    this.dialog.open(BroadcastDialog, {
      data: data,
      maxWidth: '600px',
      width: '100%'
    });

    return true;
  }

  /**
   * Resolves a local path/URL to a file in the vault, prepares a tokenized BroadcastEmbeddedFile,
   * and returns the token URL. Returns original URL if it can't be resolved or is already external.
   */
  private async resolveAndTokenizeImage(url: string, alt: string, embeddedFiles: BroadcastEmbeddedFile[], cache: Map<string, string>): Promise<string> {
    if (!url) return url;

    // Normalize and cleanup the URL/path
    let cleanUrl = url.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');

    // 1. Strip browser-prepended origin if present (e.g. http://localhost/)
    const origin = window.location.origin;
    if (cleanUrl.startsWith(origin)) {
      cleanUrl = cleanUrl.substring(origin.length);
      if (cleanUrl.startsWith('/')) cleanUrl = cleanUrl.substring(1);
    }

    // 2. Decode the URL first, as it might be mangled/encoded by the browser or editor
    let decodedUrl = '';
    try {
      decodedUrl = decodeURIComponent(cleanUrl);
    } catch (e) {
      decodedUrl = cleanUrl;
    }

    // 3. Strip leading/trailing angle brackets < > often added by markdown parsers for autolinks
    decodedUrl = decodedUrl.replace(/^<+|<+$/g, '').replace(/^>+|>+$/g, '');

    // 4. Now check if it's already a valid external/final URL
    if (/^https?:\/\//i.test(decodedUrl) || decodedUrl.startsWith('broadcast-file://') || decodedUrl.startsWith('blob:')) {
      // If it doesn't contain our internal markers, we treat it as an external resource and return original URL
      if (!decodedUrl.includes('wikilink-blob:') && !decodedUrl.includes('file:///')) {
         return url;
      }
    }

    let searchPath = decodedUrl;
    if (decodedUrl.startsWith('file:///')) {
      searchPath = decodedUrl.replace('file:///', '');
    } else if (decodedUrl.startsWith('wikilink-blob:')) {
      searchPath = decodedUrl.replace('wikilink-blob:', '');
    }

    // Normalize slashes for consistency
    searchPath = searchPath.replace(/\\/g, '/');

    const resolvedPath = await this.resolveEmbedPath(searchPath);
    if (!resolvedPath || !this.isImageFile(resolvedPath)) {
      console.warn(`[ObsidianView] Could not resolve image path for broadcast: ${searchPath}`);
      return url;
    }

    // Check cache to avoid double-tokenizing the same resolved path
    if (cache.has(resolvedPath)) {
       return cache.get(resolvedPath)!;
    }

    try {
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
      const filename = alt?.trim() || resolvedPath.split('/').pop() || 'image';
      const file = new File([blob], filename, { type: blob.type });
      const tokenUrl = `broadcast-file://${crypto.randomUUID()}`;

      embeddedFiles.push({ tokenUrl, file });
      cache.set(resolvedPath, tokenUrl);
      console.log(`[ObsidianView] Tokenized image: ${resolvedPath} -> ${tokenUrl}`);
      return tokenUrl;
    } catch (e) {
      console.error(`[ObsidianView] Error reading resolved image for broadcast: ${resolvedPath}`, e);
      return url;
    }
  }

  private async buildBroadcastMarkdown(content: string, existingEmbeddedFiles: BroadcastEmbeddedFile[] = [], existingCache: Map<string, string> = new Map()): Promise<{ markdown: string; embeddedFiles: BroadcastEmbeddedFile[] }> {
    const embeddedFiles = existingEmbeddedFiles;
    const tokenCache = existingCache;

    // 1. First Pass: Handle Obsidian-style embeds: ![[image.png]]
    const embedRegex = /!\[\[(.*?)\]\]/g;
    let intermediateContent = '';
    let lastIndex = 0;

    const embedMatches = Array.from(content.matchAll(embedRegex));
    for (const match of embedMatches) {
      intermediateContent += content.slice(lastIndex, match.index);
      const linkContent = match[1].trim();

      const parts = linkContent.split('|');
      const filePath = parts[0].trim().replace(/\\/g, '/');
      const alt = parts.length > 1 ? parts[1].trim() : filePath;

      const tokenizedUrl = await this.resolveAndTokenizeImage(filePath, alt, embeddedFiles, tokenCache);
      intermediateContent += `![${alt}](${tokenizedUrl})`;
      lastIndex = (match.index || 0) + match[0].length;
    }
    intermediateContent += content.slice(lastIndex);

    // 2. Second Pass: Handle standard Markdown images: ![alt](url)
    const standardImageRegex = /!\[(.*?)\]\(([^)]+)\)/g;
    const matches = Array.from(intermediateContent.matchAll(standardImageRegex));

    let finalContent = '';
    lastIndex = 0;

    for (const match of matches) {
      finalContent += intermediateContent.slice(lastIndex, match.index);
      const alt = match[1];
      const url = match[2].trim();

      const tokenizedUrl = await this.resolveAndTokenizeImage(url, alt, embeddedFiles, tokenCache);
      finalContent += `![${alt}](${tokenizedUrl})`;

      lastIndex = (match.index || 0) + match[0].length;
    }
    finalContent += intermediateContent.slice(lastIndex);

    return { markdown: finalContent, embeddedFiles };
  }

  private async convertObsidianEmbedToMarkdown(linkContent: string, embeddedFiles: BroadcastEmbeddedFile[], cache: Map<string, string>): Promise<string> {
    const parts = linkContent.split('|');
    const filePath = parts[0].trim().replace(/\\/g, '/');
    const resolvedPath = await this.resolveEmbedPath(filePath);

    if (!resolvedPath) {
      return `![[${linkContent}]]`;
    }

    if (this.isImageFile(resolvedPath)) {
      const altText = parts.length > 1 ? parts[1].trim() : (resolvedPath.split('/').pop() || filePath);
      const tokenUrl = await this.resolveAndTokenizeImage(resolvedPath, altText, embeddedFiles, cache);
      return `![${altText}](${tokenUrl})`;
    }

    const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.push(objectUrl);

    if (this.isPdfFile(resolvedPath)) {
      const fileName = resolvedPath.split('/').pop() || filePath;
      return `[${fileName}](${objectUrl})`;
    }

    const fileName = resolvedPath.split('/').pop() || filePath;
    return `[${fileName}](${objectUrl})`;
  }

  private async resolveEmbedPath(filePath: string): Promise<string | null> {
    const currentFileDir = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');
    const cleanPath = filePath.trim().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\\/g, '/');

    // Attempt 1: Direct path
    try {
      await this.obsidianVaultService.readFileAsBlob(this.serverId, cleanPath);
      return cleanPath;
    } catch (e) {}

    // Attempt 2: Relative path
    const relativeToCurrent = this.obsidianVaultService.resolveRelativePath(currentFileDir, cleanPath);
    try {
      await this.obsidianVaultService.readFileAsBlob(this.serverId, relativeToCurrent);
      return relativeToCurrent;
    } catch (e) {}

    // Attempt 3: Filename only search
    const filenameOnly = cleanPath.includes('/') ? cleanPath.split('/').pop()! : cleanPath;
    const foundByFilename = await this.obsidianVaultService.findFileByFilename(this.serverId, filenameOnly);
    if (foundByFilename) {
      return foundByFilename;
    }

    return null;
  }
}

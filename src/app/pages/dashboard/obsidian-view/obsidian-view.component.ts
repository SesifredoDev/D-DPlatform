import { AfterViewInit, Component, OnInit, Input, OnDestroy, ChangeDetectorRef, OnChanges, SimpleChanges, ElementRef, HostListener, Output, EventEmitter } from '@angular/core';
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
import { ObsidianCanvasEditorComponent } from '../../../shared/components/obsidian-canvas-editor/obsidian-canvas-editor.component';

interface FolderGalleryImage {
  name: string;
  relativePath: string;
  url: string;
}

interface NoteTemplate {
  label: string;
  fileName: string;
}

export interface ObsidianPreviewTabRequest {
  serverId: string;
  path: string;
  title: string;
}

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
    MilkdownEditorComponent,
    ObsidianCanvasEditorComponent
  ],
  templateUrl: './obsidian-view.component.html',
  styleUrl: './obsidian-view.component.scss'
})
export class ObsidianViewComponent implements OnInit, AfterViewInit, OnDestroy, OnChanges {
  @Input() serverId!: string;
  @Input() openPath: string | null = null;
  @Input() openRequestId: number | null = null;
  @Input() previewOnly = false;
  @Output() previewTabRequested = new EventEmitter<ObsidianPreviewTabRequest>();
  vaultName: string | null = null;
  localhostRoute: string | null = null;
  vaultEntries: VaultEntry[] = [];
  treeFilter = '';

  selectedFileContent: string = '';
  // processedContent is not needed for Milkdown as it handles its own rendering

  selectedFileName: string = ''; // Full filename with extension
  selectedFileDisplayName: string = ''; // Name without extension for editing
  selectedFileRelativePath: string = '';
  selectedFolderName = '';
  selectedFolderRelativePath = '';
  selectedFolderImages: FolderGalleryImage[] = [];
  isEditing: boolean = false;
  permissionGranted: boolean = false;
  fileSystemApiSupported: boolean = false;
  isVaultLoading = false;
  vaultError: string | null = null;

  // For non-markdown files
  nonMarkdownUrl: SafeUrl | null = null;
  isImage: boolean = false;
  isPdf: boolean = false;

  readonly noteTemplates: NoteTemplate[] = [
    { label: '5e Statblock', fileName: '5e Statblock.md' },
    { label: 'Historical Event', fileName: 'Historical Event.md' },
    { label: 'Item', fileName: 'Item.md' },
    { label: 'Location', fileName: 'Location.md' },
    { label: 'Lore & Mythology', fileName: 'Lore & Mythology.md' },
    { label: 'Magical Artefact or System', fileName: 'Magical Artefact or System.md' },
    { label: 'NPC', fileName: 'NPC.md' },
    { label: 'Organisation', fileName: 'Organisation.md' },
    { label: 'Player Character', fileName: 'Player Character.md' },
    { label: 'Race', fileName: 'Race.md' },
    { label: 'Session', fileName: '🎲 Session {{number}} - {{date}}.md' },
    { label: 'Story Arc', fileName: 'Story Arc.md' },
    { label: 'Story Event', fileName: 'Story Event.md' },
  ];

  isCreatingFile = false;
  newFileKind: 'note' | 'canvas' = 'note';
  newFileName = '';
  selectedTemplateFileName = '';
  createFileError = '';
  isCreatingFolder = false;
  newFolderName = '';
  createFolderError = '';
  isCompactSidebarLayout = false;
  isMobileSidebarOpen = false;
  saveState: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
  lastSavedAt: Date | null = null;
  draggedEntryPath: string | null = null;
  activeDropTargetPath: string | null = null;

  // Context Menu Support
  contextMenuPosition = { x: '0px', y: '0px' };
  private pendingImageBroadcast: { src: string; alt: string; path: string | null } | null = null;

  hasActiveSelection: boolean = false;

  private objectUrls: string[] = [];
  private contentChanged = new Subject<void>();
  private autoSaveSubscription?: Subscription;
  private pendingOpenPath: string | null = null;
  private filteredEntriesCacheQuery = '';
  private filteredEntriesCacheSource: VaultEntry[] | null = null;
  private filteredEntriesCache: VaultEntry[] = [];
  private saveStateResetTimer?: ReturnType<typeof setTimeout>;
  private sidebarResizeObserver?: ResizeObserver;
  private readonly compactSidebarWidth = 960;
  private readonly vaultEntryDragType = 'application/x-dd-vault-entry';

  constructor(
    private obsidianVaultService: ObsidianVaultService,
    private route: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private dialog: MatDialog,
    private cdr: ChangeDetectorRef,
    private hostRef: ElementRef<HTMLElement>
  ) {}

  get visibleVaultEntries(): VaultEntry[] {
    const query = this.treeFilter.trim().toLowerCase();
    if (!query) return this.vaultEntries;

    if (this.filteredEntriesCacheQuery === query && this.filteredEntriesCacheSource === this.vaultEntries) {
      return this.filteredEntriesCache;
    }

    this.filteredEntriesCacheQuery = query;
    this.filteredEntriesCacheSource = this.vaultEntries;
    this.filteredEntriesCache = this.filterVaultEntries(this.vaultEntries, query);
    return this.filteredEntriesCache;
  }

  get totalEntryCount(): number {
    return this.countEntries(this.vaultEntries);
  }

  get totalFileCount(): number {
    return this.countEntries(this.vaultEntries, entry => entry.kind === 'file');
  }

  get totalFolderCount(): number {
    return this.countEntries(this.vaultEntries, entry => entry.kind === 'directory');
  }

  get visibleFileCount(): number {
    return this.countEntries(this.visibleVaultEntries, entry => entry.kind === 'file');
  }

  get visibleFolderCount(): number {
    return this.countEntries(this.visibleVaultEntries, entry => entry.kind === 'directory');
  }

  get hasTreeFilter(): boolean {
    return this.treeFilter.trim().length > 0;
  }

  get isRootDropTarget(): boolean {
    return this.draggedEntryPath !== null && this.activeDropTargetPath === '';
  }

  get saveStateLabel(): string {
    if (this.saveState === 'saving') return 'Saving';
    if (this.saveState === 'error') return 'Save failed';
    if (this.lastSavedAt) return 'Saved';
    return 'Saved';
  }

  get isMarkdownFileSelected(): boolean {
    const lowerName = this.selectedFileName.toLowerCase();
    return lowerName.endsWith('.md') || lowerName.endsWith('.markdown');
  }

  get isCanvasFileSelected(): boolean {
    return this.isCanvasFile(this.selectedFileName);
  }

  get isViewingFolder(): boolean {
    return this.selectedFolderRelativePath.length > 0;
  }

  get hasActiveView(): boolean {
    return this.isEditing || this.isViewingFolder;
  }

  get activeNavigationPath(): string {
    return this.selectedFolderRelativePath || this.selectedFileRelativePath;
  }

  ngOnInit(): void {
    this.syncResponsiveSidebarState(false);
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

  ngAfterViewInit(): void {
    this.syncResponsiveSidebarState(true);

    if (typeof ResizeObserver !== 'undefined') {
      this.sidebarResizeObserver = new ResizeObserver(() => {
        this.syncResponsiveSidebarState(true);
      });
      this.sidebarResizeObserver.observe(this.hostRef.nativeElement);
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.syncResponsiveSidebarState(true);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['openPath'] || changes['openRequestId']) && this.openPath) {
      void this.openRequestedPath(this.openPath);
    }
  }

  ngOnDestroy(): void {
    this.revokeObjectUrls();
    this.autoSaveSubscription?.unsubscribe();
    if (this.saveStateResetTimer) {
      clearTimeout(this.saveStateResetTimer);
    }
    this.sidebarResizeObserver?.disconnect();
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
      try {
        this.vaultError = null;
        this.localhostRoute = this.obsidianVaultService.getVaultLocalhostRoute(this.serverId);

        const handle = await this.obsidianVaultService.getVaultHandle(this.serverId);
        if (handle) {
          this.vaultName = handle.name;
          this.permissionGranted = await this.obsidianVaultService.hasPermission(this.serverId);
          if (this.permissionGranted) {
            await this.loadVaultEntries();
          }
        }
      } catch (err) {
        this.vaultError = 'Unable to load vault information.';
        console.error('Failed to load vault info:', err);
      }
    }
  }

  async attachVault(): Promise<void> {
    if (!this.fileSystemApiSupported) return;

    if (this.serverId) {
      try {
        this.vaultError = null;
        this.vaultName = await this.obsidianVaultService.attachVaultToServer(this.serverId);
        this.permissionGranted = true;
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        await this.loadVaultEntries(false);
      } catch (err) {
        this.vaultError = 'Unable to attach vault.';
        console.error('Failed to attach vault:', err);
      }
    }
  }

  async requestPermission(): Promise<void> {
    const handle = await this.obsidianVaultService.getVaultHandle(this.serverId);
    if (handle) {
      try {
        this.vaultError = null;
        this.permissionGranted = await this.obsidianVaultService.requestPermission(handle);
        if (this.permissionGranted) {
          await this.loadVaultEntries(false);
        }
      } catch (err) {
        this.vaultError = 'Unable to request vault access.';
        console.error('Failed to request vault permission:', err);
      }
    }
  }

  async loadVaultEntries(useCache = false): Promise<void> {
    if (!this.serverId || !this.permissionGranted) return;

    this.isVaultLoading = true;
    this.vaultError = null;
    try {
      this.vaultEntries = await this.obsidianVaultService.listVaultFiles(this.serverId, useCache);
      await this.openPendingPath();
      await this.refreshSelectedFolder();
    } catch (err) {
      this.vaultError = 'Unable to load vault files.';
      console.error('Failed to load vault entries:', err);
    } finally {
      this.isVaultLoading = false;
    }
  }

  async selectFile(entry: VaultEntry): Promise<void> {
    if (entry.kind === 'directory') return;

    this.revokeObjectUrls();
    this.clearFolderViewState();
    this.selectedFileName = entry.name;
    this.selectedFileDisplayName = this.getDisplayName(entry.name);
    this.selectedFileRelativePath = entry.relativePath;
    this.isEditing = true;
    this.saveState = 'saved';
    this.lastSavedAt = null;

    if (
      entry.name.toLowerCase().endsWith('.md') ||
      entry.name.toLowerCase().endsWith('.markdown') ||
      this.isCanvasFile(entry.name)
    ) {
      this.isImage = false;
      this.isPdf = false;
      this.nonMarkdownUrl = null;
      this.selectedFileContent = await this.obsidianVaultService.readFile(this.serverId, entry.relativePath);
    } else {
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, entry.relativePath);
      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      this.nonMarkdownUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
      this.isImage = this.isImageFile(entry.name);
      this.isPdf = this.isPdfFile(entry.name);
      this.selectedFileContent = '';
    }

    this.closeMobileSidebar();
  }

  async selectFolder(entry: VaultEntry): Promise<void> {
    if (entry.kind !== 'directory') return;

    const sourceEntry = this.findEntryByPath(entry.relativePath, this.vaultEntries) || entry;
    this.revokeObjectUrls();
    this.clearFileViewState();
    this.selectedFolderName = sourceEntry.name;
    this.selectedFolderRelativePath = sourceEntry.relativePath;
    this.selectedFolderImages = [];

    const imageEntries = this.collectFolderImages(sourceEntry);

    const images = await Promise.all(imageEntries.map(async imageEntry => {
      try {
        const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, imageEntry.relativePath);
        const url = URL.createObjectURL(blob);
        this.objectUrls.push(url);
        return {
          name: imageEntry.name,
          relativePath: imageEntry.relativePath,
          url,
        };
      } catch (error) {
        console.warn('[ObsidianView] Failed to load gallery image', imageEntry.relativePath, error);
        return null;
      }
    }));

    this.selectedFolderImages = images.filter((image): image is FolderGalleryImage => !!image);
    this.closeMobileSidebar();
  }

  startNewFile(kind: 'note' | 'canvas' = 'note'): void {
    if (!this.permissionGranted) return;

    this.isCreatingFile = true;
    this.isCreatingFolder = false;
    this.newFileKind = kind;
    this.newFileName = '';
    this.selectedTemplateFileName = '';
    this.createFileError = '';
    this.createFolderError = '';
    this.openMobileSidebar();
  }

  startNewCanvas(): void {
    this.startNewFile('canvas');
  }

  cancelNewFile(): void {
    this.isCreatingFile = false;
    this.newFileKind = 'note';
    this.newFileName = '';
    this.selectedTemplateFileName = '';
    this.createFileError = '';
  }

  startNewFolder(): void {
    if (!this.permissionGranted) return;

    this.isCreatingFolder = true;
    this.isCreatingFile = false;
    this.newFileKind = 'note';
    this.newFolderName = this.selectedFolderRelativePath ? `${this.selectedFolderRelativePath}/` : '';
    this.createFolderError = '';
    this.createFileError = '';
    this.openMobileSidebar();
  }

  cancelNewFolder(): void {
    this.isCreatingFolder = false;
    this.newFolderName = '';
    this.createFolderError = '';
  }

  toggleMobileSidebar(): void {
    if (!this.isCompactSidebarLayout) return;

    this.isMobileSidebarOpen = !this.isMobileSidebarOpen;
  }

  openMobileSidebar(): void {
    if (!this.isCompactSidebarLayout) return;

    this.isMobileSidebarOpen = true;
  }

  closeMobileSidebar(): void {
    this.isMobileSidebarOpen = false;
  }

  private syncResponsiveSidebarState(detectChanges: boolean): void {
    const hostWidth = this.hostRef.nativeElement.getBoundingClientRect().width;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : hostWidth;
    const measuredWidth = hostWidth > 0 ? hostWidth : viewportWidth;
    const isCompact = measuredWidth <= this.compactSidebarWidth;

    if (this.isCompactSidebarLayout !== isCompact) {
      this.isCompactSidebarLayout = isCompact;
      this.isMobileSidebarOpen = false;

      if (detectChanges) {
        this.cdr.detectChanges();
      }
    }
  }

  async createNewFile(): Promise<void> {
    const fullFileName = this.buildNewFilePath(this.newFileName);
    const attemptedKind = this.newFileKind;
    if (!fullFileName) {
      this.createFileError = attemptedKind === 'canvas' ? 'Enter a canvas name.' : 'Enter a note name.';
      return;
    }

    try {
      const initialContent = await this.loadSelectedTemplateContent(fullFileName);
      await this.obsidianVaultService.writeFile(this.serverId, fullFileName, initialContent);
      this.cancelNewFile();
      await this.loadVaultEntries(false);

      const newEntry = this.findEntryByPath(fullFileName, this.vaultEntries);
      if (newEntry) {
        await this.selectFile(newEntry);
      }
    } catch (err) {
      this.createFileError = attemptedKind === 'canvas' ? 'Unable to create canvas.' : 'Unable to create note.';
      console.error('Failed to create file:', err);
    }
  }

  async createNewFolder(): Promise<void> {
    const folderPath = this.buildNewFolderPath(this.newFolderName);
    if (!folderPath) {
      this.createFolderError = 'Enter a folder name.';
      return;
    }

    try {
      await this.obsidianVaultService.createFolder(this.serverId, folderPath);
      this.cancelNewFolder();
      await this.loadVaultEntries(false);

      const newEntry = this.findEntryByPath(folderPath, this.vaultEntries);
      if (newEntry?.kind === 'directory') {
        await this.selectFolder(newEntry);
      }
    } catch (err) {
      this.createFolderError = 'Unable to create folder.';
      console.error('Failed to create folder:', err);
    }
  }

  private async loadSelectedTemplateContent(filePath: string): Promise<string> {
    if (this.isCanvasFile(filePath)) {
      return this.obsidianVaultService.getObsidianCanvasTemplate();
    }

    if (!this.selectedTemplateFileName) return '';

    const template = this.noteTemplates.find(item => item.fileName === this.selectedTemplateFileName);
    if (!template) return '';

    const response = await fetch(this.getTemplateAssetUrl(template.fileName), { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Unable to load template: ${template.fileName}`);
    }

    const content = await response.text();
    return this.applyTemplateVariables(content, filePath);
  }

  private getTemplateAssetUrl(fileName: string): string {
    return new URL(`assets/templates/${encodeURIComponent(fileName)}`, document.baseURI).toString();
  }

  private applyTemplateVariables(content: string, filePath: string): string {
    const title = this.getDisplayName(filePath.split('/').pop() || filePath);
    const today = this.getTemplateDate();
    const number = title.match(/\d+/)?.[0] || '';
    const values: Record<string, string> = {
      title,
      name: title,
      date: today,
      number,
    };

    return content.replace(/{{\s*(title|name|date|number)\s*}}/gi, (_, key: string) => {
      return values[key.toLowerCase()] ?? '';
    });
  }

  private getTemplateDate(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private buildNewFilePath(fileName: string): string | null {
    const normalized = fileName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return null;

    const filePart = normalized.split('/').pop() || normalized;
    const defaultExtension = this.newFileKind === 'canvas' ? '.canvas' : '.md';
    return filePart.includes('.') ? normalized : `${normalized}${defaultExtension}`;
  }

  private buildNewFolderPath(folderName: string): string | null {
    const normalized = folderName
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/{2,}/g, '/');

    return normalized || null;
  }

  async renameSelectedFile(): Promise<void> {
    if (this.previewOnly) return;

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
      await this.loadVaultEntries(false);
    } catch (err) {
      console.error('Failed to rename file:', err);
      this.selectedFileDisplayName = currentDisplayName;
    }
  }

  getDisplayName(name: string): string {
    const lowerName = name.toLowerCase();
    if (lowerName.endsWith('.markdown')) return name.slice(0, -9);
    if (lowerName.endsWith('.canvas')) return name.slice(0, -7);
    if (lowerName.endsWith('.md')) return name.slice(0, -3);
    return name;
  }

  getFileIcon(name: string): string {
    const lowerName = name.toLowerCase();
    if (this.isCanvasFile(name)) return 'account_tree';
    if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) return 'description';
    if (this.isImageFile(name)) return 'image';
    if (this.isPdfFile(name)) return 'picture_as_pdf';
    if (/\.(mp3|wav|ogg|flac|m4a)$/i.test(name)) return 'graphic_eq';
    if (/\.(mp4|webm|mov|avi)$/i.test(name)) return 'movie';
    return 'insert_drive_file';
  }

  pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  getFolderMeta(entry: VaultEntry): string {
    const children = entry.children || [];
    if (children.length === 0) return 'Empty';

    const folderCount = children.filter(child => child.kind === 'directory').length;
    const fileCount = children.length - folderCount;
    const parts = [];

    if (folderCount > 0) {
      parts.push(this.pluralize(folderCount, 'folder'));
    }

    if (fileCount > 0) {
      parts.push(this.pluralize(fileCount, 'file'));
    }

    return parts.join(', ');
  }

  getFileTypeLabel(name: string): string {
    if (this.isCanvasFile(name)) return 'Canvas';
    if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) return 'MD';

    const extension = name.split('.').pop();
    return extension && extension !== name ? extension.toUpperCase() : 'File';
  }

  getFileLocationLabel(entry: VaultEntry): string {
    return entry.parentPath || 'Vault root';
  }

  isFileSelected(entry: VaultEntry): boolean {
    return this.selectedFileRelativePath === entry.relativePath;
  }

  isFolderSelected(entry: VaultEntry): boolean {
    return this.selectedFolderRelativePath === entry.relativePath;
  }

  isFolderInActivePath(entry: VaultEntry): boolean {
    const activePath = this.activeNavigationPath;
    return activePath === entry.relativePath || activePath.startsWith(`${entry.relativePath}/`);
  }

  isDropTarget(entry: VaultEntry): boolean {
    return this.draggedEntryPath !== null && this.activeDropTargetPath === entry.relativePath;
  }

  openSelectedFilePreviewTab(): void {
    if (!this.selectedFileRelativePath) return;

    this.requestPreviewTab(this.selectedFileRelativePath, this.selectedFileName || this.selectedFileRelativePath);
  }

  openEntryPreviewTab(entry: VaultEntry, event?: Event): void {
    event?.stopPropagation();
    if (entry.kind !== 'file') return;

    this.requestPreviewTab(entry.relativePath, entry.name);
    this.closeMobileSidebar();
  }

  async broadcastEntry(entry: VaultEntry, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (entry.kind !== 'file') return;

    await this.selectFile(entry);
    await this.broadcastFullDocument();
  }

  async selectContainingFolder(entry: VaultEntry, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!entry.parentPath) return;

    const folder = this.findEntryByPath(entry.parentPath, this.vaultEntries);
    if (folder?.kind === 'directory') {
      await this.selectFolder(folder);
    }
  }

  startNewFileInFolder(entry: VaultEntry, kind: 'note' | 'canvas' = 'note', event?: Event): void {
    event?.stopPropagation();
    if (entry.kind !== 'directory') return;

    this.startNewFile(kind);
    this.newFileName = entry.relativePath ? `${entry.relativePath}/` : '';
  }

  startNewFolderInFolder(entry: VaultEntry, event?: Event): void {
    event?.stopPropagation();
    if (entry.kind !== 'directory') return;

    this.startNewFolder();
    this.newFolderName = entry.relativePath ? `${entry.relativePath}/` : '';
  }

  trackEntry(index: number, entry: VaultEntry): string {
    return `${entry.kind}:${entry.relativePath || entry.name}:${index}`;
  }

  onContentChange(newContent?: string): void {
    if (this.previewOnly) return;

    if (newContent !== undefined) {
      this.selectedFileContent = newContent;
    }
    this.saveState = 'saving';
    this.contentChanged.next();
  }

  insertStatsheetTemplate(): void {
    if (this.previewOnly || !this.isMarkdownFileSelected) return;

    const content = this.selectedFileContent.trimEnd();
    const statsheet = this.obsidianVaultService.getDndStatsheetTemplate();
    this.selectedFileContent = `${content}${content ? '\n\n' : ''}${statsheet}\n`;
    this.onContentChange(this.selectedFileContent);
  }

  onDragStart(event: DragEvent, entry: VaultEntry): void {
    this.draggedEntryPath = entry.relativePath;
    this.activeDropTargetPath = null;

    if (event.dataTransfer) {
      event.dataTransfer.setData(this.vaultEntryDragType, JSON.stringify({
        kind: entry.kind,
        name: entry.name,
        relativePath: entry.relativePath,
        parentPath: entry.parentPath,
      }));
      event.dataTransfer.setData('text/plain', entry.relativePath);
      event.dataTransfer.effectAllowed = 'copyMove';
    }
  }

  onDragEnd(): void {
    this.clearDragState();
  }

  onDragOver(event: DragEvent, targetEntry?: VaultEntry): void {
    event.preventDefault();
    event.stopPropagation();

    const targetDirPath = (targetEntry && targetEntry.kind === 'directory') ? targetEntry.relativePath : '';
    const sourcePath = this.draggedEntryPath || event.dataTransfer?.getData('text/plain') || '';
    const canDrop = sourcePath ? this.canDropOnTarget(sourcePath, targetDirPath) : true;

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
    }

    this.activeDropTargetPath = canDrop ? targetDirPath : null;
  }

  onDragLeave(event: DragEvent, targetEntry?: VaultEntry): void {
    const currentTarget = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }

    const targetDirPath = (targetEntry && targetEntry.kind === 'directory') ? targetEntry.relativePath : '';
    if (this.activeDropTargetPath === targetDirPath) {
      this.activeDropTargetPath = null;
    }
  }

  async onDrop(event: DragEvent, targetEntry?: VaultEntry): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    const sourcePath = this.draggedEntryPath || event.dataTransfer?.getData('text/plain');
    if (!sourcePath) {
      this.clearDragState();
      return;
    }

    const targetDirPath = (targetEntry && targetEntry.kind === 'directory') ? targetEntry.relativePath : '';

    if (!this.canDropOnTarget(sourcePath, targetDirPath)) {
      this.clearDragState();
      return;
    }

    try {
      const newPath = await this.obsidianVaultService.moveEntry(this.serverId, sourcePath, targetDirPath);
      await this.loadVaultEntries(false);

      if (this.selectedFileRelativePath === sourcePath) {
        this.selectedFileRelativePath = newPath;
      }

      await this.refreshSelectedFolder();
    } catch (err) {
      console.error('Failed to move entry:', err);
    } finally {
      this.clearDragState();
    }
  }

  private canDropOnTarget(sourcePath: string, targetDirPath: string): boolean {
    const sourceEntry = this.findEntryByPath(sourcePath, this.vaultEntries);
    if (!sourceEntry) return false;
    if (sourceEntry.parentPath === targetDirPath) return false;
    if (sourcePath === targetDirPath) return false;

    return sourceEntry.kind !== 'directory' || !targetDirPath.startsWith(`${sourcePath}/`);
  }

  private clearDragState(): void {
    this.draggedEntryPath = null;
    this.activeDropTargetPath = null;
  }

  async deleteEntry(entry: VaultEntry, event?: Event): Promise<void> {
    if (event) event.stopPropagation();

    if (confirm(`Are you sure you want to delete ${entry.name}?`)) {
      try {
        await this.obsidianVaultService.deleteEntry(this.serverId, entry.relativePath);
        if (
          this.selectedFileRelativePath === entry.relativePath ||
          this.selectedFileRelativePath.startsWith(`${entry.relativePath}/`)
        ) {
          this.cancelEdit();
        }
        if (
          this.selectedFolderRelativePath === entry.relativePath ||
          this.selectedFolderRelativePath.startsWith(`${entry.relativePath}/`)
        ) {
          this.cancelFolderView();
        }
        await this.loadVaultEntries(false);
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

  onImageContextMenu(event: MouseEvent, trigger: MatMenuTrigger): void {
    const image = this.findContextImage(event.target);
    if (!image) return;

    const src = image.getAttribute('src') || '';
    if (!src) return;

    event.preventDefault();
    event.stopPropagation();

    this.pendingImageBroadcast = {
      src,
      alt: image.getAttribute('alt') || image.getAttribute('title') || 'image',
      path: image.getAttribute('data-path') || null,
    };
    this.contextMenuPosition.x = `${event.clientX}px`;
    this.contextMenuPosition.y = `${event.clientY}px`;
    trigger.openMenu();
  }

  async broadcastContextImage(): Promise<void> {
    if (!this.pendingImageBroadcast) return;

    const image = this.pendingImageBroadcast;
    this.pendingImageBroadcast = null;
    const searchPath = this.extractImageSearchPath(image.src, image.path);
    const filename = this.getBroadcastImageFilename(image.alt, searchPath, image.src);
    const data: BroadcastData = {
      source: 'obsidian-view-image',
      filename,
    };

    if (searchPath) {
      const resolvedPath = await this.resolveEmbedPath(searchPath);
      if (resolvedPath && this.isImageFile(resolvedPath)) {
        try {
          const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, resolvedPath);
          data.filename = resolvedPath.split('/').pop() || filename;
          data.file = new File([blob], data.filename, { type: blob.type || this.inferImageMimeType(data.filename) });
          this.openBroadcastDialog(data);
          return;
        } catch (error) {
          console.warn('[ObsidianView] Failed to read right-clicked image from vault', resolvedPath, error);
        }
      }
    }

    data.imageUrl = image.src;
    this.openBroadcastDialog(data);
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

  private clearFileViewState(): void {
    this.isEditing = false;
    this.selectedFileName = '';
    this.selectedFileDisplayName = '';
    this.selectedFileRelativePath = '';
    this.selectedFileContent = '';
    this.nonMarkdownUrl = null;
    this.isImage = false;
    this.isPdf = false;
    this.saveState = 'idle';
    this.lastSavedAt = null;
  }

  private clearFolderViewState(): void {
    this.selectedFolderName = '';
    this.selectedFolderRelativePath = '';
    this.selectedFolderImages = [];
  }

  private findContextImage(target: EventTarget | null): HTMLImageElement | null {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest('img');
  }

  private extractImageSearchPath(src: string, dataPath: string | null): string | null {
    if (dataPath) return dataPath;

    let cleanSrc = src.trim();
    const origin = window.location.origin;
    if (cleanSrc.startsWith(origin)) {
      cleanSrc = cleanSrc.substring(origin.length).replace(/^\/+/, '');
    }

    try {
      cleanSrc = decodeURIComponent(cleanSrc);
    } catch (e) {}

    cleanSrc = cleanSrc.replace(/^<+|<+$/g, '').replace(/^>+|>+$/g, '');

    if (cleanSrc.startsWith('wikilink-blob:')) {
      return cleanSrc.replace('wikilink-blob:', '');
    }

    if (cleanSrc.startsWith('file:///')) {
      return cleanSrc.replace('file:///', '');
    }

    if (/^(https?:|blob:|data:|broadcast-file:)/i.test(cleanSrc)) {
      return null;
    }

    return cleanSrc || null;
  }

  private getBroadcastImageFilename(alt: string, path: string | null, src: string): string {
    const candidate = path?.split('/').pop() || alt || src.split('/').pop() || 'image';
    return candidate.includes('.') ? candidate : `${candidate}.png`;
  }

  private inferImageMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'jpg') return 'image/jpeg';
    return ext ? `image/${ext}` : 'image/png';
  }

  private filterVaultEntries(entries: VaultEntry[], query: string): VaultEntry[] {
    return entries.reduce<VaultEntry[]>((matches, entry) => {
      const childMatches = entry.children ? this.filterVaultEntries(entry.children, query) : [];
      const entryMatches =
        entry.name.toLowerCase().includes(query) ||
        entry.relativePath.toLowerCase().includes(query);

      if (entryMatches) {
        matches.push(entry);
      } else if (childMatches.length > 0) {
        matches.push({ ...entry, children: childMatches });
      }

      return matches;
    }, []);
  }

  private countEntries(entries: VaultEntry[], predicate: (entry: VaultEntry) => boolean = () => true): number {
    return entries.reduce((count, entry) => {
      const childrenCount = entry.children ? this.countEntries(entry.children, predicate) : 0;
      return count + (predicate(entry) ? 1 : 0) + childrenCount;
    }, 0);
  }

  private collectFolderImages(entry: VaultEntry): VaultEntry[] {
    return (entry.children || []).flatMap(child => {
      if (child.kind === 'file') {
        return this.isImageFile(child.name) ? [child] : [];
      }

      return this.collectFolderImages(child);
    });
  }

  private async refreshSelectedFolder(): Promise<void> {
    if (!this.selectedFolderRelativePath) return;

    const entry = this.findEntryByPath(this.selectedFolderRelativePath, this.vaultEntries);
    if (entry && entry.kind === 'directory') {
      await this.selectFolder(entry);
    } else {
      this.cancelFolderView();
    }
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
    if (!entry) {
      return;
    }

    this.pendingOpenPath = null;
    if (entry.kind === 'directory') {
      await this.selectFolder(entry);
    } else {
      await this.selectFile(entry);
    }
  }

  async saveFile(): Promise<void> {
    if (
      !this.previewOnly &&
      this.selectedFileRelativePath &&
      (this.isMarkdownFileSelected || this.isCanvasFileSelected)
    ) {
      try {
        this.saveState = 'saving';
        await this.obsidianVaultService.writeFile(
          this.serverId,
          this.selectedFileRelativePath,
          this.selectedFileContent
        );
        this.lastSavedAt = new Date();
        this.saveState = 'saved';
        this.scheduleSaveStateReset();
      } catch (err) {
        this.saveState = 'error';
        console.error('Failed to auto-save file:', err);
      }
    }
  }

  private isImageFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'].includes(ext || '');
  }

  private isCanvasFile(path: string): boolean {
    return path.toLowerCase().endsWith('.canvas');
  }

  private isPdfFile(path: string): boolean {
    return path.toLowerCase().endsWith('.pdf');
  }

  private scheduleSaveStateReset(): void {
    if (this.saveStateResetTimer) {
      clearTimeout(this.saveStateResetTimer);
    }

    this.saveStateResetTimer = setTimeout(() => {
      if (this.saveState === 'saved') {
        this.saveState = 'idle';
      }
    }, 2000);
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  onWikilinkClick(path: string): void {
    if (path) {
      if (this.previewOnly) {
        this.openInternalLinkPreviewTab(path);
        return;
      }

      this.openInternalLink(path);
    }
  }

  onCanvasFileOpen(path: string): void {
    if (!path) return;

    if (this.previewOnly) {
      this.openInternalLinkPreviewTab(path);
      return;
    }

    void this.openInternalLink(path);
  }

  openGalleryImage(path: string): void {
    void this.openInternalLink(path);
  }

  private async openInternalLink(linkPath: string): Promise<void> {
    linkPath = linkPath.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
    const entry = this.resolveInternalLinkEntry(linkPath);

    if (entry) {
      await this.selectFile(entry);
    }
  }

  private openInternalLinkPreviewTab(linkPath: string): void {
    const entry = this.resolveInternalLinkEntry(linkPath.trim().replace(/[\u200B-\u200D\uFEFF]/g, ''));
    if (entry?.kind === 'file') {
      this.requestPreviewTab(entry.relativePath, entry.name);
    }
  }

  private resolveInternalLinkEntry(linkPath: string): VaultEntry | null {
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

    return entry;
  }

  private requestPreviewTab(path: string, name: string): void {
    if (!this.serverId || !path) return;

    this.previewTabRequested.emit({
      serverId: this.serverId,
      path,
      title: this.getDisplayName(name.split('/').pop() || name),
    });
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
    this.clearFileViewState();
    this.revokeObjectUrls();
  }

  cancelFolderView(): void {
    this.clearFolderViewState();
    this.revokeObjectUrls();
  }

  closeActiveView(): void {
    if (this.isEditing) {
      this.cancelEdit();
      return;
    }

    this.cancelFolderView();
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

  private openBroadcastDialog(data: BroadcastData): void {
    this.dialog.open(BroadcastDialog, {
      data,
      maxWidth: '600px',
      width: '100%',
      panelClass: ['glass-dialog-container', 'broadcast-dialog-panel']
    });
  }

  async broadcastFullDocument(): Promise<void> {
    if (!this.selectedFileContent && !this.nonMarkdownUrl) return;

    let data: BroadcastData = {
      source: 'obsidian-view',
      filename: this.selectedFileName
    };

    if (this.isMarkdownFileSelected) {
      const embeddedFiles: BroadcastEmbeddedFile[] = [];
      const tokenCache = new Map<string, string>();
      const htmlContent = this.buildBroadcastHtmlFromEditor();
      const markdownBroadcast = await this.buildBroadcastMarkdown(this.selectedFileContent, embeddedFiles, tokenCache);
      data.text = markdownBroadcast.markdown;
      data.embeddedFiles = markdownBroadcast.embeddedFiles;
      data.htmlContent = htmlContent;
      data.preferTextForBroadcast = true;
    } else {
      const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, this.selectedFileRelativePath);
      data.file = new File([blob], this.selectedFileName, { type: blob.type });
    }

    this.openBroadcastDialog(data);
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

    this.openBroadcastDialog(data);

    return true;
  }

  private buildBroadcastHtmlFromEditor(): string | undefined {
    const editorContent = this.hostRef.nativeElement.querySelector<HTMLElement>(
      '.milkdown-container .ProseMirror, .milkdown-container'
    );

    return editorContent?.innerHTML;
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

import { AfterViewInit, Component, OnInit, Input, OnDestroy, ChangeDetectorRef, OnChanges, SimpleChanges, ElementRef, HostListener, Output, EventEmitter, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ObsidianVaultService, VaultConflictError, VaultEntry } from '../../../shared/services/ObsidianVault/obsidian-vault-service';
import { TextSegment, highlightTerms } from '../../../shared/services/ObsidianVault/vault-search-utils';
import { VaultQuickSwitcherComponent } from './quick-switcher/quick-switcher.component';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { MilkdownEditorComponent } from '../../../shared/components/milkdown-editor/milkdown-editor.component';
import { ObsidianCanvasEditorComponent } from '../../../shared/components/obsidian-canvas-editor/obsidian-canvas-editor.component';
import { DndStatsheetService } from '../../../shared/services/ObsidianVault/dnd-statsheet.service';
import { BacklinkMention, VaultIndex, VaultIndexService, extractInlineTags } from '../../../shared/services/ObsidianVault/vault-index.service';
import { normalizeTagInput, readFrontmatterTags, setFrontmatterTags } from '../../../shared/services/ObsidianVault/frontmatter';
import { rewriteMovedLinks } from '../../../shared/services/ObsidianVault/link-rewrite';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ObsidianBroadcastService, VaultImageBroadcast } from '../../../shared/services/ObsidianVault/obsidian-broadcast.service';
import { NOTE_TEMPLATES, findNoteTemplate, loadNoteTemplate } from '../../../shared/services/ObsidianVault/note-templates';
import {
  VaultFileType,
  getVaultDisplayName,
  getVaultFileType,
  getVaultFileTypeById,
  getVaultFileTypeLabel,
} from '../../../shared/services/ObsidianVault/vault-file-types';

interface FolderGalleryImage {
  name: string;
  relativePath: string;
  url: string;
}

export interface ObsidianPreviewTabRequest {
  serverId: string;
  path: string;
  title: string;
}

/** What the main pane is showing. Exactly one of these at a time. */
type ActiveView =
  | { kind: 'none' }
  | { kind: 'folder'; name: string; relativePath: string; images: FolderGalleryImage[] }
  | {
      kind: 'file';
      name: string;
      relativePath: string;
      fileType: VaultFileType;
      /** Text content for text types (markdown, canvas); '' otherwise. */
      content: string;
      /** Object URL for blob types (images, PDFs, downloads). */
      blobUrl: SafeUrl | null;
      /** Set when the file is being deleted, so no further saves recreate it. */
      discarded?: boolean;
    };

type FileView = Extract<ActiveView, { kind: 'file' }>;

/**
 * A save captured at edit time. It holds the edited view (not a path), so it always targets the
 * file that was edited, and follows that file through renames/moves queued before it runs.
 */
interface PendingSave {
  serverId: string;
  view: FileView;
  content: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const NO_VIEW: ActiveView = { kind: 'none' };
const LINKS_PANEL_STORAGE_KEY = 'obsidian-view.links-panel-open';
const TAGS_SECTION_STORAGE_KEY = 'obsidian-view.tags-open';
const RECENT_FILES_STORAGE_PREFIX = 'obsidian-view.recent.';
const MAX_RECENT_FILES = 10;
/** Content search starts at this many characters. */
const MIN_CONTENT_QUERY = 2;

/** A tag on the open note. Frontmatter tags are editable; `#tags` written in the text are not. */
interface NoteTag {
  tag: string;
  editable: boolean;
}

/** Taken before a rename/move: the vault as it was, which files move, and which notes link to them. */
interface LinkSnapshot {
  index: VaultIndex;
  isFolder: boolean;
  movedFiles: string[];
  sources: string[];
}

/** The hover card shown for a link in the editor. */
interface HoverPreview {
  /** The link as written, e.g. "Strahd#Lair". */
  target: string;
  entry: VaultEntry | null;
  heading: string;
  title: string;
  folder: string;
  icon: string;
  /** Position inside the view (px); `above` cards are drawn upwards from `top`. */
  top: number;
  left: number;
  above: boolean;
  loading: boolean;
  markdown: string | null;
  imageUrl: string | null;
}

const HOVER_OPEN_DELAY = 450;
const HOVER_CLOSE_DELAY = 250;
const HOVER_CARD_WIDTH = 420;
const HOVER_CARD_HEIGHT = 340;

/** A note whose text (not name) matches the sidebar search. */
interface ContentHit {
  entry: VaultEntry;
  icon: string;
  title: string;
  folder: string;
  snippet: TextSegment[];
}

@Component({
  selector: 'app-obsidian-view',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatMenuModule,
    MilkdownEditorComponent,
    ObsidianCanvasEditorComponent,
    VaultQuickSwitcherComponent
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
  private vaultHandle: FileSystemDirectoryHandle | null = null;
  localhostRoute: string | null = null;
  vaultEntries: VaultEntry[] = [];
  treeFilter = '';
  /** Tag the tree is filtered to (lower-case, without '#'), or null. */
  activeTag: string | null = null;
  isTagsSectionOpen = readStoredFlag(TAGS_SECTION_STORAGE_KEY, true);

  activeView: ActiveView = NO_VIEW;
  /** Draft title bound to the title input; committed by renameSelectedFile(). */
  selectedFileDisplayName = '';

  permissionGranted: boolean = false;
  fileSystemApiSupported: boolean = false;
  isVaultLoading = false;
  vaultError: string | null = null;

  readonly noteTemplates = NOTE_TEMPLATES;

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
  saveState: SaveState = 'idle';
  lastSavedAt: Date | null = null;
  draggedEntryPath: string | null = null;
  activeDropTargetPath: string | null = null;

  // Context Menu Support
  contextMenuPosition = { x: '0px', y: '0px' };
  /** Tree entry the shared file/folder menu is open for. */
  menuEntry: VaultEntry | null = null;
  @ViewChild('entryMenuTrigger') private entryMenuTrigger?: MatMenuTrigger;
  /** Focuses the name field whenever a create form appears. */
  @ViewChild('createInput') private set createInput(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref) {
      setTimeout(() => ref.nativeElement.focus());
    }
  }
  /** Folders expanded in the tree (relative paths). */
  private readonly expandedFolders = new Set<string>();
  private pendingImageBroadcast: VaultImageBroadcast | null = null;

  hasActiveSelection: boolean = false;

  private vaultIndex: VaultIndex | null = null;
  private objectUrls: string[] = [];
  private contentChanged = new Subject<void>();
  private autoSaveSubscription?: Subscription;
  private pendingSave: PendingSave | null = null;
  /** Saves, renames, moves and deletes run one at a time, in order. */
  private saveChain: Promise<void> = Promise.resolve();
  /** lastModified of each file as last read/written here; used to detect edits made outside the app. */
  private readonly knownModified = new Map<string, number>();
  /** Incremented per selection so a slow load can't overwrite a newer one. */
  private selectionToken = 0;
  private pendingOpenPath: string | null = null;
  private filteredEntriesCacheQuery = '';
  private filteredEntriesCacheTag: string | null = null;
  private filteredEntriesCacheVersion = -1;
  private filteredEntriesCacheSource: VaultEntry[] | null = null;
  private tagListCache: { index: VaultIndex; version: number; value: { tag: string; count: number }[] } | null = null;
  private filteredEntriesCache: VaultEntry[] = [];
  private filteredCounts = { files: 0, folders: 0 };
  private saveStateResetTimer?: ReturnType<typeof setTimeout>;
  private sidebarResizeObserver?: ResizeObserver;

  // ---- Content search + quick switcher ----
  /** Notes whose text matches the sidebar search; only shown while `contentHitsQuery` matches the box. */
  contentHits: ContentHit[] = [];
  private contentHitsQuery = '';
  private contentSearchToken = 0;
  private readonly contentQuery$ = new Subject<string>();
  private contentQuerySubscription?: Subscription;
  isQuickSwitcherOpen = false;
  /** Recently opened files for this server, most recent first. */
  recentPaths: string[] = [];
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  /** Background indexing of note contents (needed for backlinks and tags). */
  contentIndexState: 'idle' | 'indexing' | 'ready' = 'idle';
  /** Backlinks panel preference on wide layouts (remembered per browser). */
  private linksPanelOpenWide = readStoredFlag(LINKS_PANEL_STORAGE_KEY, true);
  /** On compact layouts the panel is an overlay and starts closed. */
  private linksPanelOpenCompact = false;
  private backlinkCache: { index: VaultIndex; version: number; path: string; value: BacklinkMention[] } | null = null;
  private readonly compactSidebarWidth = 960;
  private readonly vaultEntryDragType = 'application/x-dd-vault-entry';

  constructor(
    private obsidianVaultService: ObsidianVaultService,
    private vaultIndexService: VaultIndexService,
    private broadcastService: ObsidianBroadcastService,
    private statsheetService: DndStatsheetService,
    private route: ActivatedRoute,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef,
    private hostRef: ElementRef<HTMLElement>,
    private snackBar: MatSnackBar
  ) {}

  // ---- View-state accessors (read by the template) ----

  private get fileView(): FileView | null {
    return this.activeView.kind === 'file' ? this.activeView : null;
  }

  get isEditing(): boolean {
    return this.activeView.kind === 'file';
  }

  get isViewingFolder(): boolean {
    return this.activeView.kind === 'folder';
  }

  get hasActiveView(): boolean {
    return this.activeView.kind !== 'none';
  }

  get selectedFileName(): string {
    return this.fileView?.name ?? '';
  }

  get selectedFileRelativePath(): string {
    return this.fileView?.relativePath ?? '';
  }

  get selectedFileContent(): string {
    return this.fileView?.content ?? '';
  }

  get nonMarkdownUrl(): SafeUrl | null {
    return this.fileView?.blobUrl ?? null;
  }

  get selectedViewer(): VaultFileType['viewer'] | null {
    return this.fileView?.fileType.viewer ?? null;
  }

  get isMarkdownFileSelected(): boolean {
    return this.selectedViewer === 'markdown';
  }

  get isCanvasFileSelected(): boolean {
    return this.selectedViewer === 'canvas';
  }

  get isImage(): boolean {
    return this.selectedViewer === 'image';
  }

  get isPdf(): boolean {
    return this.selectedViewer === 'pdf';
  }

  get isEditableFileSelected(): boolean {
    return !!this.fileView?.fileType.editable;
  }

  get selectedFolderName(): string {
    return this.activeView.kind === 'folder' ? this.activeView.name : '';
  }

  get selectedFolderRelativePath(): string {
    return this.activeView.kind === 'folder' ? this.activeView.relativePath : '';
  }

  get selectedFolderImages(): FolderGalleryImage[] {
    return this.activeView.kind === 'folder' ? this.activeView.images : [];
  }

  get activeNavigationPath(): string {
    return this.activeView.kind === 'none' ? '' : this.activeView.relativePath;
  }

  // ---- Tree accessors ----

  get visibleVaultEntries(): VaultEntry[] {
    if (!this.hasTreeFilter) return this.vaultEntries;
    this.refreshFilterCache();
    return this.filteredEntriesCache;
  }

  /** Recomputes the filtered tree and its counts only when the query or tree changed. */
  private refreshFilterCache(): void {
    const query = this.treeFilter.trim().toLowerCase();
    const tag = this.activeTag;
    // Tag membership changes as notes are edited, so a tag filter is also keyed on the index version.
    const version = tag ? this.vaultIndex?.contentVersion ?? -1 : -1;
    if (
      this.filteredEntriesCacheQuery === query &&
      this.filteredEntriesCacheTag === tag &&
      this.filteredEntriesCacheVersion === version &&
      this.filteredEntriesCacheSource === this.vaultEntries
    ) {
      return;
    }

    this.filteredEntriesCacheQuery = query;
    this.filteredEntriesCacheTag = tag;
    this.filteredEntriesCacheVersion = version;
    this.filteredEntriesCacheSource = this.vaultEntries;
    const taggedPaths = tag && this.vaultIndex
      ? new Set(this.vaultIndex.getNotesWithTag(tag).map(entry => entry.relativePath))
      : null;
    this.filteredEntriesCache = this.filterVaultEntries(this.vaultEntries, query, taggedPaths);
    this.filteredCounts = {
      files: this.countEntries(this.filteredEntriesCache, entry => entry.kind === 'file'),
      folders: this.countEntries(this.filteredEntriesCache, entry => entry.kind === 'directory'),
    };
  }

  get totalEntryCount(): number {
    return this.totalFileCount + this.totalFolderCount;
  }

  get totalFileCount(): number {
    return this.vaultIndex?.fileCount ?? 0;
  }

  get totalFolderCount(): number {
    return this.vaultIndex?.folderCount ?? 0;
  }

  get visibleFileCount(): number {
    if (!this.hasTreeFilter) return this.totalFileCount;
    this.refreshFilterCache();
    return this.filteredCounts.files;
  }

  get visibleFolderCount(): number {
    if (!this.hasTreeFilter) return this.totalFolderCount;
    this.refreshFilterCache();
    return this.filteredCounts.folders;
  }

  get hasTreeFilter(): boolean {
    return this.treeFilter.trim().length > 0 || this.activeTag !== null;
  }

  // ---- Tags ----

  /** Every tag in the vault with its note count, most used first. Cached per index version. */
  get vaultTags(): { tag: string; count: number }[] {
    const index = this.vaultIndex;
    if (!index) return [];

    const cached = this.tagListCache;
    if (cached && cached.index === index && cached.version === index.contentVersion) {
      return cached.value;
    }

    const value = index.getAllTags();
    this.tagListCache = { index, version: index.contentVersion, value };
    return value;
  }

  toggleTagsSection(): void {
    this.isTagsSectionOpen = !this.isTagsSectionOpen;
    writeStoredFlag(TAGS_SECTION_STORAGE_KEY, this.isTagsSectionOpen);
  }

  /** Filters the tree to notes with this tag (nested tags included); clicking the active tag clears it. */
  toggleTag(tag: string): void {
    this.activeTag = this.activeTag === tag ? null : tag;
  }

  // ---- Tags on the open note ----

  isAddingTag = false;
  newTagInput = '';
  tagInputError = '';
  private noteTagsCache: { content: string; value: NoteTag[] } | null = null;
  /** Focuses the tag input whenever it appears. */
  @ViewChild('tagInput') private set tagInputRef(ref: ElementRef<HTMLInputElement> | undefined) {
    if (ref) setTimeout(() => ref.nativeElement.focus());
  }

  /** Frontmatter tags (editable) followed by inline `#tags` from the text (read-only). */
  get noteTags(): NoteTag[] {
    const view = this.fileView;
    if (!view || view.fileType.viewer !== 'markdown') return [];
    if (this.noteTagsCache?.content === view.content) return this.noteTagsCache.value;

    const frontmatterTags = readFrontmatterTags(view.content);
    const known = new Set(frontmatterTags.map(tag => tag.toLowerCase()));
    const value: NoteTag[] = [
      ...frontmatterTags.map(tag => ({ tag, editable: true })),
      ...extractInlineTags(view.content).filter(tag => !known.has(tag)).map(tag => ({ tag, editable: false })),
    ];
    this.noteTagsCache = { content: view.content, value };
    return value;
  }

  /** Existing vault tags matching what's typed, excluding ones the note already has. */
  get tagSuggestions(): string[] {
    const query = this.newTagInput.trim().replace(/^#+/, '').toLowerCase();
    const existing = new Set(this.noteTags.map(item => item.tag.toLowerCase()));
    return this.vaultTags
      .map(item => item.tag)
      .filter(tag => !existing.has(tag) && (!query || tag.includes(query)))
      .slice(0, 6);
  }

  startAddingTag(): void {
    this.isAddingTag = true;
    this.newTagInput = '';
    this.tagInputError = '';
  }

  cancelAddingTag(): void {
    this.isAddingTag = false;
    this.newTagInput = '';
    this.tagInputError = '';
  }

  /** Adds a tag to the note's frontmatter. The input stays open so several tags can be added. */
  addNoteTag(raw: string = this.newTagInput): void {
    const view = this.fileView;
    if (!view || this.previewOnly || view.discarded || view.fileType.viewer !== 'markdown') return;

    const tag = normalizeTagInput(raw);
    if (!tag) {
      this.tagInputError = raw.trim() ? 'A tag needs at least one letter, e.g. npc' : '';
      return;
    }

    const current = readFrontmatterTags(view.content);
    if (!current.some(existing => existing.toLowerCase() === tag.toLowerCase())) {
      this.onContentChange(setFrontmatterTags(view.content, [...current, tag]));
    }
    this.newTagInput = '';
    this.tagInputError = '';
  }

  removeNoteTag(tag: string): void {
    const view = this.fileView;
    if (!view || this.previewOnly || view.discarded) return;

    const remaining = readFrontmatterTags(view.content).filter(existing => existing !== tag);
    this.onContentChange(setFrontmatterTags(view.content, remaining));
  }

  onTagInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (this.newTagInput.trim()) {
        this.addNoteTag();
      } else if (event.key === 'Enter') {
        this.cancelAddingTag();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelAddingTag();
    }
  }

  onTagInputBlur(): void {
    if (this.newTagInput.trim()) {
      this.addNoteTag();
    }
    if (!this.tagInputError) {
      this.cancelAddingTag();
    }
  }

  /** Clicking a tag on the note filters the file list to it. */
  showTagInSidebar(tag: string): void {
    this.activeTag = tag.toLowerCase();
    this.openMobileSidebar();
  }

  clearTreeFilters(): void {
    this.treeFilter = '';
    this.activeTag = null;
  }

  get isRootDropTarget(): boolean {
    return this.draggedEntryPath !== null && this.activeDropTargetPath === '';
  }

  /** Notes linking to the open file, with snippets. Cached per index version. */
  get backlinks(): BacklinkMention[] {
    const path = this.selectedFileRelativePath;
    const index = this.vaultIndex;
    if (!path || !index) return [];

    const cached = this.backlinkCache;
    if (cached && cached.index === index && cached.version === index.contentVersion && cached.path === path) {
      return cached.value;
    }

    const value = index.getBacklinkMentions(path);
    this.backlinkCache = { index, version: index.contentVersion, path, value };
    return value;
  }

  get linksPanelVisible(): boolean {
    return this.isCompactSidebarLayout ? this.linksPanelOpenCompact : this.linksPanelOpenWide;
  }

  toggleLinksPanel(): void {
    if (this.isCompactSidebarLayout) {
      this.linksPanelOpenCompact = !this.linksPanelOpenCompact;
      return;
    }

    this.linksPanelOpenWide = !this.linksPanelOpenWide;
    writeStoredFlag(LINKS_PANEL_STORAGE_KEY, this.linksPanelOpenWide);
  }

  openBacklink(entry: VaultEntry): void {
    this.linksPanelOpenCompact = false;
    if (this.previewOnly) {
      this.requestPreviewTab(entry.relativePath, entry.name);
      return;
    }
    void this.selectFile(entry);
  }

  /** Re-scans the vault and re-reads every note (picks up edits made in Obsidian). */
  async refreshVault(): Promise<void> {
    await this.loadVaultEntries(false, { reindexContent: true });
  }

  get saveStateLabel(): string {
    if (this.saveState === 'saving') return 'Saving';
    if (this.saveState === 'error') return 'Save failed';
    if (this.saveState === 'conflict') return 'Changed on disk';
    return 'Saved';
  }

  // ---- Lifecycle ----

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

    this.autoSaveSubscription = this.contentChanged.pipe(
      debounceTime(1000) // Auto-save after 1 second of inactivity
    ).subscribe(() => {
      void this.flushPendingSave();
    });

    this.contentQuerySubscription = this.contentQuery$
      .pipe(debounceTime(250), distinctUntilChanged())
      .subscribe(query => void this.runContentSearch(query));

    document.addEventListener('selectionchange', this.handleSelectionChange);
  }

  ngAfterViewInit(): void {
    this.syncResponsiveSidebarState(true);
    // Scrolling anywhere in the view (except inside the card) moves the link away from the card.
    this.hostRef.nativeElement.addEventListener('scroll', this.onViewScroll, true);

    if (typeof ResizeObserver !== 'undefined') {
      this.sidebarResizeObserver = new ResizeObserver(() => {
        this.syncResponsiveSidebarState(true);
      });
      this.sidebarResizeObserver.observe(this.hostRef.nativeElement);
    }
  }

  /** Ctrl/Cmd+O: quick switcher. Ctrl/Cmd+Shift+F: focus the sidebar search. */
  @HostListener('document:keydown', ['$event'])
  onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.hoverPreview) {
      this.closeHoverPreview();
      return;
    }

    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey || !this.acceptsShortcuts()) return;

    const key = event.key.toLowerCase();
    if (key === 'o' && !event.shiftKey) {
      event.preventDefault();
      this.openQuickSwitcher();
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault();
      this.focusSearch();
    }
  }

  /** Only the visible, editable vault view reacts (tabs keep hidden instances alive). */
  private acceptsShortcuts(): boolean {
    return !this.previewOnly && this.permissionGranted && this.hostRef.nativeElement.getClientRects().length > 0;
  }

  openQuickSwitcher(): void {
    if (!this.permissionGranted || this.previewOnly) return;
    this.isQuickSwitcherOpen = true;
  }

  closeQuickSwitcher(): void {
    this.isQuickSwitcherOpen = false;
  }

  pickFromQuickSwitcher(entry: VaultEntry): void {
    this.isQuickSwitcherOpen = false;
    void this.selectFile(entry);
  }

  get quickSwitcherFiles(): VaultEntry[] {
    return this.vaultIndex?.files ?? [];
  }

  focusSearch(): void {
    this.openMobileSidebar();
    setTimeout(() => {
      this.searchInput?.nativeElement.focus();
      this.searchInput?.nativeElement.select();
    });
  }

  // ---- Content search ----

  onTreeFilterInput(): void {
    this.contentQuery$.next(this.treeFilter.trim());
  }

  /** True while content results for the current query are still loading. */
  get isContentSearchPending(): boolean {
    const query = this.treeFilter.trim();
    return query.length >= MIN_CONTENT_QUERY && this.contentHitsQuery !== query;
  }

  /** Content hits for exactly what's in the search box (never stale results). */
  get visibleContentHits(): ContentHit[] {
    const query = this.treeFilter.trim();
    if (query.length < MIN_CONTENT_QUERY || this.contentHitsQuery !== query) return [];

    if (!this.activeTag || !this.vaultIndex) return this.contentHits;
    const tagged = new Set(this.vaultIndex.getNotesWithTag(this.activeTag).map(entry => entry.relativePath));
    return this.contentHits.filter(hit => tagged.has(hit.entry.relativePath));
  }

  get showsContentSection(): boolean {
    return this.treeFilter.trim().length >= MIN_CONTENT_QUERY;
  }

  private async runContentSearch(query: string): Promise<void> {
    const token = ++this.contentSearchToken;
    if (query.length < MIN_CONTENT_QUERY || !this.serverId || !this.permissionGranted) {
      this.contentHits = [];
      this.contentHitsQuery = query;
      return;
    }

    try {
      const results = await this.obsidianVaultService.searchVault(this.serverId, query, 60);
      if (token !== this.contentSearchToken) return;

      // Name/path matches are already in the tree above; list notes that match only by content.
      this.contentHits = results
        .filter(result => result.matchType === 'content')
        .map(result => {
          const entry = this.vaultIndex?.getByPath(result.relativePath);
          if (!entry) return null;

          const title = getVaultDisplayName(entry.name);
          // Snippets often start with the note's own "# Title" heading; drop that repetition.
          const snippet = result.snippet.startsWith(`${title} `) ? result.snippet.slice(title.length + 1) : result.snippet;
          return {
            entry,
            icon: getVaultFileType(entry.name).icon,
            title,
            folder: entry.parentPath,
            snippet: highlightTerms(snippet, query),
          };
        })
        .filter((hit): hit is ContentHit => !!hit)
        .slice(0, 30);
    } catch (err) {
      console.warn('Content search failed:', err);
      if (token !== this.contentSearchToken) return;
      this.contentHits = [];
    }
    this.contentHitsQuery = query;
  }

  openContentHit(hit: ContentHit): void {
    void this.selectFile(hit.entry);
  }

  // ---- Recent files ----

  private loadRecentPaths(): void {
    try {
      const raw = localStorage.getItem(`${RECENT_FILES_STORAGE_PREFIX}${this.serverId}`);
      const parsed = raw ? JSON.parse(raw) : [];
      this.recentPaths = Array.isArray(parsed) ? parsed.filter((p: unknown) => typeof p === 'string') : [];
    } catch {
      this.recentPaths = [];
    }
  }

  private rememberRecent(path: string): void {
    this.recentPaths = [path, ...this.recentPaths.filter(p => p !== path)].slice(0, MAX_RECENT_FILES);
    this.saveRecentPaths();
  }

  private saveRecentPaths(): void {
    try {
      localStorage.setItem(`${RECENT_FILES_STORAGE_PREFIX}${this.serverId}`, JSON.stringify(this.recentPaths));
    } catch {
      // storage unavailable: recents just won't persist
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.syncResponsiveSidebarState(true);
  }

  onSearchKeydown(event: KeyboardEvent): void {
    // Esc clears the typed text first, then the tag filter.
    if (event.key === 'Escape' && (this.treeFilter || this.activeTag)) {
      event.stopPropagation();
      if (this.treeFilter) {
        this.treeFilter = '';
      } else {
        this.activeTag = null;
      }
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['openPath'] || changes['openRequestId']) && this.openPath) {
      void this.openRequestedPath(this.openPath);
    }
  }

  ngOnDestroy(): void {
    // Don't lose the last second of typing when the view closes. The vault service is a
    // root singleton, so the write completes after this component is gone.
    void this.flushPendingSave();
    this.revokeObjectUrls();
    this.autoSaveSubscription?.unsubscribe();
    this.contentQuerySubscription?.unsubscribe();
    if (this.saveStateResetTimer) {
      clearTimeout(this.saveStateResetTimer);
    }
    this.sidebarResizeObserver?.disconnect();
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    this.hostRef.nativeElement.removeEventListener('scroll', this.onViewScroll, true);
    this.closeHoverPreview();
  }

  private handleSelectionChange = () => {
    const hasSelection = !!this.getEditorSelection();

    if (this.hasActiveSelection !== hasSelection) {
      this.hasActiveSelection = hasSelection;
      this.cdr.detectChanges();
    }
  };

  /** The current DOM selection if it is non-empty and inside the markdown editor. */
  private getEditorSelection(): Selection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    let node: Node | null = selection.getRangeAt(0).commonAncestorContainer;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('milkdown-container')) {
        return selection;
      }
      node = node.parentNode;
    }
    return null;
  }

  // ---- Vault access ----

  async loadVaultInfo(): Promise<void> {
    if (this.serverId) {
      try {
        this.vaultError = null;
        this.localhostRoute = this.obsidianVaultService.getVaultLocalhostRoute(this.serverId);
        this.loadRecentPaths();

        const handle = await this.obsidianVaultService.getVaultHandle(this.serverId);
        this.vaultHandle = handle;
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

  async attachVault(startIn?: FileSystemHandle): Promise<void> {
    if (!this.fileSystemApiSupported) return;

    if (this.serverId) {
      try {
        this.vaultError = null;
        this.vaultName = await this.obsidianVaultService.attachVaultToServer(this.serverId, startIn);
        this.vaultHandle = await this.obsidianVaultService.getVaultHandle(this.serverId);
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
    // Use the handle cached by loadVaultInfo so requestPermission() runs synchronously
    // inside the click (it needs transient user activation; awaiting IndexedDB first can lose it).
    const handle = this.vaultHandle ?? await this.obsidianVaultService.getVaultHandle(this.serverId);
    if (!handle) {
      this.vaultError = 'Saved vault folder not found. Please re-select it.';
      return;
    }

    // WebView2 (Tauri desktop) has no UI for re-permission prompts on stored handles:
    // handle.requestPermission() never settles. Re-open the picker at the saved vault instead.
    if ((window as any).__TAURI_INTERNALS__) {
      await this.attachVault(handle);
      return;
    }

    try {
      this.vaultError = null;
      this.permissionGranted = await this.obsidianVaultService.requestPermission(handle);
      if (this.permissionGranted) {
        await this.loadVaultEntries(false);
      } else {
        this.vaultError = 'Access was not granted. Re-select the vault folder to continue.';
      }
    } catch (err) {
      this.vaultError = 'Unable to request vault access. Re-select the vault folder to continue.';
      console.error('Failed to request vault permission:', err);
    }
  }

  async loadVaultEntries(useCache = false, options: { reindexContent?: boolean } = {}): Promise<void> {
    if (!this.serverId || !this.permissionGranted) return;

    this.isVaultLoading = true;
    this.vaultError = null;
    try {
      this.vaultIndex = await this.vaultIndexService.load(this.serverId, useCache);
      this.vaultEntries = this.vaultIndex.entries;
      void this.indexVaultContent(!!options.reindexContent);
      await this.openPendingPath();
      await this.refreshSelectedFolder();
    } catch (err) {
      this.vaultError = 'Unable to load vault files.';
      console.error('Failed to load vault entries:', err);
    } finally {
      this.isVaultLoading = false;
    }
  }

  /** Reads note contents in the background so backlinks and tags cover the whole vault. */
  private async indexVaultContent(force: boolean): Promise<void> {
    const serverId = this.serverId;
    if (!serverId) return;

    this.contentIndexState = 'indexing';
    try {
      await this.vaultIndexService.ensureContentIndexed(serverId, { force });
    } catch (err) {
      console.warn('Failed to index vault content:', err);
    } finally {
      if (this.serverId === serverId) {
        this.contentIndexState = 'ready';
      }
    }
  }

  // ---- Selection ----

  async selectFile(entry: VaultEntry): Promise<void> {
    if (entry.kind === 'directory') return;

    const token = ++this.selectionToken;
    await this.flushPendingSave();

    const fileType = getVaultFileType(entry.name);
    let content = '';
    let blobUrl: SafeUrl | null = null;
    let objectUrl: string | null = null;

    try {
      if (fileType.readAs === 'text') {
        const file = await this.obsidianVaultService.readFileWithMeta(this.serverId, entry.relativePath);
        content = file.content;
        this.knownModified.set(entry.relativePath, file.lastModified);
        this.vaultIndexService.indexNoteContent(this.serverId, entry.relativePath, content);
      } else {
        const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, entry.relativePath);
        objectUrl = URL.createObjectURL(blob);
        blobUrl = this.sanitizer.bypassSecurityTrustResourceUrl(objectUrl);
      }
    } catch (err) {
      console.error('Failed to open file:', entry.relativePath, err);
      if (token === this.selectionToken) {
        this.vaultError = `Unable to open ${entry.name}.`;
      }
      return;
    }

    this.closeHoverPreview();

    // A newer selection started while this file was loading; drop this one.
    if (token !== this.selectionToken) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return;
    }

    this.revokeObjectUrls();
    if (objectUrl) this.objectUrls.push(objectUrl);

    this.activeView = {
      kind: 'file',
      name: entry.name,
      relativePath: entry.relativePath,
      fileType,
      content,
      blobUrl,
    };
    this.selectedFileDisplayName = getVaultDisplayName(entry.name);
    this.vaultError = null;
    this.saveState = 'idle';
    this.lastSavedAt = null;
    this.expandAncestors(entry.relativePath);
    if (!this.previewOnly) {
      this.rememberRecent(entry.relativePath);
    }

    this.closeMobileSidebar();
  }

  async selectFolder(entry: VaultEntry): Promise<void> {
    if (entry.kind !== 'directory') return;

    const token = ++this.selectionToken;
    await this.flushPendingSave();

    const sourceEntry = this.vaultIndex?.getByPath(entry.relativePath) || entry;
    const objectUrls: string[] = [];

    const images = await Promise.all(this.collectFolderImages(sourceEntry).map(async imageEntry => {
      try {
        const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, imageEntry.relativePath);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return { name: imageEntry.name, relativePath: imageEntry.relativePath, url };
      } catch (error) {
        console.warn('[ObsidianView] Failed to load gallery image', imageEntry.relativePath, error);
        return null;
      }
    }));

    if (token !== this.selectionToken) {
      objectUrls.forEach(url => URL.revokeObjectURL(url));
      return;
    }

    this.revokeObjectUrls();
    this.objectUrls.push(...objectUrls);
    this.activeView = {
      kind: 'folder',
      name: sourceEntry.name,
      relativePath: sourceEntry.relativePath,
      images: images.filter((image): image is FolderGalleryImage => !!image),
    };
    this.selectedFileDisplayName = '';
    this.expandAncestors(sourceEntry.relativePath);
    this.expandedFolders.add(sourceEntry.relativePath);
    this.closeMobileSidebar();
  }

  cancelEdit(): void {
    void this.closeView();
  }

  cancelFolderView(): void {
    void this.closeView();
  }

  closeActiveView(): void {
    void this.closeView();
  }

  private async closeView(): Promise<void> {
    this.selectionToken++;
    await this.flushPendingSave();
    this.activeView = NO_VIEW;
    this.selectedFileDisplayName = '';
    this.saveState = 'idle';
    this.lastSavedAt = null;
    this.revokeObjectUrls();
  }

  // ---- Autosave ----

  onContentChange(newContent?: string): void {
    const view = this.fileView;
    if (this.previewOnly || !view || !view.fileType.editable || view.discarded) return;

    if (newContent !== undefined) {
      view.content = newContent;
    }
    this.vaultIndexService.indexNoteContent(this.serverId, view.relativePath, view.content);

    this.pendingSave = { serverId: this.serverId, view, content: view.content };
    if (this.saveState !== 'conflict') {
      this.saveState = 'saving';
    }
    this.contentChanged.next();
  }

  /** Writes any edit not yet saved, and resolves once every queued save has finished. */
  flushPendingSave(): Promise<void> {
    const save = this.pendingSave;
    if (save) {
      this.pendingSave = null;
      return this.queueVaultOp(() => this.performSave(save));
    }
    return this.saveChain;
  }

  /** Runs a vault write after every previously queued one. Errors reach the caller, not the queue. */
  private queueVaultOp<T>(op: () => Promise<T>): Promise<T> {
    const result = this.saveChain.then(op);
    this.saveChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Kept for template/back-compat: saves the open file now. */
  async saveFile(): Promise<void> {
    await this.flushPendingSave();
  }

  private async performSave(save: PendingSave, overwrite = false): Promise<void> {
    if (save.view.discarded) return;

    // Resolved now, not at edit time, so a rename/move queued earlier is respected.
    const path = save.view.relativePath;
    const isCurrent = () => this.activeView === save.view;

    try {
      if (isCurrent()) this.saveState = 'saving';
      const lastModified = await this.obsidianVaultService.writeFile(save.serverId, path, save.content, {
        expectedLastModified: overwrite ? undefined : this.knownModified.get(path),
      });
      this.knownModified.set(path, lastModified);

      if (isCurrent()) {
        this.lastSavedAt = new Date();
        this.saveState = 'saved';
        this.scheduleSaveStateReset();
      }
    } catch (err) {
      if (err instanceof VaultConflictError) {
        console.warn('Not saving: file was changed outside the app.', path);
        if (isCurrent()) {
          this.saveState = 'conflict';
        }
        return;
      }

      console.error('Failed to auto-save file:', err);
      if (isCurrent()) {
        this.saveState = 'error';
      }
    }
  }

  /** Conflict resolution: keep the version in the editor and overwrite the file on disk. */
  async overwriteDiskVersion(): Promise<void> {
    const view = this.fileView;
    if (!view || this.previewOnly) return;

    this.pendingSave = null;
    const save: PendingSave = { serverId: this.serverId, view, content: view.content };
    await this.queueVaultOp(() => this.performSave(save, true));
  }

  /** Conflict resolution: discard unsaved edits and load the version on disk. */
  async reloadFromDisk(): Promise<void> {
    const view = this.fileView;
    if (!view) return;

    this.pendingSave = null;
    await this.saveChain;
    const entry = this.vaultIndex?.getByPath(view.relativePath);
    if (entry) {
      await this.selectFile(entry);
    }
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

  // ---- Create / rename / move / delete ----

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

  async createNewFile(): Promise<void> {
    const fullFileName = this.buildNewFilePath(this.newFileName);
    const attemptedKind = this.newFileKind;
    if (!fullFileName) {
      this.createFileError = attemptedKind === 'canvas' ? 'Enter a canvas name.' : 'Enter a note name.';
      return;
    }

    if (this.vaultIndex?.getByPath(fullFileName)) {
      this.createFileError = 'A file with that name already exists.';
      return;
    }

    try {
      const initialContent = await this.loadInitialContent(fullFileName);
      await this.obsidianVaultService.writeFile(this.serverId, fullFileName, initialContent);
      this.cancelNewFile();
      await this.loadVaultEntries(false);

      const newEntry = this.vaultIndex?.getByPath(fullFileName);
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

      const newEntry = this.vaultIndex?.getByPath(folderPath);
      if (newEntry?.kind === 'directory') {
        await this.selectFolder(newEntry);
      }
    } catch (err) {
      this.createFolderError = 'Unable to create folder.';
      console.error('Failed to create folder:', err);
    }
  }

  private async loadInitialContent(filePath: string): Promise<string> {
    if (getVaultFileType(filePath).id === 'canvas') {
      return this.obsidianVaultService.getObsidianCanvasTemplate();
    }

    const template = this.selectedTemplateFileName ? findNoteTemplate(this.selectedTemplateFileName) : undefined;
    return template ? loadNoteTemplate(template, filePath) : '';
  }

  private buildNewFilePath(fileName: string): string | null {
    const normalized = fileName.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return null;

    const filePart = normalized.split('/').pop() || normalized;
    const typeId = this.newFileKind === 'canvas' ? 'canvas' : 'markdown';
    const defaultExtension = getVaultFileTypeById(typeId)?.defaultExtension ?? 'md';
    return filePart.includes('.') ? normalized : `${normalized}.${defaultExtension}`;
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
    const view = this.fileView;
    if (this.previewOnly || !view) return;

    const currentDisplayName = getVaultDisplayName(view.name);
    const newDisplayName = this.selectedFileDisplayName.trim();

    if (!newDisplayName || newDisplayName === currentDisplayName) {
      this.selectedFileDisplayName = currentDisplayName;
      return;
    }

    const extension = view.name.includes('.') ? view.name.split('.').pop() : 'md';
    const fullNewName = newDisplayName.endsWith(`.${extension}`) ? newDisplayName : `${newDisplayName}.${extension}`;

    try {
      // Queued edits are written to the old path first; later ones follow the view to the new path.
      await this.flushPendingSave();
      const oldPath = view.relativePath;
      const snapshot = await this.captureLinkSources(oldPath);
      let newPath = oldPath;
      await this.queueVaultOp(async () => {
        newPath = await this.obsidianVaultService.renameFile(this.serverId, view.relativePath, fullNewName);
        this.moveKnownModified(oldPath, newPath);
        this.retargetOpenPath(oldPath, newPath);
        view.name = fullNewName;
      });
      if (this.activeView === view) {
        this.selectedFileDisplayName = getVaultDisplayName(fullNewName);
      }
      await this.loadVaultEntries(false);
      if (snapshot) {
        await this.updateLinksAfterMove(snapshot, oldPath, newPath);
      }
    } catch (err) {
      console.error('Failed to rename file:', err);
      this.selectedFileDisplayName = currentDisplayName;
    }
  }

  // ---- Keeping links working after rename/move ----

  /** Records which notes link to `path` (or to anything inside it, for folders) before it moves. */
  private async captureLinkSources(path: string): Promise<LinkSnapshot | null> {
    const index = this.vaultIndex;
    const entry = index?.getByPath(path);
    if (!index || !entry) return null;

    try {
      // Backlinks need every note's links; this is instant once the background indexing has run.
      await this.vaultIndexService.ensureContentIndexed(this.serverId);
    } catch (err) {
      console.warn('Could not index notes before moving; links may not be updated.', err);
    }

    const movedFiles = entry.kind === 'directory'
      ? index.files.filter(file => file.relativePath.startsWith(`${entry.relativePath}/`)).map(file => file.relativePath)
      : [entry.relativePath];
    const sources = new Set<string>();
    for (const file of movedFiles) {
      index.getBacklinks(file).forEach(source => sources.add(source.relativePath));
    }
    return { index, isFolder: entry.kind === 'directory', movedFiles, sources: Array.from(sources) };
  }

  /**
   * After a rename/move, rewrites links in other notes so they still point to the moved file(s).
   * Asks first, like Obsidian, and reports how many links changed.
   */
  private async updateLinksAfterMove(snapshot: LinkSnapshot, oldPath: string, newPath: string): Promise<void> {
    const newIndex = this.vaultIndex;
    if (!snapshot.sources.length || !newIndex || oldPath === newPath) return;

    const mapPath = (path: string) =>
      path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
    const moved = new Map(snapshot.movedFiles.map(path => [path.toLowerCase(), mapPath(path)]));
    const wikilinkTextFor = (path: string, original: string) => {
      const isMarkdown = /\.md$/i.test(path);
      const keepExtension = isMarkdown && /\.md$/i.test(original);
      const strip = (value: string) => (isMarkdown && !keepExtension ? value.slice(0, -3) : value);
      if (original.includes('/')) return strip(path);
      const entry = newIndex.getByPath(path);
      const text = entry ? newIndex.linkTextFor(entry) : strip(path.split('/').pop()!);
      return keepExtension && entry ? `${text}.md` : text;
    };

    const plans: { path: string; content: string; count: number; isOpen: boolean }[] = [];
    for (const source of snapshot.sources) {
      const path = mapPath(source);
      const openView = this.fileView?.relativePath === path ? this.fileView : null;
      let content: string;
      try {
        content = openView ? openView.content : await this.obsidianVaultService.readFile(this.serverId, path);
      } catch {
        continue;
      }
      const result = rewriteMovedLinks(content, {
        notePath: source,
        newNotePath: path,
        resolve: (target, from) => snapshot.index.resolveLink(target, from)?.relativePath ?? null,
        moved,
        wikilinkTextFor,
      });
      if (result.count > 0) {
        plans.push({ path, content: result.content, count: result.count, isOpen: !!openView });
      }
    }
    if (!plans.length) return;

    const total = plans.reduce((sum, plan) => sum + plan.count, 0);
    const name = getVaultDisplayName(newPath.split('/').pop() || newPath);
    const target = snapshot.isFolder ? `files in “${name}”` : `“${name}”`;
    const question =
      `Update ${this.pluralize(total, 'link')} in ${this.pluralize(plans.length, 'note')} to point to ${target}?\n\n` +
      `If you skip this, those links will stop working.`;
    if (!confirm(question)) return;

    let updated = 0;
    let failed = 0;
    for (const plan of plans) {
      if (plan.isOpen && this.fileView?.relativePath === plan.path) {
        this.onContentChange(plan.content);
        updated += plan.count;
        continue;
      }
      try {
        await this.queueVaultOp(async () => {
          const lastModified = await this.obsidianVaultService.writeFile(this.serverId, plan.path, plan.content, {
            expectedLastModified: this.knownModified.get(plan.path),
          });
          if (this.knownModified.has(plan.path)) this.knownModified.set(plan.path, lastModified);
        });
        this.vaultIndexService.indexNoteContent(this.serverId, plan.path, plan.content);
        updated += plan.count;
      } catch (err) {
        failed++;
        console.error('Failed to update links in', plan.path, err);
      }
    }

    const message = failed
      ? `Updated ${this.pluralize(updated, 'link')}; ${this.pluralize(failed, 'note')} couldn't be changed.`
      : `Updated ${this.pluralize(updated, 'link')} in ${this.pluralize(plans.length, 'note')}.`;
    this.snackBar.open(message, 'OK', { duration: 4000 });
  }

  async deleteEntry(entry: VaultEntry, event?: Event): Promise<void> {
    if (event) event.stopPropagation();

    if (!confirm(`Are you sure you want to delete ${entry.name}?`)) return;

    const isAffected = (path: string) => path === entry.relativePath || path.startsWith(`${entry.relativePath}/`);

    // Unsaved edits to anything being deleted are dropped: saving them would recreate the file.
    const openFile = this.fileView;
    const discardsOpenFile = !!openFile && isAffected(openFile.relativePath);
    if (this.pendingSave && isAffected(this.pendingSave.view.relativePath)) {
      this.pendingSave = null;
    }
    if (openFile && discardsOpenFile) {
      openFile.discarded = true;
    }

    try {
      await this.flushPendingSave();
      await this.queueVaultOp(() => this.obsidianVaultService.deleteEntry(this.serverId, entry.relativePath));
      if (this.activeView.kind !== 'none' && isAffected(this.activeView.relativePath)) {
        await this.closeView();
      }
      await this.loadVaultEntries(false);
    } catch (err) {
      if (openFile && discardsOpenFile) {
        openFile.discarded = false;
      }
      console.error('Failed to delete entry:', err);
    }
  }

  // ---- Drag and drop ----

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
      await this.flushPendingSave();
      const snapshot = await this.captureLinkSources(sourcePath);
      let newPath = sourcePath;
      await this.queueVaultOp(async () => {
        newPath = await this.obsidianVaultService.moveEntry(this.serverId, sourcePath, targetDirPath);
        this.moveKnownModified(sourcePath, newPath);
        this.retargetOpenPath(sourcePath, newPath);
      });
      await this.loadVaultEntries(false);
      if (snapshot) {
        await this.updateLinksAfterMove(snapshot, sourcePath, newPath);
      }
    } catch (err) {
      this.vaultError = err instanceof Error ? err.message : 'Unable to move entry.';
      console.error('Failed to move entry:', err);
    } finally {
      this.clearDragState();
    }
  }

  private canDropOnTarget(sourcePath: string, targetDirPath: string): boolean {
    const sourceEntry = this.vaultIndex?.getByPath(sourcePath);
    if (!sourceEntry) return false;
    if (sourceEntry.parentPath === targetDirPath) return false;
    if (sourcePath === targetDirPath) return false;

    return sourceEntry.kind !== 'directory' || !targetDirPath.startsWith(`${sourcePath}/`);
  }

  private clearDragState(): void {
    this.draggedEntryPath = null;
    this.activeDropTargetPath = null;
  }

  /** After a rename/move, point the open file or folder at its new path (also for moved parent folders). */
  private retargetOpenPath(oldPath: string, newPath: string): void {
    const movePath = (path: string) =>
      path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
    if (this.recentPaths.some(path => movePath(path) !== path)) {
      this.recentPaths = this.recentPaths.map(movePath);
      this.saveRecentPaths();
    }

    const view = this.activeView;
    if (view.kind === 'none') return;

    if (view.relativePath === oldPath) {
      view.relativePath = newPath;
    } else if (view.relativePath.startsWith(`${oldPath}/`)) {
      view.relativePath = `${newPath}${view.relativePath.slice(oldPath.length)}`;
    }
  }

  private moveKnownModified(oldPath: string, newPath: string): void {
    for (const [path, modified] of Array.from(this.knownModified)) {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        this.knownModified.delete(path);
        this.knownModified.set(`${newPath}${path.slice(oldPath.length)}`, modified);
      }
    }
  }

  // ---- Sidebar layout ----

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

  // ---- Template helpers ----

  getDisplayName(name: string): string {
    return getVaultDisplayName(name);
  }

  getFileIcon(name: string): string {
    return getVaultFileType(name).icon;
  }

  getFileTypeLabel(name: string): string {
    return getVaultFileTypeLabel(name);
  }

  pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  /** Type badge shown in the tree. Notes get none, since they are the default. */
  getTreeBadge(name: string): string {
    return getVaultFileType(name).id === 'markdown' ? '' : getVaultFileTypeLabel(name);
  }

  /** Parent folders of the open file or folder, for the header breadcrumb. */
  get activeBreadcrumbs(): { name: string; path: string }[] {
    const folders = this.activeNavigationPath.split('/').filter(Boolean).slice(0, -1);
    return folders.map((name, index) => ({ name, path: folders.slice(0, index + 1).join('/') }));
  }

  isFolderExpanded(entry: VaultEntry): boolean {
    return this.hasTreeFilter || this.expandedFolders.has(entry.relativePath);
  }

  toggleFolder(entry: VaultEntry, event?: Event): void {
    event?.stopPropagation();
    if (entry.kind !== 'directory' || this.hasTreeFilter) return;

    if (this.expandedFolders.has(entry.relativePath)) {
      this.expandedFolders.delete(entry.relativePath);
    } else {
      this.expandedFolders.add(entry.relativePath);
    }
  }

  collapseAllFolders(): void {
    this.expandedFolders.clear();
  }

  /** Expands the tree down to a folder and shows the sidebar (used by breadcrumbs). */
  revealFolder(path: string): void {
    this.expandAncestors(path);
    this.expandedFolders.add(path);
    this.openMobileSidebar();
  }

  private expandAncestors(path: string): void {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      this.expandedFolders.add(parts.slice(0, i).join('/'));
    }
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

  trackEntry(index: number, entry: VaultEntry): string {
    return `${entry.kind}:${entry.relativePath || entry.name}:${index}`;
  }

  // ---- Tree / folder actions ----

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

  async selectContainingFolder(entry: VaultEntry, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!entry.parentPath) return;

    const folder = this.vaultIndex?.getByPath(entry.parentPath);
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

  insertStatsheetTemplate(): void {
    const view = this.fileView;
    if (this.previewOnly || !view || view.fileType.viewer !== 'markdown') return;

    const content = view.content.trimEnd();
    const statsheet = this.statsheetService.getDndStatsheetTemplate();
    this.onContentChange(`${content}${content ? '\n\n' : ''}${statsheet}\n`);
  }

  /**
   * Filters the tree by name/path text and, optionally, to a set of tagged file paths.
   * Without a tag filter, a folder whose name matches keeps all its contents; with one,
   * only tagged files are shown (inside the folders that contain them).
   */
  private filterVaultEntries(entries: VaultEntry[], query: string, taggedPaths: Set<string> | null): VaultEntry[] {
    const matchesQuery = (entry: VaultEntry) =>
      !query ||
      entry.name.toLowerCase().includes(query) ||
      entry.relativePath.toLowerCase().includes(query);

    return entries.reduce<VaultEntry[]>((matches, entry) => {
      if (entry.kind === 'directory') {
        if (query && !taggedPaths && matchesQuery(entry)) {
          matches.push(entry);
          return matches;
        }
        const childMatches = this.filterVaultEntries(entry.children ?? [], query, taggedPaths);
        if (childMatches.length > 0) {
          matches.push({ ...entry, children: childMatches });
        }
        return matches;
      }

      if ((!taggedPaths || taggedPaths.has(entry.relativePath)) && matchesQuery(entry)) {
        matches.push(entry);
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
        return getVaultFileType(child.name).viewer === 'image' ? [child] : [];
      }

      return this.collectFolderImages(child);
    });
  }

  private async refreshSelectedFolder(): Promise<void> {
    if (this.activeView.kind !== 'folder') return;

    const entry = this.vaultIndex?.getByPath(this.activeView.relativePath);
    if (entry && entry.kind === 'directory') {
      await this.selectFolder(entry);
    } else {
      await this.closeView();
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
    if (!this.pendingOpenPath || !this.vaultIndex) {
      return;
    }

    const entry = this.vaultIndex.getByPath(this.pendingOpenPath);
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

  // ---- Link hover preview ----

  hoverPreview: HoverPreview | null = null;
  private hoverOpenTimer?: ReturnType<typeof setTimeout>;
  private hoverCloseTimer?: ReturnType<typeof setTimeout>;
  private hoverToken = 0;
  private hoverImageUrl: string | null = null;

  /** From the editor: the pointer entered a link (after a short delay, show its card) or left it. */
  onEditorLinkHover(event: { target: string; rect: DOMRect } | null): void {
    if (!event) {
      this.scheduleHoverClose();
      return;
    }

    clearTimeout(this.hoverCloseTimer);
    clearTimeout(this.hoverOpenTimer);
    if (this.hoverPreview?.target === event.target) return;
    this.hoverOpenTimer = setTimeout(() => void this.openHoverPreview(event.target, event.rect), HOVER_OPEN_DELAY);
  }

  onHoverCardEnter(): void {
    clearTimeout(this.hoverCloseTimer);
  }

  onHoverCardLeave(): void {
    this.scheduleHoverClose();
  }

  private scheduleHoverClose(): void {
    clearTimeout(this.hoverOpenTimer);
    clearTimeout(this.hoverCloseTimer);
    this.hoverCloseTimer = setTimeout(() => this.closeHoverPreview(), HOVER_CLOSE_DELAY);
  }

  closeHoverPreview(): void {
    clearTimeout(this.hoverOpenTimer);
    clearTimeout(this.hoverCloseTimer);
    this.hoverToken++;
    this.hoverPreview = null;
    if (this.hoverImageUrl) {
      URL.revokeObjectURL(this.hoverImageUrl);
      this.hoverImageUrl = null;
    }
  }

  private onViewScroll = (event: Event) => {
    if (!this.hoverPreview) return;
    const card = this.hostRef.nativeElement.querySelector('.hover-preview');
    if (card && event.target instanceof Node && card.contains(event.target)) return;
    this.closeHoverPreview();
  };

  private async openHoverPreview(target: string, rect: DOMRect): Promise<void> {
    this.closeHoverPreview();
    const token = this.hoverToken;

    const entry = this.vaultIndex?.resolveLink(target, this.selectedFileRelativePath) ?? null;
    const cleanTarget = target.split('|')[0];
    const heading = cleanTarget.includes('#') ? cleanTarget.slice(cleanTarget.indexOf('#') + 1).trim() : '';
    const fileType = entry ? getVaultFileType(entry.name) : null;

    // Place the card under the link, or above it when there isn't room below.
    const host = this.hostRef.nativeElement.getBoundingClientRect();
    const roomBelow = window.innerHeight - rect.bottom;
    const above = roomBelow < HOVER_CARD_HEIGHT + 16 && rect.top - host.top > roomBelow;
    const width = Math.min(HOVER_CARD_WIDTH, host.width - 16);

    this.hoverPreview = {
      target,
      entry,
      heading,
      title: entry ? getVaultDisplayName(entry.name) : cleanTarget.split('#')[0].trim(),
      folder: entry?.parentPath ?? '',
      icon: fileType?.icon ?? 'link_off',
      top: above ? rect.top - host.top - 6 : rect.bottom - host.top + 6,
      left: Math.max(8, Math.min(rect.left - host.left, host.width - width - 8)),
      above,
      loading: !!entry && entry.kind === 'file' && (fileType?.viewer === 'markdown' || fileType?.viewer === 'image'),
      markdown: null,
      imageUrl: null,
    };
    if (!this.hoverPreview.loading || !entry) return;

    try {
      if (fileType?.viewer === 'markdown') {
        const markdown = await this.obsidianVaultService.readFile(this.serverId, entry.relativePath);
        if (token !== this.hoverToken || !this.hoverPreview) return;
        this.hoverPreview = { ...this.hoverPreview, loading: false, markdown };
        if (heading) {
          this.scrollHoverCardToHeading(heading, token);
        }
      } else {
        const blob = await this.obsidianVaultService.readFileAsBlob(this.serverId, entry.relativePath);
        if (token !== this.hoverToken || !this.hoverPreview) return;
        this.hoverImageUrl = URL.createObjectURL(blob);
        this.hoverPreview = { ...this.hoverPreview, loading: false, imageUrl: this.hoverImageUrl };
      }
    } catch (err) {
      console.warn('Hover preview failed:', err);
      if (token === this.hoverToken && this.hoverPreview) {
        this.hoverPreview = { ...this.hoverPreview, loading: false };
      }
    }
  }

  /** For `[[Note#Heading]]`, scrolls the card to that heading once the preview has rendered. */
  private scrollHoverCardToHeading(heading: string, token: number, attempt = 0): void {
    setTimeout(() => {
      if (token !== this.hoverToken) return;
      const wanted = heading.toLowerCase();
      const match = Array.from(this.hostRef.nativeElement.querySelectorAll<HTMLElement>('.hover-preview-body h1, .hover-preview-body h2, .hover-preview-body h3, .hover-preview-body h4, .hover-preview-body h5, .hover-preview-body h6'))
        .find(element => element.textContent?.trim().toLowerCase() === wanted);
      if (match) {
        match.scrollIntoView({ block: 'start' });
      } else if (attempt < 10) {
        this.scrollHoverCardToHeading(heading, token, attempt + 1);
      }
    }, 100);
  }

  openHoverTarget(): void {
    const entry = this.hoverPreview?.entry;
    this.closeHoverPreview();
    if (!entry) return;

    if (this.previewOnly) {
      if (entry.kind === 'file') this.requestPreviewTab(entry.relativePath, entry.name);
    } else if (entry.kind === 'directory') {
      void this.selectFolder(entry);
    } else {
      void this.selectFile(entry);
    }
  }

  /** A link clicked inside the hover card, resolved relative to the previewed note. */
  openHoverLink(target: string): void {
    const from = this.hoverPreview?.entry?.relativePath ?? this.selectedFileRelativePath;
    const entry = this.vaultIndex?.resolveLink(target, from);
    this.closeHoverPreview();
    if (entry?.kind === 'file') {
      if (this.previewOnly) this.requestPreviewTab(entry.relativePath, entry.name);
      else void this.selectFile(entry);
    }
  }

  // ---- Links ----

  onWikilinkClick(path: string): void {
    if (!path) return;

    if (this.previewOnly) {
      this.openInternalLinkPreviewTab(path);
      return;
    }

    void this.openInternalLink(path);
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
    const entry = this.vaultIndex?.resolveLink(linkPath, this.selectedFileRelativePath);

    if (entry?.kind === 'file') {
      await this.selectFile(entry);
    } else if (entry?.kind === 'directory') {
      await this.selectFolder(entry);
    }
  }

  private openInternalLinkPreviewTab(linkPath: string): void {
    const entry = this.vaultIndex?.resolveLink(linkPath, this.selectedFileRelativePath);
    if (entry?.kind === 'file') {
      this.requestPreviewTab(entry.relativePath, entry.name);
    }
  }

  private requestPreviewTab(path: string, name: string): void {
    if (!this.serverId || !path) return;

    this.previewTabRequested.emit({
      serverId: this.serverId,
      path,
      title: getVaultDisplayName(name.split('/').pop() || name),
    });
  }

  openObsidianVault(): void {
    if (this.localhostRoute) {
      window.open(this.localhostRoute, '_blank');
    }
  }

  // ---- Broadcast ----

  /**
   * Opens the shared file/folder menu for a tree row: at the pointer for right-click,
   * under the row's "more" button otherwise.
   */
  openEntryMenu(event: MouseEvent, entry: VaultEntry): void {
    event.preventDefault();
    event.stopPropagation();

    const anchor = event.currentTarget instanceof HTMLElement && event.type !== 'contextmenu'
      ? event.currentTarget.getBoundingClientRect()
      : null;
    this.menuEntry = entry;
    this.contextMenuPosition.x = `${anchor ? anchor.left : event.clientX}px`;
    this.contextMenuPosition.y = `${anchor ? anchor.bottom : event.clientY}px`;
    this.entryMenuTrigger?.openMenu();
  }

  /** Header menu: delete the open file. */
  async deleteOpenFile(): Promise<void> {
    const entry = this.selectedFileRelativePath ? this.vaultIndex?.getByPath(this.selectedFileRelativePath) : null;
    if (entry) {
      await this.deleteEntry(entry);
    }
  }

  /** Header menu: show the open file's folder in the tree. */
  revealOpenFile(): void {
    const parent = this.selectedFileRelativePath.split('/').slice(0, -1).join('/');
    this.expandAncestors(this.selectedFileRelativePath);
    if (parent) this.expandedFolders.add(parent);
    this.openMobileSidebar();
  }

  onImageContextMenu(event: MouseEvent, trigger: MatMenuTrigger): void {
    const image = event.target instanceof HTMLElement ? event.target.closest('img') : null;
    const src = image?.getAttribute('src') || '';
    if (!image || !src) return;

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
    const image = this.pendingImageBroadcast;
    if (!image) return;

    this.pendingImageBroadcast = null;
    await this.broadcastService.broadcastImage(this.broadcastContext(), image);
  }

  async broadcastEntry(entry: VaultEntry, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (entry.kind !== 'file') return;

    await this.selectFile(entry);
    await this.broadcastFullDocument();
  }

  /** Broadcasts the editor selection if there is one, otherwise the whole document. */
  async broadcast(): Promise<void> {
    const selection = this.getEditorSelection();
    if (selection) {
      await this.broadcastService.broadcastSelection(this.broadcastContext(), selection);
      return;
    }

    await this.broadcastFullDocument();
  }

  async broadcastFullDocument(): Promise<void> {
    const view = this.fileView;
    if (!view || (!view.content && !view.blobUrl)) return;

    const isMarkdown = view.fileType.viewer === 'markdown';
    await this.broadcastService.broadcastDocument({
      ...this.broadcastContext(),
      fileName: view.name,
      markdown: isMarkdown ? view.content : null,
      html: isMarkdown ? this.getEditorHtml() : undefined,
    });
  }

  private broadcastContext() {
    return { serverId: this.serverId, currentFilePath: this.selectedFileRelativePath };
  }

  private getEditorHtml(): string | undefined {
    return this.hostRef.nativeElement.querySelector<HTMLElement>(
      '.milkdown-container .ProseMirror, .milkdown-container'
    )?.innerHTML;
  }

  private revokeObjectUrls(): void {
    this.objectUrls.forEach(url => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }
}

/** localStorage helpers for per-browser UI preferences. Storage can be unavailable; fall back silently. */
function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeStoredFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

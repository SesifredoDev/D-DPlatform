import {AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, Input, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {MatButtonModule, MatIconButton} from '@angular/material/button';
import { UserService} from '../../shared/services/user/user';
import {CharacterService} from '../../shared/services/character/character';
import {SidePanel} from './side-panel/side-panel';
import {Call, type VttPlaybackEvent, type VttStopEvent} from './call/call';
import {ChannelService} from '../../shared/services/channel/channel';
import {TextChannel} from './text-channel/text-channel';
import {ChannelType, IChannel} from '../../shared/models/server/channel.model';
import {MatIcon, MatIconModule} from '@angular/material/icon';
import {Tab, TabPane, TabService} from '../../shared/services/tab/tab-service';
import {CharacterViewer} from './character-viewer/character-viewer';
import {VttCanvas} from './vtt-canvas/vtt-canvas';
import {SpotifyPlayer} from './call/spotify-player/spotify-player';
import {Video} from '../../shared/services/video/video';
import {CommonModule} from '@angular/common';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {BroadcastDialog} from '../../objects/broadcast-dialog/broadcast-dialog';
import {ObsidianPreviewTabRequest, ObsidianViewComponent} from './obsidian-view/obsidian-view.component';
import {VttSync} from '../../shared/services/vttsync/vttsync';
import {TauriTabPanelService} from '../../shared/services/tab/tauri-tab-panel.service';
import {TabDragTransferService, type TabDragPayload} from '../../shared/services/tab/tab-drag-transfer.service';
import {Subscription} from 'rxjs';
import {AuthService} from '../../shared/services/auth/auth';
import type {UnlistenFn} from '@tauri-apps/api/event';
import {AstralPlaybackDropService} from '../../shared/services/astral-recording/astral-playback-drop';
import {ServerService} from '../../shared/services/server/server';
import {AstralOptimizationRunner} from './astral-optimization-runner/astral-optimization-runner';
import {AstralPackagingRunner} from './astral-packaging-runner/astral-packaging-runner';
import {CallLivestreamManager} from './call/call-livestream-manager';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconButton,
    SidePanel,
    Call,
    TextChannel,
    MatIconModule,
    CharacterViewer,
    VttCanvas,
    SpotifyPlayer,
    MatDialogModule,
    MatSnackBarModule,
    ObsidianViewComponent,
    AstralOptimizationRunner,
    AstralPackagingRunner,
    CallLivestreamManager
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit, AfterViewInit, OnDestroy {
  @Input() externalPanelId: string | null = null;

  @ViewChild('editorArea') private editorAreaRef?: ElementRef<HTMLElement>;
  @ViewChild('leftPane') private leftPaneRef?: ElementRef<HTMLElement>;
  @ViewChild('rightPane') private rightPaneRef?: ElementRef<HTMLElement>;

  leftTabs: Tab[] = [];
  rightTabs: Tab[] = [];
  allTabs: Tab[] = [];
  draggingTabId: string | null = null;
  leftWidth = 0;
  isResizing = false;
  canUseTauriPanels = false;

  userInfo: any = null;
  activeCharacter: any = null;
  activeCharacterID: string | undefined;

  vttHostSessionId: string | null = null;
  vttJoinSessionId: string | null = null;

  isMobile: boolean = window.innerWidth <= 768;
  showSidePanel: boolean = !this.isMobile;
  isSidePanelCollapsed = false;
  private readonly minPaneWidth = 280;
  private pendingLeftWidth: number | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver?: ResizeObserver;
  private suppressNextTabClick = false;
  private hasSeenActiveVttSession = false;
  private readonly subscriptions = new Subscription();
  private externalWindowCloseUnlisten?: UnlistenFn;
  private hasSeenOwnedExternalTabs = false;
  private closingExternalPanel = false;
  private destroyingExternalWindow = false;
  private movingTabToNewPanel = false;

  constructor(
    private tabService: TabService,
    private characterService: CharacterService,
    private userService: UserService,
    private channelService: ChannelService,
    private serverService: ServerService,
    private videoService: Video,
    private vttSync: VttSync,
    private tauriTabPanelService: TauriTabPanelService,
    private tabDragTransfer: TabDragTransferService,
    private astralPlaybackDrop: AstralPlaybackDropService,
    private authService: AuthService,
    private cdr: ChangeDetectorRef,
    private dialog: MatDialog,
    private snackBar: MatSnackBar
  ) {
    this.leftWidth = this.getDefaultSplitWidth(window.innerWidth);
  }

  ngOnInit() {
    this.isMobile = this.shouldUseMobileLayout();
    this.showSidePanel = !this.isExternalPanel && !this.isMobile;
    this.canUseTauriPanels = this.tauriTabPanelService.isAvailable();

    this.subscriptions.add(this.tabService.tabs$.subscribe(tabs => {
      this.allTabs = tabs;
      this.updatePaneTabs();
    }));

    this.userInfo = this.createFallbackUserInfo();
    this.setupActiveCharacterListener();

    this.subscriptions.add(this.userService.getMe().subscribe({
      next: user => {
        this.userInfo = user;
        this.ensureDefaultCharacter();
      },
      error: error => {
        console.warn('Failed to load dashboard user info', error);
        this.ensureDefaultCharacter();
      }
    }));

    if (!this.isExternalPanel) {
      this.subscriptions.add(this.channelService.getChannelObservable().subscribe((channel: any) => {
        if (channel && channel._id) {
          if (channel.type === 'obsidian') {
            this.tabService.openTab(channel._id, channel.name, channel.type, this.leftPaneId, { serverId: channel.server });
          } else {
            this.tabService.openTab(channel._id, channel.name, channel.type, this.leftPaneId);
          }
        }
      }));
    }

    this.subscriptions.add(this.videoService.vttSession$.subscribe(session => {
      if (session.active) {
        this.hasSeenActiveVttSession = true;
        return;
      }

      if (!session.active) {
        const endedRoomId = this.vttHostSessionId || this.vttJoinSessionId || session.roomId;
        this.vttHostSessionId = null;
        this.vttJoinSessionId = null;
        if (this.hasSeenActiveVttSession) {
          this.hasSeenActiveVttSession = false;
          this.closeLiveVttTabs(endedRoomId ?? undefined);
        }
      }
    }));

    void this.setupExternalWindowCloseHandler();
  }

  ngAfterViewInit() {
    this.syncLayoutBounds();
    if (typeof ResizeObserver !== 'undefined' && this.editorAreaRef?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => this.syncLayoutBounds());
      this.resizeObserver.observe(this.editorAreaRef.nativeElement);
    }
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
    this.externalWindowCloseUnlisten?.();
    this.resizeObserver?.disconnect();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private updatePaneTabs() {
    const viewTabs = this.getCurrentViewTabs();

    if (this.isMobile) {
      this.leftTabs = viewTabs;
      this.rightTabs = [];
    } else {
      this.leftTabs = this.allTabs.filter(t => t.pane === this.leftPaneId);
      this.rightTabs = this.allTabs.filter(t => t.pane === this.rightPaneId);
    }
    this.trackExternalPanelLifecycle(viewTabs);
    this.syncLayoutBounds();
    this.cdr.detectChanges();
  }

  private setupActiveCharacterListener() {
    this.subscriptions.add(this.characterService.getActiveCharacterObservable().subscribe(character => {
      if (!character) {
        this.setDefaultCharacter();
      } else {
        this.activeCharacter = character;
        this.activeCharacterID = character._id === '0' ? undefined : character._id;
      }
    }));
  }

  private createFallbackUserInfo() {
    const userId = this.authService.getCurrentUserId();
    if (!userId) return null;

    return {
      _id: userId,
      id: userId,
      username: 'User',
      email: '',
      profileIcon: ''
    };
  }

  private ensureDefaultCharacter() {
    if (!this.activeCharacter || this.activeCharacter._id === '0') {
      this.setDefaultCharacter();
    }
  }

  private setDefaultCharacter() {
    if (!this.userInfo) return;

    const userId = this.userInfo._id || this.userInfo.id || '0';
    this.activeCharacter = {
      _id: '0',
      ownerId: userId,
      name: this.userInfo.username || 'User',
      baseStats: { strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
      classes: []
    };
    this.activeCharacterID = undefined;
  }

  startResizing(event: MouseEvent) {
    if (this.isMobile || this.rightTabs.length === 0) return;
    const renderedLeftWidth = this.leftPaneRef?.nativeElement.getBoundingClientRect().width;
    if (renderedLeftWidth) {
      const editorWidth = this.editorAreaRef?.nativeElement.getBoundingClientRect().width ?? renderedLeftWidth;
      this.leftWidth = this.clampLeftWidth(renderedLeftWidth, editorWidth);
    }
    this.isResizing = true;
    event.preventDefault();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    if (!this.isResizing || this.isMobile) return;
    this.scheduleLeftWidthUpdate(event.clientX);
  }

  @HostListener('window:mouseup')
  onMouseUp() {
    this.isResizing = false;
    this.pendingLeftWidth = null;
  }

  @HostListener('window:resize', ['$event'])
  onResize(event: any) {
    const wasMobile = this.isMobile;
    this.isMobile = this.shouldUseMobileLayout();
    this.syncLayoutBounds();
    if (wasMobile !== this.isMobile) {
      this.showSidePanel = !this.isExternalPanel && !this.isMobile;
      if (this.isMobile) {
        this.isSidePanelCollapsed = false;
      }
      this.updatePaneTabs();
    }
  }

  toggleSidePanel() {
    if (this.isExternalPanel) return;
    this.showSidePanel = !this.showSidePanel;
  }

  onSidePanelAction() {
    if (this.isMobile) {
      this.showSidePanel = false;
    }
  }

  onSidePanelCollapsedChange(collapsed: boolean) {
    if (this.isExternalPanel) {
      this.isSidePanelCollapsed = false;
      return;
    }

    if (this.isMobile) {
      this.isSidePanelCollapsed = false;
      return;
    }

    this.isSidePanelCollapsed = collapsed;
    this.syncLayoutBounds();
  }

  closeTab(event: Event, id: string) {
    event.stopPropagation();
    this.tabService.closeTab(id);
  }

  selectTab(tab: Tab) {
    if (this.suppressNextTabClick) return;

    this.tabService.selectTab(tab.id);
  }

  async popOutTab(event: Event, tab: Tab) {
    event.stopPropagation();
    await this.openTabInTauriPanel(tab);
  }

  private async openTabInTauriPanel(tab: Tab) {
    if (this.isMobile || !this.canUseTauriPanels) return;
    if (tab.type === 'livestream') {
      this.showLivestreamMoveBlockedMessage();
      return;
    }

    if (this.isActiveCallTab(tab)) {
      this.showActiveCallMoveBlockedMessage();
      return;
    }

    const previousPane = tab.pane;
    if (this.isExternalPanel) {
      this.movingTabToNewPanel = true;
    }

    try {
      const panel = this.tabService.createPanelFromTab(tab.id);
      if (!panel) return;

      const opened = await this.tauriTabPanelService.openPanel(panel);
      if (!opened) {
        this.tabService.moveTab(tab.id, previousPane);
      }
    } finally {
      if (this.isExternalPanel) {
        this.movingTabToNewPanel = false;
        this.closeExternalWindowIfEmpty();
      }
    }
  }

  onNativeTabDragStart(event: DragEvent, tab: Tab) {
    if (this.isMobile) {
      event.preventDefault();
      return;
    }

    this.draggingTabId = tab.id;
    this.suppressNextTabClick = true;
    this.tabDragTransfer.write(event, tab, { hasLiveConnection: this.isActiveCallTab(tab) });
  }

  onNativeTabDragEnd(tab: Tab) {
    this.finishNativeTabDrag();
    if (this.shouldPopOutUnhandledDrag(tab)) {
      void this.openTabInTauriPanel(tab);
    }

    this.tabDragTransfer.clearSoon();
  }

  onNativeTabDragOver(event: DragEvent) {
    if (this.isMobile || !this.tabDragTransfer.hasPayload(event)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onNativeTabDrop(event: DragEvent, targetPane: TabPane, targetTab?: Tab) {
    if (this.isMobile) return;

    const payload = this.readNativeTabDrop(event);
    if (!payload) return;

    this.finishNativeTabDrag();
    this.tabDragTransfer.markHandled(payload.tabId);
    if (targetTab?.id === payload.tabId) {
      this.tabDragTransfer.clearSoon();
      return;
    }

    if (this.isBlockedLiveCallTransfer(payload)) {
      this.tabDragTransfer.markHandled(payload.tabId);
      this.showBlockedTabMoveMessage(payload);
      this.tabDragTransfer.clearSoon();
      return;
    }

    const targetIndex = this.resolveNativeDropIndex(event, targetPane, targetTab, payload.tabId);
    this.tabService.moveOrAddTab(payload.tab, targetPane, targetIndex);
    this.tabDragTransfer.clearSoon();
  }

  async onNativePopoutDrop(event: DragEvent) {
    const payload = this.readNativeTabDrop(event);
    if (!payload) return;

    this.finishNativeTabDrag();
    this.tabDragTransfer.markHandled(payload.tabId);
    if (this.isBlockedLiveCallTransfer(payload)) {
      this.showBlockedTabMoveMessage(payload);
      this.tabDragTransfer.clearSoon();
      return;
    }

    const tab = this.allTabs.find(currentTab => currentTab.id === payload.tabId);
    if (tab) {
      await this.openTabInTauriPanel(tab);
    }

    this.tabDragTransfer.clearSoon();
  }

  getAppIcon(type: string): string {
    switch (type) {
      case 'text': return 'chat';
      case 'whisper': return 'visibility_off';
      case 'call': return 'videocam';
      case 'character': return 'person';
      case 'vtt': return 'map';
      case 'spotify': return 'music_note';
      case 'obsidian': return 'book';
      case 'livestream': return 'cast';
      default: return 'window';
    }
  }

  openObsidianPreviewTab(request: ObsidianPreviewTabRequest, sourceTab: Tab) {
    this.tabService.openObsidianPreviewTab({
      serverId: request.serverId,
      path: request.path,
      title: request.title,
      pane: this.resolveObsidianPreviewPane(sourceTab),
    });
  }

  onHostVtt(channelId: string) {
    this.vttHostSessionId = channelId;
    this.vttJoinSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? this.leftPaneId : this.rightPaneId, {
      vttSessionMode: 'host',
      vttSessionRoomId: channelId
    });
  }

  onJoinVtt(channelId: string) {
    this.vttJoinSessionId = channelId;
    this.vttHostSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? this.leftPaneId : this.rightPaneId, {
      vttSessionMode: 'join',
      vttSessionRoomId: channelId
    });
  }

  onPlaybackVtt(event: string | VttPlaybackEvent) {
    const channelId = typeof event === 'string' ? event : event.roomId;
    const active = typeof event === 'string' ? true : event.active;

    if (!active) {
      this.closePlaybackVttTabs(channelId);
      return;
    }

    this.closePlaybackVttTabs(channelId, true);
    this.tabService.openTab(`${channelId}:playback`, 'VTT Replay', 'vtt', this.isMobile ? this.leftPaneId : this.rightPaneId, {
      vttSessionMode: 'playback',
      vttSessionRoomId: channelId
    });
  }

  onStopVtt(event: string | VttStopEvent) {
    const channelId = typeof event === 'string' ? event : event.roomId;
    const shouldEndSession = typeof event !== 'string' && event.endSession;

    if (shouldEndSession && this.vttSync.isHosting && this.vttSync.currentRoomId === channelId) {
      this.vttSync.endSession();
    }

    if (this.vttHostSessionId === channelId) this.vttHostSessionId = null;
    if (this.vttJoinSessionId === channelId) this.vttJoinSessionId = null;
    this.closeLiveVttTabs(channelId);
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent) {
    if (this.tabDragTransfer.hasPayload(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      return;
    }

    if (!this.hasDraggedFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  @HostListener('dragenter', ['$event'])
  onDragEnter(event: DragEvent) {
    this.onDragOver(event);
  }

  @HostListener('window:storage', ['$event'])
  onStorage(event: StorageEvent) {
    if (this.tabDragTransfer.isHandledStorageEvent(event, this.draggingTabId)) {
      this.finishNativeTabDrag();
    }
  }

  @HostListener('drop', ['$event'])
  onFileDrop(event: DragEvent) {
    const tabPayload = this.readNativeTabDrop(event);
    if (tabPayload) {
      this.finishNativeTabDrag();
      this.tabDragTransfer.markHandled(tabPayload.tabId);
      if (this.isBlockedLiveCallTransfer(tabPayload)) {
        this.showBlockedTabMoveMessage(tabPayload);
        this.tabDragTransfer.clearSoon();
        return;
      }

      this.tabService.moveOrAddTab(tabPayload.tab, this.resolvePaneFromDropPoint(event));
      this.tabDragTransfer.clearSoon();
      return;
    }

    if (!this.hasDraggedFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const astralFile = this.getDroppedAstralFile(files);
      if (astralFile) {
        this.requestAstralPlaybackDrop(astralFile, event);
        return;
      }

      const file = files[0];
      if (file.type.startsWith('image/')) {
        this.openBroadcastDialog(file);
      }
    }
  }

  openBroadcastDialog(file: File) {
    this.dialog.open(BroadcastDialog, {
      data: { file },
      width: '500px',
      maxWidth: '90vw',
      panelClass: ['glass-dialog-container', 'broadcast-dialog-panel']
    });
  }

  get leftPaneBasis(): string | null {
    if (this.isMobile || this.rightTabs.length === 0) {
      return null;
    }

    return `${this.leftWidth}px`;
  }

  get isExternalPanel(): boolean {
    return !!this.externalPanelId;
  }

  get leftPaneId(): TabPane {
    return this.externalPanelId ?? 'left';
  }

  get rightPaneId(): TabPane {
    return this.externalPanelId ? TabService.getPanelSecondaryPaneId(this.externalPanelId) : 'right';
  }

  get userId(): string {
    return this.userInfo?._id ?? this.userInfo?.id ?? '0';
  }

  get canControlSoundCloudPlayback(): boolean {
    return this.serverService.canUserDm(this.serverService.getCurrentServer(), this.userId);
  }

  private scheduleLeftWidthUpdate(pointerClientX: number) {
    this.pendingLeftWidth = this.resolveLeftWidthFromPointer(pointerClientX);
    if (this.pendingLeftWidth === null || this.animationFrameId !== null) {
      return;
    }

    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = null;
      if (this.pendingLeftWidth === null) {
        return;
      }

      this.leftWidth = this.pendingLeftWidth;
      this.pendingLeftWidth = null;
      this.cdr.detectChanges();
    });
  }

  private resolveLeftWidthFromPointer(pointerClientX: number): number | null {
    const editorRect = this.editorAreaRef?.nativeElement.getBoundingClientRect();
    if (!editorRect) {
      return null;
    }

    const pointerOffset = pointerClientX - editorRect.left;
    return this.clampLeftWidth(pointerOffset, editorRect.width);
  }

  private syncLayoutBounds() {
    const editorWidth = this.editorAreaRef?.nativeElement.getBoundingClientRect().width;
    if (!editorWidth || this.isMobile || this.rightTabs.length === 0) {
      return;
    }

    this.leftWidth = this.clampLeftWidth(this.leftWidth, editorWidth);
  }

  private clampLeftWidth(leftWidth: number, totalWidth: number): number {
    const maxWidth = Math.max(this.minPaneWidth, totalWidth - this.minPaneWidth);
    const nextWidth = leftWidth || this.getDefaultSplitWidth(totalWidth);
    return Math.round(Math.min(Math.max(nextWidth, this.minPaneWidth), maxWidth));
  }

  private getDefaultSplitWidth(totalWidth: number): number {
    return Math.round(Math.max(this.minPaneWidth, totalWidth / 2));
  }

  private shouldPopOutUnhandledDrag(tab: Tab): boolean {
    return !this.isMobile && this.canUseTauriPanels && !this.tabDragTransfer.wasHandled(tab.id);
  }

  private isActiveCallTab(tab: Tab): boolean {
    return tab.type === 'call' &&
      this.videoService.currentChannelId === tab.id &&
      !!this.videoService.getLocalStream();
  }

  private finishNativeTabDrag() {
    this.draggingTabId = null;
    window.setTimeout(() => {
      this.suppressNextTabClick = false;
    });
  }

  private isBlockedLiveCallTransfer(payload: TabDragPayload): boolean {
    if (payload.type === 'livestream' && !this.tabDragTransfer.isFromCurrentWindow(payload)) {
      return true;
    }

    return payload.type === 'call' &&
      payload.hasLiveConnection === true &&
      !this.tabDragTransfer.isFromCurrentWindow(payload);
  }

  private showActiveCallMoveBlockedMessage() {
    window.alert('Active calls can be moved inside the same window, but cannot be moved to another window while connected. Leave the call first, or pop it out before joining.');
  }

  private showBlockedTabMoveMessage(payload: TabDragPayload) {
    if (payload.type === 'livestream') {
      this.showLivestreamMoveBlockedMessage();
      return;
    }

    this.showActiveCallMoveBlockedMessage();
  }

  private showLivestreamMoveBlockedMessage() {
    window.alert('Live stream management must stay in the same window as the active call because it uses that call view as its video source.');
  }

  private closeLiveVttTabs(roomId?: string) {
    this.getCurrentViewTabs()
      .filter(tab => this.isLiveVttTab(tab, roomId))
      .forEach(tab => this.tabService.closeTab(tab.id));
  }

  private closePlaybackVttTabs(roomId?: string, keepMatchingRoom = false) {
    this.getCurrentViewTabs()
      .filter(tab => this.isPlaybackVttTab(tab, roomId, keepMatchingRoom))
      .forEach(tab => this.tabService.closeTab(tab.id));
  }

  private isLiveVttTab(tab: Tab, roomId?: string): boolean {
    if (tab.type !== 'vtt' || tab.data?.vttSessionMode === 'playback') {
      return false;
    }

    if (!roomId) {
      return true;
    }

    return tab.id === roomId || tab.data?.vttSessionRoomId === roomId;
  }

  private isPlaybackVttTab(tab: Tab, roomId?: string, keepMatchingRoom = false): boolean {
    if (tab.type !== 'vtt' || tab.data?.vttSessionMode !== 'playback') {
      return false;
    }

    const tabRoomId = tab.data?.vttSessionRoomId ?? tab.id.replace(/:playback$/, '');
    if (!roomId) {
      return true;
    }

    return keepMatchingRoom ? tabRoomId !== roomId : tabRoomId === roomId;
  }

  private readNativeTabDrop(event: DragEvent) {
    if (!this.tabDragTransfer.hasPayload(event)) {
      return null;
    }

    event.preventDefault();
    event.stopPropagation();
    return this.tabDragTransfer.read(event);
  }

  private resolveNativeDropIndex(event: DragEvent, targetPane: TabPane, targetTab: Tab | undefined, draggedTabId: string): number {
    const targetTabs = this.allTabs.filter(tab => tab.pane === targetPane && tab.id !== draggedTabId);
    if (!targetTab) {
      return targetTabs.length;
    }

    const targetIndex = targetTabs.findIndex(tab => tab.id === targetTab.id);
    if (targetIndex < 0) {
      return targetTabs.length;
    }

    return targetIndex + (this.isAfterHorizontalMidpoint(event) ? 1 : 0);
  }

  private isAfterHorizontalMidpoint(event: DragEvent): boolean {
    const target = event.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    return !!rect && event.clientX > rect.left + rect.width / 2;
  }

  private resolvePaneFromDropPoint(event: DragEvent): TabPane {
    if (this.isMobile) {
      return this.leftPaneId;
    }

    const rightRect = this.rightPaneRef?.nativeElement.getBoundingClientRect();
    if (rightRect && event.clientX >= rightRect.left && event.clientX <= rightRect.right) {
      return this.rightPaneId;
    }

    return this.leftPaneId;
  }

  private resolveObsidianPreviewPane(sourceTab: Tab): TabPane {
    if (this.isMobile) {
      return this.leftPaneId;
    }

    return sourceTab.pane === this.leftPaneId ? this.rightPaneId : sourceTab.pane;
  }

  private getCurrentViewTabs(): Tab[] {
    return this.allTabs.filter(tab => this.isPaneInCurrentDashboard(tab.pane));
  }

  private isPaneInCurrentDashboard(pane: TabPane): boolean {
    if (this.externalPanelId) {
      return TabService.panelOwnsPane(this.externalPanelId, pane);
    }

    return pane === 'left' || pane === 'right';
  }

  private shouldUseMobileLayout(): boolean {
    return !this.isExternalPanel && window.innerWidth <= 768;
  }

  private trackExternalPanelLifecycle(viewTabs: Tab[]) {
    if (!this.isExternalPanel) return;

    if (viewTabs.length > 0) {
      this.hasSeenOwnedExternalTabs = true;
      return;
    }

    if (this.hasSeenOwnedExternalTabs && !this.movingTabToNewPanel) {
      void this.destroyExternalWindow();
    }
  }

  private closeExternalWindowIfEmpty() {
    if (!this.isExternalPanel || this.getCurrentViewTabs().length > 0 || !this.hasSeenOwnedExternalTabs) {
      return;
    }

    void this.destroyExternalWindow();
  }

  private async setupExternalWindowCloseHandler() {
    const panelId = this.externalPanelId;
    if (!panelId || !this.isTauriRuntime()) return;

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    this.externalWindowCloseUnlisten = await getCurrentWindow().onCloseRequested(event => {
      if (this.closingExternalPanel || this.destroyingExternalWindow) return;

      event.preventDefault();
      this.closingExternalPanel = true;
      this.tabService.closePanel(panelId);
      void this.destroyExternalWindow();
    });
  }

  private async destroyExternalWindow() {
    if (!this.isExternalPanel || !this.isTauriRuntime() || this.destroyingExternalWindow) return;

    this.destroyingExternalWindow = true;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch (error) {
      console.warn('Failed to destroy external dashboard window', error);
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  private hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  private getDroppedAstralFile(files: FileList): File | null {
    return Array.from(files).find(file => this.isAstralFile(file)) ?? null;
  }

  private isAstralFile(file: File): boolean {
    return file.name.toLowerCase().endsWith('.astral');
  }

  private requestAstralPlaybackDrop(file: File, event: DragEvent) {
    const callTab = this.resolveOrOpenCallTabForAstralDrop(event);
    if (!callTab) {
      this.snackBar.open('No call channel is available for Astral playback.', 'Close', {
        duration: 4000
      });
      return;
    }

    this.tabService.selectTab(callTab.id);
    window.setTimeout(() => {
      this.astralPlaybackDrop.requestPlayback({
        file,
        channelId: callTab.id
      });
    });
  }

  private resolveCallTabForAstralDrop(event: DragEvent): Tab | null {
    const viewTabs = this.getCurrentViewTabs();
    const targetPane = this.resolvePaneFromDropPoint(event);
    const connectedCallId = this.videoService.currentChannelId;

    return viewTabs.find(tab => tab.type === 'call' && connectedCallId === tab.id)
      ?? viewTabs.find(tab => tab.type === 'call' && tab.pane === targetPane && tab.active)
      ?? viewTabs.find(tab => tab.type === 'call' && tab.active)
      ?? viewTabs.find(tab => tab.type === 'call')
      ?? null;
  }

  private resolveOrOpenCallTabForAstralDrop(event: DragEvent): Tab | null {
    const existingCallTab = this.resolveCallTabForAstralDrop(event);
    if (existingCallTab) {
      return existingCallTab;
    }

    const callChannel = this.findDefaultCallChannel();
    if (!callChannel?._id) {
      return null;
    }

    const targetPane = this.resolvePaneFromDropPoint(event);
    this.tabService.openTab(callChannel._id, callChannel.name || 'Call', 'call', targetPane);

    return this.tabService.getTabs().find(tab => tab.id === callChannel._id) ?? {
      id: callChannel._id,
      title: callChannel.name || 'Call',
      type: 'call',
      pane: targetPane,
      active: true
    };
  }

  private findDefaultCallChannel(): IChannel | null {
    const currentServer = this.serverService.getCurrentServer();
    return currentServer?.channels?.find(channel => channel.type === ChannelType.Call && !!channel._id) ?? null;
  }
}

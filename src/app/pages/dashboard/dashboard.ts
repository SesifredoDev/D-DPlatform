import {AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {MatButtonModule, MatIconButton} from '@angular/material/button';
import { UserService} from '../../shared/services/user/user';
import {CharacterService} from '../../shared/services/character/character';
import {SidePanel} from './side-panel/side-panel';
import {Call, VttStopEvent} from './call/call';
import {ChannelService} from '../../shared/services/channel/channel';
import {TextChannel} from './text-channel/text-channel';
import {MatIcon, MatIconModule} from '@angular/material/icon';
import {Tab, TabPane, TabService} from '../../shared/services/tab/tab-service';
import {CharacterViewer} from './character-viewer/character-viewer';
import {VttCanvas} from './vtt-canvas/vtt-canvas';
import {SpotifyPlayer} from './call/spotify-player/spotify-player';
import {Video} from '../../shared/services/video/video';
import {CommonModule} from '@angular/common';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {BroadcastDialog} from '../../objects/broadcast-dialog/broadcast-dialog';
import {ObsidianViewComponent} from './obsidian-view/obsidian-view.component';
import {VttSync} from '../../shared/services/vttsync/vttsync';
import {TauriTabPanelService} from '../../shared/services/tab/tauri-tab-panel.service';
import {TabDragTransferService, type TabDragPayload} from '../../shared/services/tab/tab-drag-transfer.service';

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
    ObsidianViewComponent
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit, AfterViewInit, OnDestroy {
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

  constructor(
    private tabService: TabService,
    private characterService: CharacterService,
    private userService: UserService,
    private channelService: ChannelService,
    private videoService: Video,
    private vttSync: VttSync,
    private tauriTabPanelService: TauriTabPanelService,
    private tabDragTransfer: TabDragTransferService,
    private cdr: ChangeDetectorRef,
    private dialog: MatDialog
  ) {
    this.leftWidth = this.getDefaultSplitWidth(window.innerWidth);
  }

  ngOnInit() {
    this.canUseTauriPanels = this.tauriTabPanelService.isAvailable();

    this.tabService.tabs$.subscribe(tabs => {
      this.allTabs = tabs;
      this.updatePaneTabs();
    });

    this.userService.getMe().subscribe(user => {
      this.userInfo = user;
      this.setupActiveCharacterListener();
    });

    this.channelService.getChannelObservable().subscribe((channel: any) => {
      if (channel && channel._id) {
        if (channel.type === 'obsidian') {
          this.tabService.openTab(channel._id, channel.name, channel.type, 'left', { serverId: channel.server });
        } else {
          this.tabService.openTab(channel._id, channel.name, channel.type);
        }
      }
    });

    this.videoService.vttSession$.subscribe(session => {
      if (session.active) {
        this.hasSeenActiveVttSession = true;
        return;
      }

      if (!session.active) {
        this.vttHostSessionId = null;
        this.vttJoinSessionId = null;
        if (this.hasSeenActiveVttSession) {
          this.hasSeenActiveVttSession = false;
          this.clearAllVttTabModes();
        }
      }
    });
  }

  ngAfterViewInit() {
    this.syncLayoutBounds();
    if (typeof ResizeObserver !== 'undefined' && this.editorAreaRef?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => this.syncLayoutBounds());
      this.resizeObserver.observe(this.editorAreaRef.nativeElement);
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private updatePaneTabs() {
    if (this.isMobile) {
      this.leftTabs = this.allTabs;
      this.rightTabs = [];
    } else {
      this.leftTabs = this.allTabs.filter(t => t.pane === 'left');
      this.rightTabs = this.allTabs.filter(t => t.pane === 'right');
    }
    this.syncLayoutBounds();
    this.cdr.detectChanges();
  }

  private setupActiveCharacterListener() {
    this.characterService.getActiveCharacterObservable().subscribe(character => {
      if (!character && this.userInfo) {
        this.activeCharacter = {
          _id: this.userInfo._id || '0',
          ownerId: this.userInfo._id,
          name: this.userInfo.username || 'User',
          baseStats: { strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
          classes: []
        };
      } else if (character) {
        this.activeCharacter = character;
        this.activeCharacterID = character._id === '0' ? undefined : character._id;
      }
    });
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
    this.isMobile = window.innerWidth <= 768;
    this.syncLayoutBounds();
    if (wasMobile !== this.isMobile) {
      this.showSidePanel = !this.isMobile;
      if (this.isMobile) {
        this.isSidePanelCollapsed = false;
      }
      this.updatePaneTabs();
    }
  }

  toggleSidePanel() {
    this.showSidePanel = !this.showSidePanel;
  }

  onSidePanelAction() {
    if (this.isMobile) {
      this.showSidePanel = false;
    }
  }

  onSidePanelCollapsedChange(collapsed: boolean) {
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
    if (this.isActiveCallTab(tab)) {
      this.showActiveCallMoveBlockedMessage();
      return;
    }

    const previousPane = tab.pane;
    const panel = this.tabService.createPanelFromTab(tab.id);
    if (!panel) return;

    const opened = await this.tauriTabPanelService.openPanel(panel);
    if (!opened) {
      this.tabService.moveTab(tab.id, previousPane);
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
    this.draggingTabId = null;
    if (this.shouldPopOutUnhandledDrag(tab)) {
      void this.openTabInTauriPanel(tab);
    }

    this.tabDragTransfer.clearSoon();
    window.setTimeout(() => {
      this.suppressNextTabClick = false;
    });
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

    this.tabDragTransfer.markHandled(payload.tabId);
    if (targetTab?.id === payload.tabId) {
      this.tabDragTransfer.clearSoon();
      return;
    }

    if (this.isBlockedLiveCallTransfer(payload)) {
      this.tabDragTransfer.markHandled(payload.tabId);
      this.showActiveCallMoveBlockedMessage();
      this.tabDragTransfer.clearSoon();
      return;
    }

    const targetIndex = this.resolveNativeDropIndex(event, targetPane, targetTab, payload.tabId);
    this.tabService.moveTab(payload.tabId, targetPane, targetIndex);
    this.tabDragTransfer.clearSoon();
  }

  async onNativePopoutDrop(event: DragEvent) {
    const payload = this.readNativeTabDrop(event);
    if (!payload) return;

    this.tabDragTransfer.markHandled(payload.tabId);
    if (this.isBlockedLiveCallTransfer(payload)) {
      this.showActiveCallMoveBlockedMessage();
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
      default: return 'window';
    }
  }

  onHostVtt(channelId: string) {
    this.vttHostSessionId = channelId;
    this.vttJoinSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? 'left' : 'right', {
      vttSessionMode: 'host',
      vttSessionRoomId: channelId
    });
  }

  onJoinVtt(channelId: string) {
    this.vttJoinSessionId = channelId;
    this.vttHostSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? 'left' : 'right', {
      vttSessionMode: 'join',
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
    this.clearVttTabMode(channelId);
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

  @HostListener('drop', ['$event'])
  onFileDrop(event: DragEvent) {
    const tabPayload = this.readNativeTabDrop(event);
    if (tabPayload) {
      this.tabDragTransfer.markHandled(tabPayload.tabId);
      if (this.isBlockedLiveCallTransfer(tabPayload)) {
        this.showActiveCallMoveBlockedMessage();
        this.tabDragTransfer.clearSoon();
        return;
      }

      this.tabService.moveTab(tabPayload.tabId, this.resolvePaneFromDropPoint(event));
      this.tabDragTransfer.clearSoon();
      return;
    }

    if (!this.hasDraggedFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
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
      maxWidth: '90vw'
    });
  }

  get leftPaneBasis(): string | null {
    if (this.isMobile || this.rightTabs.length === 0) {
      return null;
    }

    return `${this.leftWidth}px`;
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

  private isBlockedLiveCallTransfer(payload: TabDragPayload): boolean {
    return payload.type === 'call' &&
      payload.hasLiveConnection === true &&
      !this.tabDragTransfer.isFromCurrentWindow(payload);
  }

  private showActiveCallMoveBlockedMessage() {
    window.alert('Active calls can be moved inside the same window, but cannot be moved to another window while connected. Leave the call first, or pop it out before joining.');
  }

  private clearAllVttTabModes() {
    this.allTabs
      .filter(tab => tab.type === 'vtt' && tab.data?.vttSessionMode)
      .forEach(tab => this.clearVttTabMode(tab.id));
  }

  private clearVttTabMode(channelId: string) {
    const tab = this.allTabs.find(currentTab => currentTab.id === channelId && currentTab.type === 'vtt');
    if (!tab?.data?.vttSessionMode) return;

    this.tabService.updateTab(channelId, {
      data: {
        ...tab.data,
        vttSessionMode: null,
        vttSessionRoomId: null
      }
    });
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
      return 'left';
    }

    const rightRect = this.rightPaneRef?.nativeElement.getBoundingClientRect();
    if (rightRect && event.clientX >= rightRect.left && event.clientX <= rightRect.right) {
      return 'right';
    }

    return 'left';
  }

  private hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }
}

import { CommonModule } from '@angular/common';
import { Component, HostListener, Input, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import { Tab, TabService } from '../../../shared/services/tab/tab-service';
import { TabDragTransferService, type TabDragPayload } from '../../../shared/services/tab/tab-drag-transfer.service';
import { UserService } from '../../../shared/services/user/user';
import { CharacterService } from '../../../shared/services/character/character';
import { Video } from '../../../shared/services/video/video';
import { VttSync } from '../../../shared/services/vttsync/vttsync';
import { AuthService } from '../../../shared/services/auth/auth';
import { Call, VttStopEvent } from '../call/call';
import { TextChannel } from '../text-channel/text-channel';
import { CharacterViewer } from '../character-viewer/character-viewer';
import { VttCanvas } from '../vtt-canvas/vtt-canvas';
import { SpotifyPlayer } from '../call/spotify-player/spotify-player';
import { ObsidianViewComponent } from '../obsidian-view/obsidian-view.component';
import { TauriTabPanelService } from '../../../shared/services/tab/tauri-tab-panel.service';

@Component({
  selector: 'app-tab-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    Call,
    TextChannel,
    CharacterViewer,
    VttCanvas,
    SpotifyPlayer,
    ObsidianViewComponent
  ],
  templateUrl: './tab-panel.html',
  styleUrl: './tab-panel.scss'
})
export class TabPanel implements OnInit, OnDestroy {
  @Input({ required: true }) panelId!: string;

  tabs: Tab[] = [];
  userInfo: any = null;
  activeCharacter: any = null;
  activeCharacterID: string | undefined;
  vttHostSessionId: string | null = null;
  vttJoinSessionId: string | null = null;
  draggingTabId: string | null = null;

  private readonly subscriptions = new Subscription();
  private closingForDock = false;
  private closingForPanel = false;
  private hasSeenOwnedTabs = false;
  private destroyingWindow = false;
  private suppressNextTabClick = false;
  private movingTabToNewPanel = false;
  private hasSeenActiveVttSession = false;

  constructor(
    private tabService: TabService,
    private userService: UserService,
    private characterService: CharacterService,
    private videoService: Video,
    private vttSync: VttSync,
    private authService: AuthService,
    private tabDragTransfer: TabDragTransferService,
    private tauriTabPanelService: TauriTabPanelService
  ) {}

  ngOnInit() {
    this.subscriptions.add(this.tabService.tabs$.subscribe(tabs => {
      this.tabs = tabs.filter(tab => tab.pane === this.panelId);
      if (this.tabs.length > 0) {
        this.hasSeenOwnedTabs = true;
      }

      if (this.tabs.length === 0 && this.hasSeenOwnedTabs && !this.movingTabToNewPanel) {
        void this.destroyWindow();
      }
    }));

    this.userInfo = this.createFallbackUserInfo();
    this.setupActiveCharacterListener();

    this.subscriptions.add(this.userService.getMe().subscribe({
      next: user => {
        this.userInfo = user;
        this.ensureDefaultCharacter();
      },
      error: error => {
        console.warn('Failed to load user info for tab panel', error);
        this.ensureDefaultCharacter();
      }
    }));

    this.subscriptions.add(this.videoService.vttSession$.subscribe(session => {
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
    }));

    void this.setupCloseHandler();
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  closeTab(event: Event, id: string) {
    event.stopPropagation();
    this.tabService.closeTab(id);
  }

  selectTab(tab: Tab) {
    if (this.suppressNextTabClick) return;

    this.tabService.selectTab(tab.id);
  }

  dockPanel() {
    if (this.tabs.some(tab => this.isActiveCallTab(tab))) {
      this.showActiveCallMoveBlockedMessage();
      return;
    }

    this.closingForDock = true;
    this.tabService.dockPanel(this.panelId, 'left');
    void this.destroyWindow();
  }

  onNativeTabDragStart(event: DragEvent, tab: Tab) {
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
    if (!this.tabDragTransfer.hasPayload(event)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  @HostListener('dragenter', ['$event'])
  onNativeTabDragEnter(event: DragEvent) {
    this.onNativeTabDragOver(event);
  }

  onNativeTabDrop(event: DragEvent, targetTab?: Tab) {
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

    const targetIndex = this.resolveNativeDropIndex(event, targetTab, payload.tabId);
    this.tabService.moveTab(payload.tabId, this.panelId, targetIndex);
    this.tabDragTransfer.clearSoon();
  }

  closePanel(event?: Event) {
    event?.stopPropagation();
    this.closingForPanel = true;
    this.tabService.closePanel(this.panelId);
    void this.destroyWindow();
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
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.panelId, {
      vttSessionMode: 'host',
      vttSessionRoomId: channelId
    });
  }

  onJoinVtt(channelId: string) {
    this.vttJoinSessionId = channelId;
    this.vttHostSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.panelId, {
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

  private setupActiveCharacterListener() {
    this.subscriptions.add(this.characterService.getActiveCharacterObservable().subscribe(character => {
      if (!character) {
        this.ensureDefaultCharacter();
      } else if (character) {
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
    if (!this.userInfo || (this.activeCharacter && this.activeCharacter._id !== '0')) {
      return;
    }

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

  private async setupCloseHandler() {
    if (!this.isTauriRuntime()) return;

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onCloseRequested(event => {
      if (this.closingForDock || this.closingForPanel) return;

      event.preventDefault();
      this.closePanel();
    });
  }

  private async destroyWindow() {
    if (!this.isTauriRuntime() || this.destroyingWindow) return;

    this.destroyingWindow = true;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch (error) {
      console.warn('Failed to destroy tab panel window', error);
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  private async openTabInTauriPanel(tab: Tab) {
    if (!this.tauriTabPanelService.isAvailable()) return;
    if (this.isActiveCallTab(tab)) {
      this.showActiveCallMoveBlockedMessage();
      return;
    }

    const previousPane = tab.pane;
    this.movingTabToNewPanel = true;
    const panel = this.tabService.createPanelFromTab(tab.id);
    if (!panel) {
      this.movingTabToNewPanel = false;
      return;
    }

    const opened = await this.tauriTabPanelService.openPanel(panel);
    if (!opened) {
      this.tabService.moveTab(tab.id, previousPane);
      this.movingTabToNewPanel = false;
      return;
    }

    this.movingTabToNewPanel = false;
    if (this.tabs.length === 0 && this.hasSeenOwnedTabs) {
      void this.destroyWindow();
    }
  }

  private shouldPopOutUnhandledDrag(tab: Tab): boolean {
    return this.tauriTabPanelService.isAvailable() && !this.tabDragTransfer.wasHandled(tab.id);
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
    this.tabs
      .filter(tab => tab.type === 'vtt' && tab.data?.vttSessionMode)
      .forEach(tab => this.clearVttTabMode(tab.id));
  }

  private clearVttTabMode(channelId: string) {
    const tab = this.tabs.find(currentTab => currentTab.id === channelId && currentTab.type === 'vtt');
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

  private resolveNativeDropIndex(event: DragEvent, targetTab: Tab | undefined, draggedTabId: string): number {
    const targetTabs = this.tabs.filter(tab => tab.id !== draggedTabId);
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
}

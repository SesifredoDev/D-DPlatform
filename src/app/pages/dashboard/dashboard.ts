import {AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {MatButtonModule, MatIconButton} from '@angular/material/button';
import { UserService} from '../../shared/services/user/user';
import {CharacterService} from '../../shared/services/character/character';
import {SidePanel} from './side-panel/side-panel';
import {Call} from './call/call';
import {ChannelService} from '../../shared/services/channel/channel';
import {TextChannel} from './text-channel/text-channel';
import {MatIcon, MatIconModule} from '@angular/material/icon';
import {Tab, TabService} from '../../shared/services/tab/tab-service';
import {CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup} from '@angular/cdk/drag-drop';
import {CharacterViewer} from './character-viewer/character-viewer';
import {VttCanvas} from './vtt-canvas/vtt-canvas';
import {SpotifyPlayer} from './call/spotify-player/spotify-player';
import {Video} from '../../shared/services/video/video';
import {CommonModule} from '@angular/common';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {BroadcastDialog} from '../../objects/broadcast-dialog/broadcast-dialog';
import {ObsidianViewComponent} from './obsidian-view/obsidian-view.component';

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
    CdkDropList,
    CdkDrag,
    CdkDropListGroup,
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

  leftTabs: Tab[] = [];
  rightTabs: Tab[] = [];
  allTabs: Tab[] = [];
  leftWidth = 0;
  isResizing = false;

  userInfo: any = null;
  activeCharacter: any = null;
  activeCharacterID: string | undefined;

  vttHostSessionId: string | null = null;
  vttJoinSessionId: string | null = null;

  isMobile: boolean = window.innerWidth <= 768;
  showSidePanel: boolean = !this.isMobile;
  private readonly minPaneWidth = 280;
  private pendingLeftWidth: number | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver?: ResizeObserver;

  constructor(
    private tabService: TabService,
    private characterService: CharacterService,
    private userService: UserService,
    private channelService: ChannelService,
    private videoService: Video,
    private cdr: ChangeDetectorRef,
    private dialog: MatDialog
  ) {
    this.leftWidth = this.getDefaultSplitWidth(window.innerWidth);
  }

  ngOnInit() {
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
      if (!session.active) {
        this.vttHostSessionId = null;
        this.vttJoinSessionId = null;
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

  closeTab(event: Event, id: string) {
    event.stopPropagation();
    this.tabService.closeTab(id);
  }

  selectTab(tab: Tab) {
    this.tabService.selectTab(tab.id);
  }

  onDrop(event: CdkDragDrop<any>) {
    if (this.isMobile) return;
    const tab = event.item.data as Tab;
    const targetPane = event.container.data as 'left' | 'right';
    if (tab.pane !== targetPane) {
      this.tabService.moveTab(tab.id, targetPane);
    }
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
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? 'left' : 'right');
  }

  onJoinVtt(channelId: string) {
    this.vttJoinSessionId = channelId;
    this.vttHostSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', this.isMobile ? 'left' : 'right');
  }

  onStopVtt(channelId: string) {
    if (this.vttHostSessionId === channelId) this.vttHostSessionId = null;
    if (this.vttJoinSessionId === channelId) this.vttJoinSessionId = null;
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  @HostListener('drop', ['$event'])
  onFileDrop(event: DragEvent) {
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
}

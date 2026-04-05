import {ChangeDetectorRef, Component, HostListener, OnInit} from '@angular/core';
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
    MatDialogModule
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {

  leftTabs: Tab[] = [];
  rightTabs: Tab[] = [];
  leftWidth: number = window.innerWidth / 2;
  isResizing = false;

  userInfo: any = null;
  activeCharacter: any = null;
  activeCharacterID: string | undefined;

  vttHostSessionId: string | null = null;
  vttJoinSessionId: string | null = null;

  constructor(
    private tabService: TabService,
    private characterService: CharacterService,
    private userService: UserService,
    private channelService: ChannelService,
    private videoService: Video,
    private cdr: ChangeDetectorRef,
    private dialog: MatDialog
  ) {}

  ngOnInit() {
    this.tabService.tabs$.subscribe(tabs => {
      this.leftTabs = tabs.filter(t => t.pane === 'left');
      this.rightTabs = tabs.filter(t => t.pane === 'right');
      this.cdr.detectChanges();
    });

    this.userService.getMe().subscribe(user => {
      this.userInfo = user;
      this.setupActiveCharacterListener();
    });

    this.channelService.getChannelObservable().subscribe((channel: any) => {
      if (channel && channel._id) {
        this.tabService.openTab(channel._id, channel.name, channel.type);
      }
    });

    this.videoService.vttSession$.subscribe(session => {
      if (!session.active) {
        this.vttHostSessionId = null;
        this.vttJoinSessionId = null;
      }
    });
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
    this.isResizing = true;
    event.preventDefault();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    if (!this.isResizing) return;
    const sidebarWidth = 260;
    const newWidth = event.clientX - sidebarWidth;
    if (newWidth > 200 && (window.innerWidth - event.clientX) > 200) {
      this.leftWidth = newWidth;
    }
  }

  @HostListener('window:mouseup')
  onMouseUp() {
    this.isResizing = false;
  }

  closeTab(event: Event, id: string) {
    event.stopPropagation();
    this.tabService.closeTab(id);
  }

  selectTab(tab: Tab) {
    this.tabService.selectTab(tab.id);
  }

  onDrop(event: CdkDragDrop<any>) {
    const tab = event.item.data as Tab;
    const targetPane = event.container.data as 'left' | 'right';
    if (tab.pane !== targetPane) {
      this.tabService.moveTab(tab.id, targetPane);
    }
  }

  getAppIcon(type: string): string {
    switch (type) {
      case 'text': return 'chat';
      case 'call': return 'videocam';
      case 'character': return 'person';
      case 'vtt': return 'map';
      case 'spotify': return 'music_note';
      default: return 'window';
    }
  }

  onHostVtt(channelId: string) {
    this.vttHostSessionId = channelId;
    this.vttJoinSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', 'right');
  }

  onJoinVtt(channelId: string) {
    this.vttJoinSessionId = channelId;
    this.vttHostSessionId = null;
    this.tabService.openTab(channelId, 'VTT Session', 'vtt', 'right');
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

  onWhisperInitiated(member: any) {
    // Find active text channel
    const activeTextTab = [...this.leftTabs, ...this.rightTabs].find(t => t.active && t.type === 'text');
    if (activeTextTab) {
      this.tabService.updateTab(activeTextTab.id, { whisperRecipient: member });
    }
  }
}

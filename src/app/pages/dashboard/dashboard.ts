import {ChangeDetectorRef, Component, HostListener, OnInit} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import { UserService} from '../../shared/services/user/user';
import {AuthService} from '../../shared/services/auth/auth';

import {dndbeyond} from '../../shared/services/character/dndbeyond/dndbeyond';
import {CreateCharacterComponent} from '../character/create/create';
import {MatDialog} from '@angular/material/dialog';
import {CharacterService} from '../../shared/services/character/character';
import {SidePanel} from './side-panel/side-panel';
import {Call} from './call/call';
import {ChannelService} from '../../shared/services/channel/channel';
import {TextChannel} from './text-channel/text-channel';
import {MatIcon, MatIconModule} from '@angular/material/icon';
import {Tab, TabService} from '../../shared/services/tab/tab-service';
import {CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup} from '@angular/cdk/drag-drop';
import {CharacterViewer} from './character-viewer/character-viewer';

@Component({
  selector: 'app-dashboard',
  imports: [MatButtonModule, SidePanel, Call, TextChannel, MatIconModule, CdkDropList, CdkDrag, CdkDropListGroup, CharacterViewer],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {

  showMessages = false;
  showVideo = false;
  activeChannel: any = null;
  messageChannelID: string = "";

  userInfo: any = null;

  activeCharacter: any = null;
  activeCharacterID: string | undefined;

  leftTabs: Tab[] = [];
  rightTabs: Tab[] = [];
  leftWidth: number = window.innerWidth / 2;
  isResizing = false;

  // Helper getters to find what to render in the content area
  get activeLeftTab() { return this.leftTabs.find(t => t.active); }
  get activeRightTab() { return this.rightTabs.find(t => t.active); }


  constructor(private tabService: TabService, private characterService: CharacterService, private userService: UserService,private channelService: ChannelService) {
  }

  ngOnInit() {

    this.tabService.tabs$.subscribe(tabs => {
      this.leftTabs = tabs.filter(t => t.pane === 'left');
      this.rightTabs = tabs.filter(t => t.pane === 'right');
    });



    this.userService.getMe().subscribe(user =>{
        this.userInfo = user;
    })

    this.channelService.getChannelObservable().subscribe(channel => {
      if (channel&& channel._id) {
        this.tabService.openTab(channel._id, channel.name, channel.type);
      }
    });

    this.characterService.getActiveCharacterObservable().subscribe(character => {
      if(!character)return;
      else{
        console.log("Setup Character", character);
        this.activeCharacter = character;
        this.activeCharacterID = character._id;
        if(this.activeCharacterID =="0") this.activeCharacterID  = undefined;
        console.log("Active Character",this.activeCharacterID);
      }
    })
  }

  startResizing(event: MouseEvent) {
    this.isResizing = true;
    event.preventDefault();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    if (!this.isResizing) return;

    // Adjust based on your actual sidebar width (e.g., 260px)
    const sidebarWidth = 260;
    const newWidth = event.clientX - sidebarWidth;

    // Minimum width constraints (200px per pane)
    if (newWidth > 200 && (window.innerWidth - event.clientX) > 200) {
      this.leftWidth = newWidth;
    }
  }

  @HostListener('window:mouseup')
  onMouseUp() {
    this.isResizing = false;
  }

  closeTab(event: Event, id: string) {
    event.stopPropagation(); // Prevent selection when clicking X
    this.tabService.closeTab(id);
  }
  selectTab(tab: Tab) {
    this.tabService.selectTab(tab.id);
  }

  onDrop(event: CdkDragDrop<any>) {
    const tab = event.item.data as Tab;
    // Cast the data to our specific type
    const targetPane = event.container.data as 'left' | 'right';

    if (tab.pane !== targetPane) {
      this.tabService.moveTab(tab.id, targetPane);
    }
  }
  toggleMessages() {
    this.showMessages = !this.showMessages;

  }

  popOutComponent(type: 'video' | 'chat') {
    const url = `/${type}-standalone?id=${this.activeChannel?._id}`;
    window.open(url, '_blank', 'nodeIntegration=no,contextIsolation=yes,width=800,height=600');

  }


}

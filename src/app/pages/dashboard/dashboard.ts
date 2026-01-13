import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
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

@Component({
  selector: 'app-dashboard',
  imports: [MatButtonModule, SidePanel, Call, TextChannel, MatIconModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {

  showMessages = false;
  showVideo = false;
  activeChannel: any = null;
  messageChannelID: string = "";



  activeCharacterID: string | undefined;
  constructor(private characterService: CharacterService, private channelService: ChannelService) {
  }

  ngOnInit() {
    this.channelService.getChannelObservable().subscribe(channel => {
      this.activeChannel = channel;
      // Automatically show messages when a channel is selected

      this.messageChannelID  = this.activeChannel._id;
      if(this.activeChannel.type =="text"){
        this.showMessages = true;
        this.showVideo = false;
      }
      if(this.activeChannel.type =="call"){
        this.showMessages = false;
        this.showVideo = true;
      }
      console.log(this.activeChannel);
    });

    this.characterService.getActiveCharacterObservable().subscribe(character => {
      console.log(character);
      if(!character)return;
      else{

        this.activeCharacterID = character._id;
        if(this.activeCharacterID =="0") this.activeCharacterID  = undefined;
        console.log(this.activeCharacterID);
      }
    })
  }

  toggleMessages() {
    this.showMessages = !this.showMessages;

  }

  popOutComponent(type: 'video' | 'chat') {
    const url = `/${type}-standalone?id=${this.activeChannel?._id}`;
    window.open(url, '_blank', 'nodeIntegration=no,contextIsolation=yes,width=800,height=600');

  }


}

import {AfterViewInit, ChangeDetectorRef, Component, NgZone, OnInit} from '@angular/core';

import {MatCardModule} from '@angular/material/card';

import {ICharacter} from '../../../shared/models/user/character.model';

import {CharacterService} from '../../../shared/services/character/character';
import {CommonModule,  NgForOf, NgIf} from '@angular/common';
import {MatSelectModule} from '@angular/material/select';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatListModule} from '@angular/material/list';
import {MatIconModule} from '@angular/material/icon';
import {MatButtonModule} from '@angular/material/button';
import {MatDividerModule} from '@angular/material/divider';
import {Router} from '@angular/router';
import {MatMenuModule} from '@angular/material/menu';
import {UserService} from '../../../shared/services/user/user';
import {ServerService} from '../../../shared/services/server/server';
import {IServer} from '../../../shared/models/server/server.model';
import {IChannel} from '../../../shared/models/server/channel.model';
import {ChannelService} from '../../../shared/services/channel/channel';


@Component({

  selector: 'app-side-panel',

  imports: [CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatMenuModule,
  ],

  templateUrl: './side-panel.html',
  styleUrl: './side-panel.scss',

})

export class SidePanel implements  AfterViewInit {

  characters: ICharacter[] = [];
  selectedCharacter: ICharacter | null = null;

  servers: IServer[] = [];
  selectedServer: IServer | null = null;
  channels: IChannel[] = [];


  constructor(private cdr: ChangeDetectorRef,private zone: NgZone,private charService: CharacterService, private userService: UserService, private serverService: ServerService, private channelService: ChannelService, private router: Router) {}


  ngAfterViewInit(): void {



    this.userService.getMe().subscribe((user) =>{
      console.log(user);
      this.charService.getMyCharacters().subscribe((chars) =>{
        this.characters = chars;
        let userChar = ({
          ac: 0,
          baseStats: {
            strength: 0,
            dexterity: 0,
            constitution: 0,
            intelligence: 0,
            wisdom: 0,
            charisma: 0
          },
          classes: [],
          ownerId: '',
          race: 'Human? Maybe...',
          servers: ['0'],
          name:user.username, icon: user.profileIcon})
        console.log(user)
        this.characters = [
          userChar,
          ...this.characters
        ]

        this.selectedCharacter = this.characters[0];
        this.cdr.markForCheck();
      });



    });


    this.serverService.getMyServersObservable().subscribe((servers) =>{

      console.log(servers);
      if(servers.length > 0){
        this.servers = servers;
        this.selectServer(servers[0]);


      }
    })


    this.serverService.getServerDetailsObservable().subscribe((server) =>{
      if(server){

        console.log('Switched to server:', server);
      this.channels = server.channels;

        if(this.channels[0])    this.selectChannel(this.channels[0]);
      }



    })
    this.serverService.getMyServers();

  }



  onCharacterChange(char: ICharacter) {
    this.selectedCharacter = char;
    this.charService.setActiveCharacter(this.selectedCharacter);

  }



  goToManageCharacters() {
    this.router.navigate(['characters']);

  }

  selectChannel(channel: IChannel) {
    this.channelService.setChannelObservable(channel);
  }


  selectServer(server: any) {
    console.log("Server",server);
    this.selectedServer = server;
    this.serverService.getServerDetails(server._id);
    this.cdr.markForCheck();

  }


  goToSettings() {
    console.log('Opening Personal Settings');

  }

}

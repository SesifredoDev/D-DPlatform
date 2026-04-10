import {AfterViewInit, ChangeDetectorRef, Component, EventEmitter, Output} from '@angular/core';

import {ICharacter} from '../../../shared/models/user/character.model';

import {CharacterService} from '../../../shared/services/character/character';
import {CommonModule} from '@angular/common';
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
import {ChannelType, IChannel} from '../../../shared/models/server/channel.model';
import {ChannelService} from '../../../shared/services/channel/channel';
import {TabService} from '../../../shared/services/tab/tab-service';
import {MatDialog} from '@angular/material/dialog';
import {
  ServerSettingsDialogComponent
} from '../../../objects/server-settings-dialog-component/server-settings-dialog-component';
import {ServerAddDialogComponent} from '../../../objects/server-add-dialog-component/server-add-dialog-component';
import {VttSync} from '../../../shared/services/vttsync/vttsync';
import {ObsidianVaultService} from '../../../shared/services/ObsidianVault/obsidian-vault-service';


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

export class SidePanel implements AfterViewInit {

  @Output() whisperInitiated = new EventEmitter<any>();

  characters: ICharacter[] = [];
  selectedCharacter: ICharacter | null = null;

  servers: IServer[] = [];
  selectedServer: IServer | null = null;
  channels: IChannel[] = [];

  groupedMembers: any[] = [];

  currentUserId: string | null = null;


  constructor(
    private cdr: ChangeDetectorRef,
    private charService: CharacterService,
    private tabService: TabService,
    private userService: UserService,
    private serverService: ServerService,
    public channelService: ChannelService,
    private router: Router,
    private dialog: MatDialog,
    private vttSync: VttSync,
    public obsidianService: ObsidianVaultService
  ) {
  }


  ngAfterViewInit(): void {


    this.userService.getMe().subscribe((user) => {
      this.currentUserId = user._id;
      this.charService.getMyCharacters().subscribe((chars) => {
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
          ownerId: user._id,
          race: 'Human? Maybe...',
          servers: ['0'],
          name: user.username, icon: user.profileIcon || null
        })
        this.characters = [
          userChar,
          ...this.characters
        ]

        this.onCharacterChange(this.characters[0]);
        this.cdr.markForCheck();
      });


    });


    this.serverService.getMyServersObservable().subscribe((servers) => {

      if (servers.length > 0) {
        this.servers = servers;
        this.selectServer(servers[0]);


      }
    })


    this.serverService.getServerDetailsObservable().subscribe((server) => {
      if (server) {
        this.selectedServer = server
        this.channels = server.channels;

        if (this.channels[0]) this.selectChannel(this.channels[0]);
        console.log(server, this.currentUserId)
        if (server && this.currentUserId) {
          this.channels = [...server.channels];

          // Only show if user is owner AND a vault is linked
          if (this.obsidianService.isOwner(server, this.currentUserId) &&
            this.obsidianService.hasVaultAttached(server._id)) {
            this.channels.push(this.obsidianService.getObsidianChannel(server._id));
          }


          this.groupMembersByRole(server);

          // --- Debugging logs for Obsidian buttons ---
          console.log('--- Obsidian Button Debugging ---');
          console.log('selectedServer:', this.selectedServer);
          console.log('currentUserId:', this.currentUserId);
          console.log('selectedServer.owner:', (this.selectedServer as any)?.owner);
          console.log('Is current user owner:', this.currentUserId === (this.selectedServer as any)?.owner);
          console.log('hasVaultAttached:', this.obsidianService.hasVaultAttached((this.selectedServer as any)?._id));
          console.log('--- End Debugging ---');
          // --- End Debugging logs ---
        }

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

  openObsidian(){
    console.log("open Obsidian")
    if(!this.selectedServer) return
    let obsidianChannel = this.obsidianService.getObsidianChannel(this.selectedServer._id);

    console.log(obsidianChannel, "opening")
    this.selectChannel(obsidianChannel)
  }


  selectServer(server: any) {

    this.tabService.closeAllTabs()
    this.serverService.getServerDetails(server._id);

    this.cdr.markForCheck();

    // --- Debugging logs for Obsidian buttons ---
    console.log('--- Obsidian Button Debugging (selectServer) ---');
    console.log('selectedServer:', this.selectedServer);
    console.log('currentUserId:', this.currentUserId);
    console.log('selectedServer.owner:', (this.selectedServer as any)?.owner);
    console.log('Is current user owner:', this.currentUserId === (this.selectedServer as any)?.owner);
    console.log('hasVaultAttached:', this.obsidianService.hasVaultAttached((this.selectedServer as any)?._id));
    console.log('--- End Debugging (selectServer) ---');
    // --- End Debugging logs ---
  }
  get isServerOwner(){
    return this.selectedServer?.owner == this.currentUserId;
  }


  openSettings() {
    this.dialog.open(ServerSettingsDialogComponent, {
      data: this.selectedServer,
      width: '1800px',
      maxWidth: '95vw',
      height: '80vh',
      panelClass: 'server-settings-dialog'
    });
  }

  openAddServerDialog() {
    this.dialog.open(ServerAddDialogComponent, {
      width: '50vw',
      height: '70vh',
      minWidth: '400px',
      minHeight: '500px',
      panelClass: 'custom-dialog-container'
    });
  }

  async linkObsidian() {
    if (this.selectedServer) {
      await this.obsidianService.attachVaultToServer(this.selectedServer._id);
      // Trigger a refresh of server details to show the new channel
      this.serverService.getServerDetails(this.selectedServer._id);
    }
  }

  linkObsidianLocalhost() {
    if (this.selectedServer) {
      const url = prompt('Enter the localhost URL for your Obsidian vault (e.g., http://localhost:27124):');
      if (url) {
        this.obsidianService.setVaultLocalhostRoute(this.selectedServer._id, url);
        // Trigger a refresh of server details to show the new channel
        this.serverService.getServerDetails(this.selectedServer._id);
      }
    }
  }

  groupMembersByRole(server: any) {

    if (!server || !server.roles || !server.members) {
      this.groupedMembers = [];
      return;
    }

    const hoistedRoles = server.roles
      .filter((r: any) => r?.hoist)
      .sort((a: any, b: any) => (b.position || 0) - (a.position || 0));

    const groups: any[] = [];

    // Groups for hoisted roles
    hoistedRoles.forEach((role: any) => {

      const members = server.members.filter((member: any) =>
        member?.roles?.some((r: any) => r._id === role._id)
      );

      if (members.length) {
        groups.push({
          role,
          members
        });
      }
    });

    // Members without hoisted roles
    const ungrouped = server.members.filter((member: any) =>
      !member?.roles?.some((r: any) =>
        hoistedRoles.some((hr: any) => hr._id === r._id)
      )
    );

    if (ungrouped.length) {
      groups.push({
        role: {name: "Members"},
        members: ungrouped
      });
    }

    this.groupedMembers = groups;
  }

  openCharacter(character: ICharacter) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  openVTT() {
    if (!this.selectedServer?._id) return;
    this.tabService.openTab(this.selectedServer?._id, "vtt", "vtt", "left");
  }

  onRightClickCharacter(event: MouseEvent, character: ICharacter) {
    event.preventDefault(); // Prevent browser context menu

    // 1. Check if we are actually in a VTT session
    if (!this.vttSync.isConnected) {
      console.warn('Cannot add token: No active VTT session.');
      return;
    }

    // 2. Obtain the engine instance.
    // If your engine is stored in a shared service or accessible via a getter:
    const engine = this.vttSync.getEngine();

    if (engine) {
      // 3. Call the service method we built earlier
      this.vttSync.addCharacterToken(engine, character);
      console.log(`Added ${character.name} to the map via right-click.`);
    } else {
      console.error('VTT Engine not found. Is the map tab open?');
    }
  }

  whisperUser(member: any) {
    if (!this.selectedServer) return;
    this.serverService.getOrCreateWhisperChannel(this.selectedServer._id, member.user._id).subscribe(channel => {
        if (channel._id) {
          this.channelService.setChannelObservable(channel);
          this.tabService.openTab(channel._id, channel.name, 'whisper');
        }
    });
  }


}

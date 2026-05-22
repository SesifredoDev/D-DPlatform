import {AfterViewInit, ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, Output, ViewChild} from '@angular/core';

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
import {MatMenuModule, MatMenuTrigger} from '@angular/material/menu';
import {UserService} from '../../../shared/services/user/user';
import {ServerService} from '../../../shared/services/server/server';
import {IServer, ServerMember, TemporaryDmDuration} from '../../../shared/models/server/server.model';
import {ChannelType, IChannel} from '../../../shared/models/server/channel.model';
import {IRole} from '../../../shared/models/server/role.model';
import {ChannelService} from '../../../shared/services/channel/channel';
import {TabService} from '../../../shared/services/tab/tab-service';
import {MatDialog} from '@angular/material/dialog';
import {
  ServerSettingsDialogComponent
} from '../../../objects/server-settings-dialog-component/server-settings-dialog-component';
import {ServerAddDialogComponent} from '../../../objects/server-add-dialog-component/server-add-dialog-component';
import {VttSync} from '../../../shared/services/vttsync/vttsync';
import {ObsidianVaultService} from '../../../shared/services/ObsidianVault/obsidian-vault-service';
import {MatTooltipModule} from '@angular/material/tooltip';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {MessagingSocketService} from '../../../shared/services/messaging-socket/messaging-socket.service';
import {Subscription} from 'rxjs';
import {BroadcastDialog} from '../../../objects/broadcast-dialog/broadcast-dialog';
import type {
  ChannelAccessPermission,
  ServerManagementPermission
} from '../../../shared/models/pages/dashboard/side-panel/side-panel.model';

interface LastOpenSidePanelState {
  serverId?: string | null;
  channelId?: string | null;
}

@Component({

  selector: 'app-side-panel',

  standalone: true,

  imports: [CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatMenuModule,
    MatTooltipModule,
    MatSnackBarModule
  ],

  templateUrl: './side-panel.html',
  styleUrl: './side-panel.scss',

})

export class SidePanel implements AfterViewInit, OnDestroy {
  private static readonly lastOpenStateStorageKey = 'side-panel:last-open';

  @Input() collapsed = false;
  @Input() collapsible = false;
  @Output() whisperInitiated = new EventEmitter<any>();
  @Output() actionPerformed = new EventEmitter<void>();
  @Output() collapsedChange = new EventEmitter<boolean>();
  @ViewChild('memberContextMenuTrigger') memberContextMenuTrigger!: MatMenuTrigger;

  readonly collapsedContainerStyles: Readonly<Record<string, string>> = {
    width: '76px',
    'min-width': '76px',
    'max-width': '76px'
  };
  readonly collapsedHeaderStyles: Readonly<Record<string, string>> = {
    height: 'auto',
    padding: '8px 0',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center'
  };
  readonly collapsedServerButtonStyles: Readonly<Record<string, string>> = {
    width: '44px',
    'min-width': '44px',
    flex: '0 0 44px',
    'justify-content': 'center'
  };
  readonly collapsedIconStyles: Readonly<Record<string, string>> = {'margin-right': '0'};
  readonly collapsedContentStyles: Readonly<Record<string, string>> = {padding: '12px 0'};
  readonly collapsedSectionStyles: Readonly<Record<string, string>> = {
    'margin-bottom': '16px',
    padding: '0'
  };
  readonly collapsedSectionHeaderStyles: Readonly<Record<string, string>> = {
    'justify-content': 'center',
    padding: '0 0 8px'
  };
  readonly collapsedEmptyStateStyles: Readonly<Record<string, string>> = {padding: '0'};
  readonly collapsedEmptyStateContentStyles: Readonly<Record<string, string>> = {
    'max-width': 'none',
    width: '100%'
  };
  readonly collapsedEmptyIconStyles: Readonly<Record<string, string>> = {
    width: '36px',
    height: '36px',
    'font-size': '36px',
    'margin-bottom': '12px'
  };
  readonly collapsedEmptyButtonStyles: Readonly<Record<string, string>> = {
    width: '44px',
    'min-width': '44px',
    padding: '0'
  };
  readonly collapsedIdentityCardStyles: Readonly<Record<string, string>> = {
    'justify-content': 'center',
    gap: '0',
    margin: '0 8px',
    padding: '0'
  };
  readonly collapsedNavItemStyles: Readonly<Record<string, string>> = {
    'justify-content': 'center',
    margin: '0 8px',
    padding: '0'
  };
  readonly collapsedMemberCardStyles: Readonly<Record<string, string>> = {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    margin: '0 auto 4px',
    padding: '0'
  };
  readonly collapsedMemberMainStyles: Readonly<Record<string, string>> = {
    'justify-content': 'center',
    gap: '0'
  };
  readonly collapsedMemberCharsStyles: Readonly<Record<string, string>> = {
    margin: '0',
    padding: '0',
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center',
    gap: '10px'
  };
  readonly collapsedCharacterIconStyles: Readonly<Record<string, string>> = {
    width: '34px',
    height: '34px',
    'border-radius': '10px'
  };
  readonly collapsedRoleCategoryStyles: Readonly<Record<string, string>> = {
    'margin-bottom': '8px'
  };
  readonly collapsedFooterStyles: Readonly<Record<string, string>> = {padding: '12px 0'};
  readonly collapsedFooterActionsStyles: Readonly<Record<string, string>> = {
    'flex-direction': 'column',
    'align-items': 'center',
    gap: '8px',
    'margin-bottom': '0'
  };

  characters: ICharacter[] = [];
  selectedCharacter: ICharacter | null = null;

  servers: IServer[] = [];
  selectedServer: IServer | null = null;
  channels: IChannel[] = [];

  groupedMembers: any[] = [];
  selectedMemberForMenu: ServerMember | null = null;
  memberContextMenuPosition = { x: '0px', y: '0px' };
  temporaryDmDurations: Array<{ duration: TemporaryDmDuration; label: string }> = [
    { duration: 'day', label: 'DM for 1 day' },
    { duration: 'week', label: 'DM for 1 week' },
    { duration: 'month', label: 'DM for 1 month' },
    { duration: 'permanent', label: 'DM permanently' }
  ];

  currentUserId: string | null = null;

  private subscriptions: Subscription = new Subscription();
  private hasRequestedInitialServerDetails = false;


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
    public obsidianService: ObsidianVaultService,
    private messagingSocketService: MessagingSocketService,
    private snackBar: MatSnackBar
  ) {
  }


  ngAfterViewInit(): void {


    this.userService.getMe().subscribe((user) => {
      this.currentUserId = user._id;
      if (this.selectedServer) {
        this.applyServerDetails(this.selectedServer);
      }
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

        this.restoreActiveCharacter();
        this.cdr.markForCheck();
      });


    });


    this.subscriptions.add(this.serverService.getMyServersObservable().subscribe((servers) => {
      this.servers = servers;
      if (servers.length > 0) {
        if (!this.selectedServer) {
          this.restoreInitialServer(servers);
        } else if (!servers.some(server => server._id === this.selectedServer?._id)) {
          this.tabService.closeAllTabs();
          this.restoreServerWithoutClosingTabs(servers[0]);
        } else if (!this.hasRequestedInitialServerDetails) {
          this.hasRequestedInitialServerDetails = true;
          this.serverService.getServerDetails(this.selectedServer._id);
        }
      } else {
        this.selectedServer = null;
        this.rememberLastOpenState({ serverId: null, channelId: null });
      }
      this.cdr.markForCheck();
    }));


    this.subscriptions.add(this.serverService.getServerDetailsObservable().subscribe((server) => {
      if (server) {
        this.applyServerDetails(server);
      }


    }));

    this.subscriptions.add(this.messagingSocketService.memberUpdate$.subscribe((members) => {
      if (this.selectedServer) {
        this.serverService.updateCurrentServerMembers(members);
        this.selectedServer.members = members;
        this.groupMembersByRole(this.selectedServer);
        this.cdr.markForCheck();
      }
    }));

    this.subscriptions.add(this.messagingSocketService.characterUpdate$.subscribe((update) => {
      if (this.selectedServer && this.selectedServer._id === update.serverId) {
        const charData = update.data;

        this.selectedServer.members = this.selectedServer.members.map(member => {
          if (member.user._id === charData.ownerId) {
            let updatedCharacters;
            if (charData.deleted) {
              updatedCharacters = member.characters.filter((c: any) => c._id !== charData._id);
            } else {
              const exists = member.characters.some((c: any) => c._id === charData._id);
              if (exists) {
                updatedCharacters = member.characters.map((c: any) => c._id === charData._id ? charData : c);
              } else {
                updatedCharacters = [...member.characters, charData];
              }
            }
            return { ...member, characters: updatedCharacters };
          }
          return member;
        });

        this.groupMembersByRole(this.selectedServer);
        this.cdr.markForCheck();
      }
    }));

    this.serverService.getMyServers();

  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.messagingSocketService.disconnect();
  }


  onCharacterChange(char: ICharacter) {
    this.selectedCharacter = char;
    this.charService.setActiveCharacter(this.selectedCharacter);

  }

  toggleCollapsed() {
    this.collapsedChange.emit(!this.collapsed);
  }


  goToManageCharacters() {
    this.router.navigate(['characters']);
    this.actionPerformed.emit();
  }

  selectChannel(channel: IChannel) {
    if (!this.canOpenChannel(channel)) {
      this.snackBar.open('You do not have access to that channel.', 'OK', { duration: 2500 });
      return;
    }

    this.rememberLastOpenState({
      serverId: this.selectedServer?._id ?? channel.server,
      channelId: channel._id ?? null
    });
    this.channelService.setChannelObservable(channel);
    this.actionPerformed.emit();
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
    this.rememberLastOpenState({ serverId: server._id, channelId: null });
    this.serverService.getServerDetails(server._id);
    this.cdr.markForCheck();
    // Usually selecting a server doesn't close side panel as you might want to select a channel next,
    // but on mobile it's often better to close it if you've already auto-selected a channel.
    // However, let's keep it open for now to allow channel selection.
  }
  get isServerOwner(){
    if (!this.selectedServer || !this.currentUserId) return false;
    return this.serverService.getServerOwnerId(this.selectedServer) === this.currentUserId;
  }

  get canOpenSettings(): boolean {
    return this.hasAnyServerPermission([
      'ADMINISTRATOR',
      'MANAGE_SERVER',
      'MANAGE_ROLES',
      'MANAGE_CHANNELS'
    ]);
  }

  get canManageChannels(): boolean {
    return this.hasServerPermission('MANAGE_CHANNELS');
  }

  openSettings() {
    if (!this.selectedServer) return;
    if (!this.canOpenSettings) {
      this.snackBar.open('You do not have permission to manage this server.', 'OK', { duration: 2500 });
      return;
    }

    this.dialog.open(ServerSettingsDialogComponent, {
      data: this.selectedServer,
      width: '1800px',
      maxWidth: '95vw',
      height: '80vh',
      panelClass: 'server-settings-dialog'
    });
    this.actionPerformed.emit();
  }

  openAddServerDialog() {
    this.dialog.open(ServerAddDialogComponent, {
      width: '50vw',
      height: '70vh',
      minWidth: '400px',
      minHeight: '500px',
      panelClass: 'custom-dialog-container'
    });
    this.actionPerformed.emit();
  }

  openBroadcastDialog() {
    if (!this.selectedServer) return;

    this.dialog.open(BroadcastDialog, {
      data: { composeMode: true },
      width: '860px',
      maxWidth: '96vw',
      height: '80vh',
      maxHeight: '90vh',
      panelClass: ['glass-dialog-container', 'broadcast-dialog-panel', 'broadcast-compose-dialog']
    });
    this.actionPerformed.emit();
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
      this.actionPerformed.emit();
    }
  }

  openVTT() {
    const serverId = this.selectedServer?._id;
    if (!serverId) return;

    const canHostVtt = this.serverService.canUserDm(this.selectedServer, this.currentUserId);
    this.tabService.openTab(serverId, "vtt", "vtt", "left", {
      vttSessionRoomId: serverId,
      vttSessionMode: canHostVtt ? 'host' : 'join'
    });
    this.actionPerformed.emit();
  }

  openCall() {
    const callChannel = this.channels.find(c =>
      c.type === ChannelType.Call && this.hasChannelPermission(c, 'CONNECT')
    );
    if (callChannel) {
      this.selectChannel(callChannel);
    } else {
      console.warn('No video call channel found in this server.');
    }
  }

  async onRightClickCharacter(event: MouseEvent, character: ICharacter) {
    event.preventDefault(); // Prevent browser context menu
    event.stopPropagation();

    const added = await this.vttSync.addCharacterTokenToActiveVtt(
      character,
      this.selectedServer?._id ?? null
    );

    if (added) {
      console.log(`Added ${character.name} to the map via right-click.`);
    } else {
      console.warn('Cannot add token: no active VTT map was found for this server.');
      this.snackBar.open('Open or join the VTT map first.', 'OK', { duration: 2500 });
    }
  }

  onRightClickMember(event: MouseEvent, member: ServerMember) {
    if (!this.canManageTemporaryDm(member)) return;

    event.preventDefault();
    event.stopPropagation();

    this.selectedMemberForMenu = member;
    this.memberContextMenuPosition = {
      x: `${event.clientX}px`,
      y: `${event.clientY}px`
    };
    this.memberContextMenuTrigger.openMenu();
  }

  canManageTemporaryDm(member: ServerMember | null | undefined): boolean {
    if (!this.selectedServer || !this.currentUserId || !member) return false;
    return this.isServerOwner && this.serverService.getMemberUserId(member) !== this.currentUserId;
  }

  isMemberTemporaryDm(member: ServerMember | null | undefined): boolean {
    return this.serverService.isTemporaryDmGrantActive(member?.temporaryDm);
  }

  get selectedMemberName(): string {
    const user = this.selectedMemberForMenu?.user as any;
    if (!user || typeof user === 'string') return 'Member';
    return user.username;
  }

  async setTemporaryDm(duration: TemporaryDmDuration) {
    if (!this.selectedServer || !this.selectedMemberForMenu) return;

    const memberId = this.serverService.getMemberUserId(this.selectedMemberForMenu);
    if (!memberId) return;

    try {
      await this.serverService.updateTemporaryDm(this.selectedServer._id, memberId, duration);
      this.memberContextMenuTrigger.closeMenu();
    } catch (error) {
      console.error('Failed to update temporary DM', error);
    }
  }

  whisperUser(member: any) {
    if (!this.selectedServer) return;
    this.serverService.getOrCreateWhisperChannel(this.selectedServer._id, member.user._id).subscribe(channel => {
        if (channel._id) {
          this.rememberLastOpenState({ serverId: this.selectedServer?._id, channelId: channel._id });
          this.channelService.setChannelObservable(channel);
          this.tabService.openTab(channel._id, channel.name, 'whisper');
          this.actionPerformed.emit();
        }
    });
  }

  whisperDM() {
    if (!this.selectedServer || !this.selectedServer.owner) return;
    const ownerId = typeof this.selectedServer.owner === 'string'
      ? this.selectedServer.owner
      : this.selectedServer.owner._id;

    this.serverService.getOrCreateWhisperChannel(this.selectedServer._id, ownerId).subscribe(channel => {
      if (channel._id) {
        this.rememberLastOpenState({ serverId: this.selectedServer?._id, channelId: channel._id });
        this.channelService.setChannelObservable(channel);
        this.tabService.openTab(channel._id, channel.name, 'whisper');
        this.actionPerformed.emit();
      }
    });
  }

  private applyServerDetails(server: IServer) {
    this.selectedServer = server;
    this.channels = this.getVisibleChannels(server);
    this.rememberLastOpenState({ serverId: server._id });

    if (this.currentUserId &&
      this.obsidianService.isOwner(server, this.currentUserId) &&
      this.obsidianService.hasVaultAttached(server._id)) {
      this.channels.push(this.obsidianService.getObsidianChannel(server._id));
    }

    this.restoreOpenChannel(server);

    this.groupMembersByRole(server);
    this.messagingSocketService.joinServerRoom(server._id);
    this.cdr.markForCheck();
  }

  private restoreActiveCharacter() {
    const activeCharacter = this.charService.activeCharacter.value;
    const restoredCharacter = activeCharacter?._id
      ? this.characters.find(character => character._id === activeCharacter._id)
      : null;

    this.onCharacterChange(restoredCharacter ?? this.characters[0]);
  }

  private restoreInitialServer(servers: IServer[]) {
    const lastOpenState = this.readLastOpenState();
    const savedServerId = lastOpenState.serverId ?? this.serverService.getCurrentServer()?._id;
    const savedChannelServerId = this.channelService.currentChannel?.server;
    const serverIdToRestore = savedServerId ?? savedChannelServerId;
    const serverToRestore = serverIdToRestore
      ? servers.find(server => server._id === serverIdToRestore)
      : null;

    this.restoreServerWithoutClosingTabs(serverToRestore ?? servers[0]);
  }

  private restoreServerWithoutClosingTabs(server: IServer) {
    this.hasRequestedInitialServerDetails = true;
    this.rememberLastOpenState({ serverId: server._id });
    this.serverService.getServerDetails(server._id);
  }

  private restoreOpenChannel(server: IServer) {
    const currentChannel = this.channelService.currentChannel;
    const currentChannelBelongsToServer = currentChannel?.server === server._id;
    const currentChannelStillExists = this.channels.some(channel => channel._id === currentChannel?._id);
    const currentChannelCanStayOpen = currentChannelBelongsToServer &&
      (currentChannelStillExists || currentChannel?.type === ChannelType.Whisper);

    if (currentChannelCanStayOpen) {
      this.rememberLastOpenState({ serverId: server._id, channelId: currentChannel?._id ?? null });
      return;
    }

    const lastOpenChannelId = this.readLastOpenState().channelId;
    const restoredChannel = lastOpenChannelId
      ? this.channels.find(channel => channel._id === lastOpenChannelId)
      : null;

    if (restoredChannel) {
      this.selectChannel(restoredChannel);
      return;
    }

    if (this.channels[0]) this.selectChannel(this.channels[0]);
  }

  private readLastOpenState(): LastOpenSidePanelState {
    if (typeof window === 'undefined') return {};

    try {
      const rawState = window.localStorage.getItem(SidePanel.lastOpenStateStorageKey);
      if (!rawState) return {};

      const parsedState = JSON.parse(rawState) as LastOpenSidePanelState;
      return {
        serverId: typeof parsedState.serverId === 'string' ? parsedState.serverId : null,
        channelId: typeof parsedState.channelId === 'string' ? parsedState.channelId : null
      };
    } catch {
      return {};
    }
  }

  private rememberLastOpenState(nextState: LastOpenSidePanelState) {
    if (typeof window === 'undefined') return;

    const state = {
      ...this.readLastOpenState(),
      ...nextState
    };

    try {
      if (!state.serverId && !state.channelId) {
        window.localStorage.removeItem(SidePanel.lastOpenStateStorageKey);
        return;
      }

      window.localStorage.setItem(SidePanel.lastOpenStateStorageKey, JSON.stringify(state));
    } catch (error) {
      console.warn('Failed to remember last open side panel state', error);
    }
  }

  private getVisibleChannels(server: IServer): IChannel[] {
    return (server.channels ?? []).filter(channel =>
      channel.type !== ChannelType.Whisper &&
      this.hasChannelPermission(channel, 'READ_MESSAGE_HISTORY')
    );
  }

  private canOpenChannel(channel: IChannel): boolean {
    if (channel.type === ChannelType.Obsidian) return true;
    if (channel.type === ChannelType.Whisper) return true;
    if (!this.hasChannelPermission(channel, 'READ_MESSAGE_HISTORY')) return false;
    if (channel.type === ChannelType.Call) return this.hasChannelPermission(channel, 'CONNECT');
    return true;
  }

  private hasAnyServerPermission(permissionNames: ServerManagementPermission[]): boolean {
    return permissionNames.some(permissionName => this.hasServerPermission(permissionName));
  }

  private hasServerPermission(permissionName: ServerManagementPermission): boolean {
    const server = this.selectedServer;
    if (!server || !this.currentUserId) return false;

    if (this.serverService.getServerOwnerId(server) === this.currentUserId) return true;

    const member = this.getCurrentServerMember(server);
    if (!member) return false;

    const memberRoles = this.getMemberRoles(server, member);
    return memberRoles.some(role =>
      role.permissions?.ADMINISTRATOR === true ||
      role.permissions?.[permissionName] === true
    );
  }

  private hasChannelPermission(channel: IChannel, permissionName: ChannelAccessPermission): boolean {
    const server = this.selectedServer;
    if (!server || !this.currentUserId) return true;

    if (this.serverService.getServerOwnerId(server) === this.currentUserId) return true;

    const member = this.getCurrentServerMember(server);
    if (!member) return false;

    const roleIds = new Set((member.roles ?? []).map(role => this.resolveId(role)).filter(Boolean));
    const memberRoles = this.getMemberRoles(server, member);

    if (memberRoles.some(role => role.permissions?.ADMINISTRATOR)) return true;

    const overwrites = (channel.permissionOverwrites ?? []).filter(overwrite =>
      roleIds.has(this.resolveId(overwrite.role))
    );

    if (overwrites.some(overwrite => (overwrite.deny ?? []).includes(permissionName))) return false;
    if (overwrites.some(overwrite => (overwrite.allow ?? []).includes(permissionName))) return true;

    return memberRoles.some(role => role.permissions?.[permissionName] === true);
  }

  private getCurrentServerMember(server: IServer): ServerMember | undefined {
    return server.members?.find(candidate =>
      this.serverService.getMemberUserId(candidate) === this.currentUserId
    );
  }

  private getMemberRoles(server: IServer, member: ServerMember): IRole[] {
    const roleIds = new Set((member.roles ?? []).map(role => this.resolveId(role)).filter(Boolean));
    const roles = new Map<string, IRole>();

    (server.roles ?? []).forEach(role => {
      if (roleIds.has(role._id)) roles.set(role._id, role);
    });

    (member.roles ?? []).forEach(role => {
      if (role && typeof role === 'object' && 'permissions' in role) {
        const resolvedRole = role as unknown as IRole;
        if (resolvedRole._id) roles.set(resolvedRole._id, resolvedRole);
      }
    });

    return Array.from(roles.values());
  }

  private resolveId(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && '_id' in value) {
      const id = (value as IRole | { _id?: unknown })._id;
      return typeof id === 'string' ? id : '';
    }
    return '';
  }

}

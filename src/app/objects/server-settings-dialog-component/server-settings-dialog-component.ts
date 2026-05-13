import { Component, Inject, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, finalize, takeUntil } from 'rxjs';

import { ServerService } from '../../shared/services/server/server';
import { ChannelService } from '../../shared/services/channel/channel';
import { IServer, ServerMember } from '../../shared/models/server/server.model';
import { ChannelType, IChannel, PermissionOverwrite } from '../../shared/models/server/channel.model';
import { IRole, RolePermissions } from '../../shared/models/server/role.model';
import { IRolePayload, Role } from '../../shared/services/role/role';
import { MATERIAL_ICON_NAMES } from '../../shared/constants/material-icon-names';

type SettingsTab = 'overview' | 'roles' | 'members' | 'channels';
type EditableChannelType = ChannelType.Text | ChannelType.Call;
type ChannelPermissionKey = 'READ_MESSAGE_HISTORY' | 'SEND_MESSAGES' | 'CONNECT';
type ChannelPermissionState = 'inherit' | 'allow' | 'deny';

interface PermissionControl {
  key: keyof RolePermissions;
  label: string;
  description: string;
  defaultValue: boolean;
}

interface ChannelTypeOption {
  value: EditableChannelType;
  label: string;
  icon: string;
  description: string;
  defaultIcon: string;
}

interface ChannelPermissionControl {
  key: ChannelPermissionKey;
  label: string;
  icon: string;
  description: string;
}

@Component({
  selector: 'app-server-settings-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDividerModule,
    MatSnackBarModule,
    MatSlideToggleModule,
    MatCheckboxModule,
    MatTooltipModule
  ],
  templateUrl: './server-settings-dialog-component.html',
  styleUrls: ['./server-settings-dialog-component.scss'],
})
export class ServerSettingsDialogComponent implements OnInit, OnDestroy {
  readonly tabs: Array<{ id: SettingsTab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'settings' },
    { id: 'roles', label: 'Roles', icon: 'security' },
    { id: 'members', label: 'Members', icon: 'group' },
    { id: 'channels', label: 'Channels', icon: 'tag' }
  ];

  readonly permissionControls: PermissionControl[] = [
    {
      key: 'ADMINISTRATOR',
      label: 'Administrator',
      description: 'Bypasses channel and role restrictions.',
      defaultValue: false
    },
    {
      key: 'MANAGE_SERVER',
      label: 'Manage Server',
      description: 'Can edit server overview settings.',
      defaultValue: false
    },
    {
      key: 'MANAGE_ROLES',
      label: 'Manage Roles',
      description: 'Can create, edit, and delete roles.',
      defaultValue: false
    },
    {
      key: 'MANAGE_CHANNELS',
      label: 'Manage Channels',
      description: 'Can create, edit, and delete channels.',
      defaultValue: false
    },
    {
      key: 'SEND_MESSAGES',
      label: 'Send Messages',
      description: 'Can post in text channels.',
      defaultValue: true
    },
    {
      key: 'READ_MESSAGE_HISTORY',
      label: 'Read Message History',
      description: 'Can read earlier channel messages.',
      defaultValue: true
    },
    {
      key: 'CONNECT',
      label: 'Connect',
      description: 'Can join voice channels.',
      defaultValue: true
    }
  ];

  readonly channelTypeOptions: ChannelTypeOption[] = [
    {
      value: ChannelType.Text,
      label: 'Text',
      icon: 'tag',
      description: 'Messages, rolls, notes, and table chat.',
      defaultIcon: 'tag'
    },
    {
      value: ChannelType.Call,
      label: 'Voice',
      icon: 'volume_up',
      description: 'Live party voice and video sessions.',
      defaultIcon: 'volume_up'
    }
  ];

  readonly channelPermissionControls: ChannelPermissionControl[] = [
    {
      key: 'READ_MESSAGE_HISTORY',
      label: 'View',
      icon: 'visibility',
      description: 'Can see the channel and read previous messages.'
    },
    {
      key: 'SEND_MESSAGES',
      label: 'Send',
      icon: 'chat',
      description: 'Can send messages in text channels.'
    },
    {
      key: 'CONNECT',
      label: 'Connect',
      icon: 'settings_voice',
      description: 'Can join voice channels.'
    }
  ];

  readonly channelPermissionStates: Array<{ value: ChannelPermissionState; label: string; icon: string }> = [
    { value: 'inherit', label: 'Inherit', icon: 'remove' },
    { value: 'allow', label: 'Allow', icon: 'check' },
    { value: 'deny', label: 'Deny', icon: 'close' }
  ];

  readonly materialIconTotal = MATERIAL_ICON_NAMES.length;
  readonly iconSearchLimit = 96;
  readonly unassignedRoleFilterId = '__unassigned__';
  readonly defaultMaterialIconNames = [
    'tag',
    'forum',
    'campaign',
    'auto_stories',
    'map',
    'shield',
    'casino',
    'volume_up',
    'lock',
    'announcement',
    'groups',
    'sports_esports',
    'menu_book',
    'explore',
    'travel_explore',
    'castle',
    'local_fire_department',
    'bolt',
    'pets',
    'psychology',
    'inventory_2',
    'event',
    'theater_comedy',
    'tips_and_updates'
  ];

  activeTab: SettingsTab = 'overview';

  settingsForm: FormGroup;
  roleForm: FormGroup;
  channelForm: FormGroup;

  serverDetails: IServer | null = null;
  isLoading = false;

  iconPreview: string | null = null;
  selectedFile: File | null = null;
  selectedRole: IRole | null = null;
  selectedChannel: IChannel | null = null;

  isCreating = false;
  isCreatingChannel = false;
  iconSearchTerm = '';
  memberSearchTerm = '';
  channelRoleSearchTerm = '';
  roleFilterId: string | null = null;
  savingMemberIds = new Set<string>();
  channelPermissionOverwrites: PermissionOverwrite[] = [];

  private pendingRoleSelectionId: string | null = null;
  private pendingChannelSelectionId: string | null = null;
  private readonly destroy$ = new Subject<void>();

  constructor(
    @Inject(MAT_DIALOG_DATA) public server: IServer,
    private fb: FormBuilder,
    private serverService: ServerService,
    private roleService: Role,
    private channelService: ChannelService,
    private snackBar: MatSnackBar,
    protected dialogRef: MatDialogRef<ServerSettingsDialogComponent>
  ) {
    this.settingsForm = this.fb.group({
      name: [server.name, [Validators.required, Validators.maxLength(80)]]
    });
    this.roleForm = this.initRoleForm();
    this.channelForm = this.initChannelForm();
    this.iconPreview = server.icon || null;
  }

  ngOnInit() {
    this.serverService.getServerDetailsObservable()
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        if (data?._id !== this.server._id) return;

        this.serverDetails = data;
        this.reconcileRoleSelection(data);
        this.reconcileChannelSelection(data);
      });

    void this.refreshData();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get manageableChannels(): IChannel[] {
    return (this.serverDetails?.channels ?? []).filter(channel => !this.isWhisperChannel(channel));
  }

  get textChannelCount(): number {
    return this.manageableChannels.filter(channel => channel.type === ChannelType.Text).length;
  }

  get voiceChannelCount(): number {
    return this.manageableChannels.filter(channel => channel.type === ChannelType.Call).length;
  }

  get roleCount(): number {
    return this.serverDetails?.roles?.length ?? 0;
  }

  get assignableRoles(): IRole[] {
    return (this.serverDetails?.roles ?? []).filter(role => !this.isEveryoneRoleName(role.name));
  }

  get channelAccessRoles(): IRole[] {
    return this.serverDetails?.roles ?? [];
  }

  get filteredChannelAccessRoles(): IRole[] {
    const query = this.normalizeSearch(this.channelRoleSearchTerm);
    if (!query) return this.channelAccessRoles;

    return this.channelAccessRoles.filter(role => role.name.toLowerCase().includes(query));
  }

  get filteredMembers(): ServerMember[] {
    const query = this.normalizeSearch(this.memberSearchTerm);
    return (this.serverDetails?.members ?? []).filter(member =>
      this.memberMatchesSearch(member, query) && this.memberMatchesRoleFilter(member)
    );
  }

  get memberCount(): number {
    return this.serverDetails?.members?.length ?? 0;
  }

  get assignedMemberCount(): number {
    return (this.serverDetails?.members ?? [])
      .filter(member => this.memberAssignedRoles(member).length > 0)
      .length;
  }

  get unassignedMemberCount(): number {
    return Math.max(this.memberCount - this.assignedMemberCount, 0);
  }

  get temporaryDmMemberCount(): number {
    return (this.serverDetails?.members ?? [])
      .filter(member => this.serverService.isTemporaryDmGrantActive(member.temporaryDm))
      .length;
  }

  get hasMemberFilters(): boolean {
    return !!this.memberSearchTerm || this.roleFilterId !== null;
  }

  get selectedChannelIcon(): string {
    const icon = this.channelForm.get('icon')?.value;
    return this.normalizeIconName(icon, this.defaultChannelIcon(this.selectedChannelType));
  }

  get selectedChannelType(): EditableChannelType {
    const type = this.channelForm.get('type')?.value;
    return this.isEditableChannelType(type) ? type : ChannelType.Text;
  }

  get visibleMaterialIcons(): readonly string[] {
    const query = this.normalizeIconSearch(this.iconSearchTerm);
    if (!query) {
      return this.defaultMaterialIconNames;
    }

    return MATERIAL_ICON_NAMES
      .map(icon => ({ icon, score: this.getIconSearchScore(icon, query) }))
      .filter(match => match.score >= 0)
      .sort((a, b) => a.score - b.score || a.icon.localeCompare(b.icon))
      .slice(0, this.iconSearchLimit)
      .map(match => match.icon);
  }

  get iconSearchSummary(): string {
    const query = this.normalizeIconSearch(this.iconSearchTerm);
    if (!query) {
      return `Suggested icons from ${this.materialIconTotal} available`;
    }

    const totalMatches = MATERIAL_ICON_NAMES.filter(
      icon => this.getIconSearchScore(icon, query) >= 0
    ).length;
    const visibleCount = Math.min(totalMatches, this.iconSearchLimit);
    return `Showing ${visibleCount} of ${totalMatches} matches`;
  }

  setTab(tab: SettingsTab) {
    this.activeTab = tab;
  }

  async refreshData() {
    await this.serverService.getServerDetails(this.server._id);
  }

  compareRoles(role1: unknown, role2: unknown): boolean {
    return this.resolveId(role1) === this.resolveId(role2);
  }

  enabledPermissionCount(role: IRole | null | undefined): number {
    if (!role?.permissions) return 0;
    return this.permissionControls.filter(permission => !!role.permissions[permission.key]).length;
  }

  memberRoleCount(member: ServerMember): number {
    return this.memberAssignedRoles(member).length;
  }

  memberUserId(member: ServerMember): string {
    return this.serverService.getMemberUserId(member);
  }

  memberUsername(member: ServerMember): string {
    const user = member.user as any;
    return user?.username ?? 'Unknown member';
  }

  memberAvatar(member: ServerMember): string {
    const user = member.user as any;
    return user?.profileIcon || 'assets/default-avatar.png';
  }

  memberCharacterCount(member: ServerMember): number {
    return member.characters?.length ?? 0;
  }

  memberAssignedRoles(member: ServerMember): IRole[] {
    const assignedRoleIds = new Set(this.memberRoleIds(member));
    return this.assignableRoles.filter(role => assignedRoleIds.has(role._id));
  }

  memberHasRole(member: ServerMember, role: IRole | string): boolean {
    const roleId = this.resolveId(role);
    return this.memberRoleIds(member).includes(roleId);
  }

  isMemberSaving(member: ServerMember): boolean {
    return this.savingMemberIds.has(this.memberUserId(member));
  }

  roleMemberCount(role: IRole): number {
    return (this.serverDetails?.members ?? [])
      .filter(member => this.memberHasRole(member, role))
      .length;
  }

  setMemberSearch(term: string) {
    this.memberSearchTerm = term;
  }

  setChannelRoleSearch(term: string) {
    this.channelRoleSearchTerm = term;
  }

  setRoleFilter(roleId: string | null) {
    this.roleFilterId = roleId;
  }

  clearMemberFilters() {
    this.memberSearchTerm = '';
    this.roleFilterId = null;
  }

  async toggleMemberRole(member: ServerMember, role: IRole) {
    if (this.isMemberSaving(member)) return;

    const memberId = this.memberUserId(member);
    if (!memberId) return;

    const previousRoleIds = this.memberRoleIds(member);
    const nextRoleIds = this.memberHasRole(member, role)
      ? previousRoleIds.filter(roleId => roleId !== role._id)
      : [...previousRoleIds, role._id];

    await this.setMemberRoles(member, nextRoleIds, previousRoleIds);
  }

  isEveryoneRole(role: IRole | null = this.selectedRole): boolean {
    return this.isEveryoneRoleName(role?.name);
  }

  createRole() {
    this.selectedRole = null;
    this.isCreating = true;
    this.roleForm = this.initRoleForm();
  }

  selectRole(role: IRole | null) {
    if (!role) {
      this.selectedRole = null;
      this.isCreating = false;
      this.roleForm = this.initRoleForm();
      return;
    }

    this.isCreating = false;
    this.selectedRole = role;
    this.roleForm = this.initRoleForm(role);
    this.roleForm.markAsPristine();
  }

  cancelRoleEdit() {
    if (this.isCreating) {
      this.selectRole(null);
      return;
    }

    if (this.selectedRole) {
      this.selectRole(this.selectedRole);
    }
  }

  onSaveRole() {
    if (this.roleForm.invalid || this.isLoading) {
      this.roleForm.markAllAsTouched();
      return;
    }

    if (!this.isCreating && !this.selectedRole?._id) return;

    const payload = this.buildRolePayload();
    const wasCreating = this.isCreating;
    const request$ = this.isCreating
      ? this.roleService.createRole(this.server._id, payload)
      : this.roleService.updateRole(this.server._id, this.selectedRole!._id, payload);

    this.isLoading = true;
    request$
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: savedRole => {
          this.pendingRoleSelectionId = savedRole?._id ?? this.selectedRole?._id ?? null;
          this.isCreating = false;
          this.roleForm.markAsPristine();
          this.snackBar.open(wasCreating ? 'Role created.' : 'Role saved.', 'OK', {
            duration: 2000
          });
          void this.refreshData();
        },
        error: () => {
          this.snackBar.open('Role save failed.', 'Close', { duration: 3000 });
        }
      });
  }

  deleteRole(roleId: string) {
    if (!roleId || this.isEveryoneRole()) return;
    if (!confirm(`Delete ${this.selectedRole?.name ?? 'this role'}?`)) return;

    this.isLoading = true;
    this.roleService.deleteRole(this.server._id, roleId)
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: () => {
          this.snackBar.open('Role deleted.', 'OK', { duration: 2000 });
          this.selectRole(null);
          void this.refreshData();
        },
        error: () => {
          this.snackBar.open('Role delete failed.', 'Close', { duration: 3000 });
        }
      });
  }

  async updateMemberRoles(userId: string, roles: unknown[]) {
    const roleIds = roles
      .map(role => this.resolveId(role))
      .filter((roleId): roleId is string => !!roleId);

    const member = this.serverDetails?.members?.find(candidate => this.memberUserId(candidate) === userId);
    if (member) {
      await this.setMemberRoles(member, roleIds, this.memberRoleIds(member));
      return;
    }

    try {
      await this.serverService.updateMemberRoles(this.server._id, userId, roleIds);
      this.snackBar.open('Member roles updated.', 'OK', { duration: 1500 });
    } catch {
      this.snackBar.open('Member role update failed.', 'Close', { duration: 3000 });
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.selectedFile = file;
    const reader = new FileReader();
    reader.onload = e => this.iconPreview = e.target?.result as string;
    reader.readAsDataURL(file);
  }

  async onSaveChanges() {
    if (this.settingsForm.invalid || this.isLoading) {
      this.settingsForm.markAllAsTouched();
      return;
    }

    this.isLoading = true;
    try {
      await this.serverService.updateServer(
        this.server._id,
        this.settingsForm.value.name,
        this.selectedFile
      );
      this.snackBar.open('Server updated.', 'Close', { duration: 2000 });
      this.selectedFile = null;
      this.settingsForm.markAsPristine();
    } catch {
      this.snackBar.open('Update failed.', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async onRefreshJoinCode() {
    if (!this.serverDetails?._id || this.isLoading) return;

    try {
      await this.serverService.refreshJoinCode(this.serverDetails._id);
      this.snackBar.open('Join code refreshed.', 'OK', { duration: 2000 });
    } catch {
      this.snackBar.open('Failed to refresh join code.', 'Close', { duration: 3000 });
    }
  }

  async copyJoinCode() {
    const joinCode = this.serverDetails?.joinCode;
    if (!joinCode) return;

    try {
      await navigator.clipboard.writeText(joinCode);
      this.snackBar.open('Join code copied.', 'OK', { duration: 1600 });
    } catch {
      this.snackBar.open('Could not copy join code.', 'Close', { duration: 2500 });
    }
  }

  discardOverviewChanges() {
    this.settingsForm.reset({
      name: this.serverDetails?.name ?? this.server.name
    });
    this.selectedFile = null;
    this.iconPreview = this.serverDetails?.icon || this.server.icon || null;
    this.settingsForm.markAsPristine();
  }

  selectChannel(channel: IChannel | null) {
    if (!channel || this.isWhisperChannel(channel)) {
      this.selectedChannel = null;
      this.isCreatingChannel = false;
      this.channelForm = this.initChannelForm();
      this.channelPermissionOverwrites = [];
      return;
    }

    this.isCreatingChannel = false;
    this.selectedChannel = channel;
    this.channelForm = this.initChannelForm(channel);
    this.channelPermissionOverwrites = this.normalizePermissionOverwrites(channel.permissionOverwrites);
    this.channelForm.markAsPristine();
  }

  createChannelMode() {
    this.selectedChannel = null;
    this.isCreatingChannel = true;
    this.channelForm = this.initChannelForm();
    this.channelPermissionOverwrites = [];
  }

  setChannelType(type: EditableChannelType) {
    const iconControl = this.channelForm.get('icon');
    const currentIcon = this.normalizeIconName(iconControl?.value, '');
    const defaultIcons = new Set(this.channelTypeOptions.map(option => option.defaultIcon));

    this.channelForm.patchValue({ type });

    if (!currentIcon || defaultIcons.has(currentIcon)) {
      iconControl?.setValue(this.defaultChannelIcon(type));
    }

    this.channelForm.markAsDirty();
  }

  setChannelIcon(icon: string) {
    this.channelForm.get('icon')?.setValue(icon);
    this.channelForm.markAsDirty();
  }

  setIconSearch(term: string) {
    this.iconSearchTerm = term;
  }

  selectMaterialIcon(icon: string) {
    this.setChannelIcon(icon);
    this.iconSearchTerm = icon;
  }

  formatIconLabel(icon: string): string {
    return icon.replace(/_/g, ' ');
  }

  getChannelPermissionState(role: IRole, permission: ChannelPermissionKey): ChannelPermissionState {
    const overwrite = this.channelPermissionOverwrites
      .find(candidate => this.resolveId(candidate.role) === role._id);

    if (overwrite?.deny?.includes(permission)) return 'deny';
    if (overwrite?.allow?.includes(permission)) return 'allow';
    return 'inherit';
  }

  setChannelPermissionState(
    role: IRole,
    permission: ChannelPermissionKey,
    state: ChannelPermissionState
  ) {
    const roleId = role._id;
    if (!roleId) return;

    const nextOverwrites = this.normalizePermissionOverwrites(this.channelPermissionOverwrites);
    let overwrite = nextOverwrites.find(candidate => this.resolveId(candidate.role) === roleId);

    if (!overwrite) {
      overwrite = { role: roleId, allow: [], deny: [] };
      nextOverwrites.push(overwrite);
    }

    overwrite.allow = (overwrite.allow ?? []).filter(value => value !== permission);
    overwrite.deny = (overwrite.deny ?? []).filter(value => value !== permission);

    if (state === 'allow') overwrite.allow.push(permission);
    if (state === 'deny') overwrite.deny.push(permission);

    this.channelPermissionOverwrites = nextOverwrites
      .map(candidate => ({
        role: this.resolveId(candidate.role),
        allow: [...new Set(candidate.allow ?? [])],
        deny: [...new Set(candidate.deny ?? [])]
      }))
      .filter(candidate => candidate.role && (candidate.allow.length || candidate.deny.length));

    this.channelForm.markAsDirty();
  }

  getChannelIcon(channel: IChannel | null | undefined): string {
    return this.normalizeIconName(channel?.icon, this.defaultChannelIcon(channel?.type));
  }

  channelTypeLabel(type: string | ChannelType | null | undefined): string {
    const option = this.channelTypeOptions.find(channelType => channelType.value === type);
    return option?.label ?? 'Channel';
  }

  onSaveChannel() {
    if (this.channelForm.invalid || this.isLoading) {
      this.channelForm.markAllAsTouched();
      return;
    }

    if (!this.isCreatingChannel && !this.selectedChannel?._id) return;

    const payload = this.buildChannelPayload();
    const wasCreating = this.isCreatingChannel;
    const request$ = this.isCreatingChannel
      ? this.channelService.createChannel(this.server._id, payload)
      : this.channelService.updateChannel(this.server._id, this.selectedChannel!._id!, payload);

    this.isLoading = true;
    request$
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: savedChannel => {
          this.pendingChannelSelectionId = savedChannel?._id ?? this.selectedChannel?._id ?? null;
          this.isCreatingChannel = false;
          this.channelForm.markAsPristine();
          this.snackBar.open(wasCreating ? 'Channel created.' : 'Channel saved.', 'OK', {
            duration: 2000
          });
          void this.refreshData();
        },
        error: () => {
          this.snackBar.open('Channel save failed.', 'Close', { duration: 3000 });
        }
      });
  }

  onDeleteChannel() {
    if (!this.selectedChannel?._id || this.isWhisperChannel(this.selectedChannel)) return;
    if (!confirm(`Delete #${this.selectedChannel.name}?`)) return;

    this.isLoading = true;
    this.channelService.deleteChannel(this.server._id, this.selectedChannel._id)
      .pipe(finalize(() => (this.isLoading = false)))
      .subscribe({
        next: () => {
          this.snackBar.open('Channel deleted.', 'OK', { duration: 2000 });
          this.selectChannel(null);
          void this.refreshData();
        },
        error: () => {
          this.snackBar.open('Channel delete failed.', 'Close', { duration: 3000 });
        }
      });
  }

  cancelChannelEdit() {
    if (this.isCreatingChannel) {
      this.selectChannel(null);
      return;
    }

    if (this.selectedChannel) {
      this.selectChannel(this.selectedChannel);
    }
  }

  async onDeleteServer() {
    if (!confirm(`Delete ${this.server.name}?`)) return;
    await this.serverService.deleteServer(this.server._id);
    this.dialogRef.close(true);
  }

  async onLeaveServer() {
    if (!confirm(`Leave ${this.server.name}?`)) return;
    await this.serverService.leaveServer(this.server._id);
    this.dialogRef.close(true);
  }

  private initRoleForm(role?: IRole | null): FormGroup {
    const permissions = this.buildPermissions(role?.permissions);

    return this.fb.group({
      name: [role?.name ?? '', [Validators.required, Validators.maxLength(60)]],
      color: [role?.color ?? '#99AAB5', Validators.required],
      hoist: [role?.hoist ?? false],
      ADMINISTRATOR: [permissions.ADMINISTRATOR],
      MANAGE_SERVER: [permissions.MANAGE_SERVER],
      MANAGE_CHANNELS: [permissions.MANAGE_CHANNELS],
      MANAGE_ROLES: [permissions.MANAGE_ROLES],
      SEND_MESSAGES: [permissions.SEND_MESSAGES],
      READ_MESSAGE_HISTORY: [permissions.READ_MESSAGE_HISTORY],
      CONNECT: [permissions.CONNECT]
    });
  }

  private initChannelForm(channel?: IChannel | null): FormGroup {
    const type = this.isEditableChannelType(channel?.type) ? channel.type : ChannelType.Text;

    return this.fb.group({
      name: [channel?.name ?? '', [Validators.required, Validators.maxLength(100)]],
      type: [type, Validators.required],
      icon: [
        this.normalizeIconName(channel?.icon, this.defaultChannelIcon(type)),
        [Validators.required, Validators.maxLength(64)]
      ]
    });
  }

  private buildRolePayload(): IRolePayload {
    const value = this.roleForm.getRawValue();
    const permissions = this.permissionControls.reduce((acc, permission) => {
      acc[permission.key] = !!value[permission.key];
      return acc;
    }, {} as RolePermissions);

    return {
      name: String(value.name ?? '').trim(),
      color: value.color,
      hoist: !!value.hoist,
      permissions
    };
  }

  private buildChannelPayload(): Pick<IChannel, 'name' | 'type' | 'icon'> & { permissionOverwrites: PermissionOverwrite[] } {
    const value = this.channelForm.getRawValue();
    const type = this.isEditableChannelType(value.type) ? value.type : ChannelType.Text;

    return {
      name: String(value.name ?? '').trim(),
      type,
      icon: this.normalizeIconName(value.icon, this.defaultChannelIcon(type)),
      permissionOverwrites: this.normalizePermissionOverwrites(this.channelPermissionOverwrites)
    };
  }

  private buildPermissions(permissions: Partial<RolePermissions> | null | undefined): RolePermissions {
    return this.permissionControls.reduce((acc, permission) => {
      acc[permission.key] = permissions?.[permission.key] ?? permission.defaultValue;
      return acc;
    }, {} as RolePermissions);
  }

  private reconcileRoleSelection(server: IServer) {
    const targetRoleId = this.pendingRoleSelectionId ?? this.selectedRole?._id;
    if (!targetRoleId || this.isCreating) return;

    const refreshedRole = server.roles?.find(role => role._id === targetRoleId) ?? null;
    this.pendingRoleSelectionId = null;

    if (!refreshedRole) {
      this.selectRole(null);
      return;
    }

    this.selectedRole = refreshedRole;
    if (!this.roleForm.dirty) {
      this.roleForm = this.initRoleForm(refreshedRole);
      this.roleForm.markAsPristine();
    }
  }

  private reconcileChannelSelection(server: IServer) {
    const targetChannelId = this.pendingChannelSelectionId ?? this.selectedChannel?._id;
    if (!targetChannelId || this.isCreatingChannel) return;

    const refreshedChannel = server.channels
      ?.filter(channel => !this.isWhisperChannel(channel))
      .find(channel => channel._id === targetChannelId) ?? null;

    this.pendingChannelSelectionId = null;

    if (!refreshedChannel) {
      this.selectChannel(null);
      return;
    }

    this.selectedChannel = refreshedChannel;
    if (!this.channelForm.dirty) {
      this.channelForm = this.initChannelForm(refreshedChannel);
      this.channelPermissionOverwrites = this.normalizePermissionOverwrites(refreshedChannel.permissionOverwrites);
      this.channelForm.markAsPristine();
    }
  }

  private defaultChannelIcon(type: string | ChannelType | null | undefined): string {
    return type === ChannelType.Call ? 'volume_up' : 'tag';
  }

  private normalizeIconName(value: unknown, fallback: string): string {
    const icon = String(value ?? '').trim().replace(/\s+/g, '_');
    return icon || fallback;
  }

  private normalizeIconSearch(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  private normalizeSearch(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
  }

  private memberRoleIds(member: ServerMember): string[] {
    return (member.roles ?? [])
      .map(role => this.resolveId(role))
      .filter((roleId): roleId is string => !!roleId);
  }

  private memberMatchesSearch(member: ServerMember, query: string): boolean {
    if (!query) return true;

    const assignedRoleNames = this.memberAssignedRoles(member)
      .map(role => role.name)
      .join(' ');
    const characterNames = (member.characters ?? [])
      .map(character => character.name)
      .join(' ');
    const searchable = `${this.memberUsername(member)} ${assignedRoleNames} ${characterNames}`.toLowerCase();

    return searchable.includes(query);
  }

  private memberMatchesRoleFilter(member: ServerMember): boolean {
    if (!this.roleFilterId) return true;
    if (this.roleFilterId === this.unassignedRoleFilterId) {
      return this.memberAssignedRoles(member).length === 0;
    }

    return this.memberHasRole(member, this.roleFilterId);
  }

  private normalizePermissionOverwrites(overwrites: PermissionOverwrite[] | null | undefined): PermissionOverwrite[] {
    const permissionKeys = new Set(this.channelPermissionControls.map(permission => permission.key));
    const normalizedByRole = new Map<string, PermissionOverwrite>();

    (overwrites ?? []).forEach(overwrite => {
      const roleId = this.resolveId(overwrite?.role);
      if (!roleId) return;

      const deny = [...new Set(overwrite?.deny ?? [])]
        .filter(permission => permissionKeys.has(permission as ChannelPermissionKey));
      const allow = [...new Set(overwrite?.allow ?? [])]
        .filter(permission => permissionKeys.has(permission as ChannelPermissionKey) && !deny.includes(permission));

      if (allow.length || deny.length) {
        normalizedByRole.set(roleId, { role: roleId, allow, deny });
      }
    });

    return Array.from(normalizedByRole.values());
  }

  private isEveryoneRoleName(name: string | null | undefined): boolean {
    const normalizedName = String(name ?? '').trim().toLowerCase();
    return normalizedName === '@everyone' || normalizedName === 'everyone';
  }

  private async setMemberRoles(
    member: ServerMember,
    roleIds: string[],
    previousRoleIds: string[]
  ) {
    const memberId = this.memberUserId(member);
    if (!memberId || !this.serverDetails) return;

    this.savingMemberIds.add(memberId);
    this.applyLocalMemberRoles(memberId, roleIds);

    try {
      await this.serverService.updateMemberRoles(this.server._id, memberId, roleIds);
      this.snackBar.open('Member roles updated.', 'OK', { duration: 1500 });
    } catch {
      this.applyLocalMemberRoles(memberId, previousRoleIds);
      this.snackBar.open('Member role update failed.', 'Close', { duration: 3000 });
    } finally {
      this.savingMemberIds.delete(memberId);
    }
  }

  private applyLocalMemberRoles(memberId: string, roleIds: string[]) {
    if (!this.serverDetails) return;

    this.serverDetails = {
      ...this.serverDetails,
      members: this.serverDetails.members.map(member =>
        this.memberUserId(member) === memberId
          ? { ...member, roles: [...roleIds] }
          : member
      )
    };
  }

  private getIconSearchScore(icon: string, query: string): number {
    const compactIcon = icon.replace(/_/g, '');
    const compactQuery = query.replace(/_/g, '');

    if (icon === query || compactIcon === compactQuery) return 0;
    if (icon.startsWith(query) || compactIcon.startsWith(compactQuery)) return 1;
    if (icon.split('_').some(part => part.startsWith(query))) return 2;
    if (icon.includes(query) || compactIcon.includes(compactQuery)) return 3;

    return -1;
  }

  private isEditableChannelType(type: unknown): type is EditableChannelType {
    return type === ChannelType.Text || type === ChannelType.Call;
  }

  private isWhisperChannel(channel: IChannel | null | undefined): boolean {
    return channel?.type === ChannelType.Whisper;
  }

  private resolveId(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && '_id' in value) {
      const id = (value as { _id?: unknown })._id;
      return typeof id === 'string' ? id : '';
    }
    return '';
  }
}

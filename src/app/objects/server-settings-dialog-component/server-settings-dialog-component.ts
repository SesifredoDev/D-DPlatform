import { Component, ElementRef, Inject, OnDestroy, OnInit, viewChild } from '@angular/core';
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
import { MatSelectModule } from '@angular/material/select';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Subject, finalize, takeUntil } from 'rxjs';

import { ServerService } from '../../shared/services/server/server';
import { ChannelService } from '../../shared/services/channel/channel';
import { HomebrewPackService } from '../../shared/services/homebrew-pack/homebrew-pack.service';
import { IServer, IServerTheme, ServerMember } from '../../shared/models/server/server.model';
import { ChannelType, IChannel, PermissionOverwrite } from '../../shared/models/server/channel.model';
import { IRole, RolePermissions } from '../../shared/models/server/role.model';
import { IRolePayload, Role } from '../../shared/services/role/role';
import { MATERIAL_ICON_NAMES } from '../../shared/constants/material-icon-names';
import {
  SERVER_THEME_FONT_OPTIONS,
  normalizeServerTheme
} from '../../shared/services/theme/theme.service';
import type { SettingsTab, ServerDangerAction, EditableChannelType, ChannelPermissionKey, ChannelPermissionState, PermissionControl, ChannelTypeOption, ChannelPermissionControl } from '../../shared/models/objects/server-settings-dialog-component/server-settings-dialog-component.model';
import { IHomebrewPack, IHomebrewPackItem } from '../../shared/models/homebrew-pack/homebrew-pack.model';

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
    MatTooltipModule,
    MatSelectModule,
    MatPaginatorModule
  ],
  templateUrl: './server-settings-dialog-component.html',
  styleUrls: ['./server-settings-dialog-component.scss'],
})
export class ServerSettingsDialogComponent implements OnInit, OnDestroy {
  readonly tabs: Array<{ id: SettingsTab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: 'settings' },
    { id: 'roles', label: 'Roles', icon: 'security' },
    { id: 'members', label: 'Members', icon: 'group' },
    { id: 'channels', label: 'Channels', icon: 'tag' },
    { id: 'homebrew-packs', label: 'Modpacks', icon: 'extension' }
  ];

  readonly permissionControls: PermissionControl[] = [
    { key: 'ADMINISTRATOR', label: 'Administrator', description: 'Bypasses channel and role restrictions.', defaultValue: false },
    { key: 'MANAGE_SERVER', label: 'Manage Server', description: 'Can edit server overview settings.', defaultValue: false },
    { key: 'MANAGE_ROLES', label: 'Manage Roles', description: 'Can create, edit, and delete roles.', defaultValue: false },
    { key: 'MANAGE_CHANNELS', label: 'Manage Channels', description: 'Can create, edit, and delete channels.', defaultValue: false },
    { key: 'SEND_MESSAGES', label: 'Send Messages', description: 'Can post in text channels.', defaultValue: true },
    { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', description: 'Can read earlier channel messages.', defaultValue: true },
    { key: 'CONNECT', label: 'Connect', description: 'Can join voice channels.', defaultValue: true }
  ];

  readonly channelTypeOptions: ChannelTypeOption[] = [
    { value: ChannelType.Text, label: 'Text', icon: 'tag', description: 'Messages, rolls, notes, and table chat.', defaultIcon: 'tag' },
    { value: ChannelType.Call, label: 'Voice', icon: 'volume_up', description: 'Live party voice and video sessions.', defaultIcon: 'volume_up' }
  ];

  readonly channelPermissionControls: ChannelPermissionControl[] = [
    { key: 'READ_MESSAGE_HISTORY', label: 'View', icon: 'visibility', description: 'Can see the channel and read previous messages.' },
    { key: 'SEND_MESSAGES', label: 'Send', icon: 'chat', description: 'Can send messages in text channels.' },
    { key: 'CONNECT', label: 'Connect', icon: 'settings_voice', description: 'Can join voice channels.' }
  ];

  readonly channelPermissionStates: Array<{ value: ChannelPermissionState; label: string; icon: string }> = [
    { value: 'inherit', label: 'Inherit', icon: 'remove' },
    { value: 'allow', label: 'Allow', icon: 'check' },
    { value: 'deny', label: 'Deny', icon: 'close' }
  ];

  readonly materialIconTotal = MATERIAL_ICON_NAMES.length;
  readonly fontOptions = SERVER_THEME_FONT_OPTIONS;
  readonly iconSearchLimit = 96;
  readonly unassignedRoleFilterId = '__unassigned__';
  readonly defaultMaterialIconNames = [
    'tag', 'forum', 'campaign', 'auto_stories', 'map', 'shield', 'casino', 'volume_up', 'lock'
  ];

  activeTab: SettingsTab = 'overview';
  pendingServerAction: ServerDangerAction | null = null;
  deleteConfirmationText = '';

  settingsForm: FormGroup;
  roleForm: FormGroup;
  channelForm: FormGroup;
  packForm: FormGroup;

  serverDetails: IServer | null = null;
  isLoading = false;

  iconPreview: string | null = null;
  selectedFile: File | null = null;
  backgroundImagePreview: string | null = null;
  selectedBackgroundImageFile: File | null = null;
  selectedRole: IRole | null = null;
  selectedChannel: IChannel | null = null;

  // Homebrew Pack state
  selectedPack: IHomebrewPack | null = null;
  isCreatingPack = false;
  packItems: IHomebrewPackItem[] = [];

  // Pack item list view state (keeps the DOM small for very large packs)
  readonly packPageSizeOptions = [10, 25, 50, 100];
  packPageSize = 25;
  packPageIndex = 0;
  packItemFilter = '';
  /** Absolute indices into packItems for the cards currently rendered. */
  visiblePackItemIndices: number[] = [];
  /** Number of items matching the filter (or all items when there is no filter). */
  filteredPackItemCount = 0;

  private filteredPackItemIndices: number[] | null = null;
  private packFilterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Items already copied for editing (copy-on-write; see editablePackItem). */
  private ownedPackItems = new WeakSet<object>();
  private readonly packItemsTop = viewChild<ElementRef<HTMLElement>>('packItemsTop');

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
    public homebrewPackService: HomebrewPackService,
    private snackBar: MatSnackBar,
    protected dialogRef: MatDialogRef<ServerSettingsDialogComponent>
  ) {
    const initialTheme = normalizeServerTheme(server.defaultTheme);
    this.settingsForm = this.fb.group({
      name: [server.name, [Validators.required, Validators.maxLength(80)]],
      themeBackgroundColor: [initialTheme.backgroundColor, [Validators.required, Validators.pattern(/^#[0-9a-fA-F]{6}$/)]],
      themeTextColor: [initialTheme.textColor, [Validators.required, Validators.pattern(/^#[0-9a-fA-F]{6}$/)]],
      themeFontFamily: [initialTheme.fontFamily, Validators.required],
      themeBackgroundImage: [initialTheme.backgroundImage],
      themeBackgroundImageBlur: [initialTheme.backgroundImageBlur]
    });
    this.roleForm = this.initRoleForm();
    this.channelForm = this.initChannelForm();
    this.packForm = this.initPackForm();
    this.iconPreview = server.icon || null;
    this.backgroundImagePreview = initialTheme.backgroundImage;
  }

  ngOnInit() {
    this.serverService.getServerDetailsObservable()
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        if (data?._id !== this.server._id) return;
        this.serverDetails = data;
        this.syncOverviewForm(data);
        this.reconcileRoleSelection(data);
        this.reconcileChannelSelection(data);
      });

    void this.refreshData();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get allModpacks(): IHomebrewPack[] {
    return this.homebrewPackService.packs();
  }

  get attachedModpacksCount(): number {
    return this.allModpacks.filter(p => p.attachedServerIds?.includes(this.server._id)).length;
  }

  get manageableChannels(): IChannel[] {
    return (this.serverDetails?.channels ?? []).filter(channel => !this.isWhisperChannel(channel));
  }

  get roleCount(): number {
    return this.serverDetails?.roles?.length ?? 0;
  }

  get serverDisplayName(): string {
    return this.serverDetails?.name || this.server.name;
  }

  get dangerActionTitle(): string {
    return this.pendingServerAction === 'delete' ? 'Delete this server?' : 'Leave this server?';
  }

  get dangerActionDescription(): string {
    if (this.pendingServerAction === 'delete') {
      return `This permanently deletes ${this.serverDisplayName} and removes access for every member. This cannot be undone.`;
    }
    return `You will leave ${this.serverDisplayName} and lose access unless someone invites you back.`;
  }

  get dangerActionIcon(): string {
    return this.pendingServerAction === 'delete' ? 'delete_forever' : 'logout';
  }

  get dangerActionConfirmLabel(): string {
    return this.pendingServerAction === 'delete' ? 'Delete Server' : 'Leave Server';
  }

  get canConfirmServerDangerAction(): boolean {
    if (!this.pendingServerAction || this.isLoading) return false;
    if (this.pendingServerAction === 'delete') {
      return this.deleteConfirmationText.trim().toLowerCase() === 'delete';
    }
    return true;
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
    if (!query) return this.defaultMaterialIconNames;

    return MATERIAL_ICON_NAMES
      .map(icon => ({ icon, score: this.getIconSearchScore(icon, query) }))
      .filter(match => match.score >= 0)
      .sort((a, b) => a.score - b.score || a.icon.localeCompare(b.icon))
      .slice(0, this.iconSearchLimit)
      .map(match => match.icon);
  }

  get iconSearchSummary(): string {
    const query = this.normalizeIconSearch(this.iconSearchTerm);
    if (!query) return `Suggested icons from ${this.materialIconTotal} available`;

    const totalMatches = MATERIAL_ICON_NAMES.filter(
      icon => this.getIconSearchScore(icon, query) >= 0
    ).length;
    const visibleCount = Math.min(totalMatches, this.iconSearchLimit);
    return `Showing ${visibleCount} of ${totalMatches} matches`;
  }

  get themePreviewStyles(): Record<string, string> {
    const theme = this.getThemeFormValue();
    const image = this.themeBackgroundImagePreview;
    return {
      background: image
        ? `${theme.backgroundColor} ${this.toCssImageValue(image)} center / cover no-repeat`
        : theme.backgroundColor,
      color: theme.textColor,
      'font-family': theme.fontFamily
    };
  }

  get themeBackgroundImagePreview(): string | null {
    return this.backgroundImagePreview || this.settingsForm.get('themeBackgroundImage')?.value || null;
  }

  get themeBackgroundImagePreviewStyle(): string {
    return this.toCssImageValue(this.themeBackgroundImagePreview);
  }

  get hasThemeBackgroundImage(): boolean {
    return !!this.themeBackgroundImagePreview;
  }

  setTab(tab: SettingsTab) {
    this.activeTab = tab;
  }

  async refreshData() {
    await this.serverService.getServerDetails(this.server._id);
    await this.homebrewPackService.loadPacks();
  }

  // --- Homebrew Pack Methods ---
  isPackAttached(pack: IHomebrewPack): boolean {
    return pack.attachedServerIds?.includes(this.server._id) ?? false;
  }

  async togglePackAttachment(pack: IHomebrewPack, attach: boolean) {
    await this.homebrewPackService.toggleServerAttachment(pack.id, this.server._id, attach);
    this.snackBar.open(
      attach ? `Attached "${pack.name}" to server.` : `Detached "${pack.name}" from server.`,
      'OK',
      { duration: 2000 }
    );
  }

  selectPack(pack: IHomebrewPack, preserveView = false) {
    this.isCreatingPack = false;
    this.selectedPack = pack;
    // Shallow copy only: deep-cloning tens of thousands of items up front froze the UI.
    // Individual items are copied lazily the first time they are edited.
    this.packItems = [...(pack.items || [])];
    this.ownedPackItems = new WeakSet();
    this.packForm = this.initPackForm(pack);
    if (preserveView) {
      this.applyPackItemFilter(false);
    } else {
      this.resetPackItemView();
    }
  }

  createNewPack() {
    this.selectedPack = null;
    this.isCreatingPack = true;
    this.packItems = [];
    this.ownedPackItems = new WeakSet();
    this.packForm = this.initPackForm();
    this.resetPackItemView();
  }

  cancelPackEdit() {
    if (this.isCreatingPack) {
      this.selectedPack = null;
      this.isCreatingPack = false;
    } else if (this.selectedPack) {
      this.selectPack(this.selectedPack);
    }
  }

  async onSavePack() {
    if (this.packForm.invalid) return;

    const val = this.packForm.value;
    const packToSave: IHomebrewPack = {
      id: this.selectedPack?.id || `pack_${Date.now()}`,
      name: val.name,
      version: val.version,
      author: val.author,
      description: val.description,
      attachedServerIds: this.selectedPack?.attachedServerIds || [this.server._id],
      items: this.packItems,
      createdAt: this.selectedPack?.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    this.isLoading = true;
    // Let the disabled state paint before the (potentially heavy) stringify + IPC call.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      await this.homebrewPackService.savePack(packToSave);
      this.snackBar.open('Homebrew pack saved locally.', 'OK', { duration: 2000 });
      this.selectPack(packToSave, true);
    } catch (error) {
      console.error('Failed to save homebrew pack', error);
      this.snackBar.open('Failed to save pack.', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async onDeletePack(packId: string) {
    if (!confirm('Are you sure you want to delete this homebrew pack?')) return;
    await this.homebrewPackService.deletePack(packId);
    this.selectedPack = null;
    this.isCreatingPack = false;
    this.snackBar.open('Homebrew pack deleted.', 'OK', { duration: 2000 });
  }

  onImportPackFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const rawJson = e.target?.result as string;
        const pack = JSON.parse(rawJson) as IHomebrewPack;
        if (!pack.name || !Array.isArray(pack.items)) {
          throw new Error('Invalid pack schema.');
        }
        pack.id = pack.id || `pack_${Date.now()}`;
        pack.attachedServerIds = pack.attachedServerIds || [this.server._id];
        await this.homebrewPackService.savePack(pack);
        this.selectPack(pack);
        this.snackBar.open('Modpack imported successfully!', 'OK', { duration: 2000 });
      } catch (err) {
        this.snackBar.open('Failed to import pack file. Invalid JSON.', 'Close', { duration: 3000 });
      }
    };
    reader.readAsText(file);
  }

  addPackItem() {
    const item: IHomebrewPackItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: 'New Custom Item',
      description: 'Markdown item description...',
      properties: { type: 'item', rarity: 'common' }
    };
    this.ownedPackItems.add(item);
    this.packItems.push(item);
    this.packForm.markAsDirty();

    // Clear the filter and jump to the last page so the new item is visible.
    this.packItemFilter = '';
    this.filteredPackItemIndices = null;
    this.packPageIndex = Math.floor((this.packItems.length - 1) / this.packPageSize);
    this.refreshVisiblePackItems();
    this.scrollPackItemsIntoView();
  }

  removePackItem(index: number) {
    this.packItems.splice(index, 1);
    this.packForm.markAsDirty();
    // Indices shifted, so any cached filter result is stale.
    this.applyPackItemFilter(false);
  }

  updateItemField(index: number, field: keyof IHomebrewPackItem, value: any) {
    (this.editablePackItem(index) as any)[field] = value;
    this.packForm.markAsDirty();
  }

  getItemPropertiesArray(index: number): Array<{ key: string; value: string }> {
    const props = this.packItems[index]?.properties || {};
    return Object.entries(props).map(([key, value]) => ({ key, value: String(value) }));
  }

  addItemProperty(index: number) {
    const item = this.editablePackItem(index);
    const propCount = Object.keys(item.properties).length;
    item.properties[`key_${propCount + 1}`] = 'value';
    this.packForm.markAsDirty();
  }

  removeItemProperty(index: number, key: string) {
    delete this.editablePackItem(index).properties[key];
    this.packForm.markAsDirty();
  }

  updateItemPropertyKey(index: number, oldKey: string, newKey: string) {
    if (!newKey || oldKey === newKey) return;
    const props = this.editablePackItem(index).properties;
    const value = props[oldKey];
    delete props[oldKey];
    props[newKey] = value;
    this.packForm.markAsDirty();
  }

  updateItemPropertyValue(index: number, key: string, value: string) {
    this.editablePackItem(index).properties[key] = value;
    this.packForm.markAsDirty();
  }

  // --- Pack item paging / filtering ---

  onPackItemFilterInput(value: string) {
    this.packItemFilter = value;
    if (this.packFilterTimer) clearTimeout(this.packFilterTimer);
    // Debounce so typing in a 30k+ item pack doesn't re-scan on every keystroke.
    this.packFilterTimer = setTimeout(() => this.applyPackItemFilter(true), 200);
  }

  onPackItemPage(event: PageEvent) {
    this.packPageSize = event.pageSize;
    this.packPageIndex = event.pageIndex;
    this.refreshVisiblePackItems();
    this.scrollPackItemsIntoView();
  }

  private resetPackItemView() {
    this.packItemFilter = '';
    this.filteredPackItemIndices = null;
    this.packPageIndex = 0;
    this.refreshVisiblePackItems();
  }

  private applyPackItemFilter(resetPage: boolean) {
    const query = this.normalizeSearch(this.packItemFilter);
    if (!query) {
      this.filteredPackItemIndices = null;
    } else {
      const matches: number[] = [];
      for (let i = 0; i < this.packItems.length; i++) {
        if (this.packItemMatches(this.packItems[i], query)) matches.push(i);
      }
      this.filteredPackItemIndices = matches;
    }
    if (resetPage) this.packPageIndex = 0;
    this.refreshVisiblePackItems();
  }

  private packItemMatches(item: IHomebrewPackItem, query: string): boolean {
    if (item.name?.toLowerCase().includes(query)) return true;
    if (item.description?.toLowerCase().includes(query)) return true;
    for (const [key, value] of Object.entries(item.properties ?? {})) {
      if (key.toLowerCase().includes(query) || String(value).toLowerCase().includes(query)) return true;
    }
    return false;
  }

  private refreshVisiblePackItems() {
    const total = this.filteredPackItemIndices ? this.filteredPackItemIndices.length : this.packItems.length;
    this.filteredPackItemCount = total;

    const pageCount = Math.max(1, Math.ceil(total / this.packPageSize));
    this.packPageIndex = Math.min(this.packPageIndex, pageCount - 1);

    const start = this.packPageIndex * this.packPageSize;
    const end = Math.min(start + this.packPageSize, total);
    const indices: number[] = [];
    for (let i = start; i < end; i++) {
      indices.push(this.filteredPackItemIndices ? this.filteredPackItemIndices[i] : i);
    }
    this.visiblePackItemIndices = indices;
  }

  private scrollPackItemsIntoView() {
    setTimeout(() => this.packItemsTop()?.nativeElement.scrollIntoView({ block: 'start' }));
  }

  /**
   * Copy-on-write: the working list shares item objects with the live pack state until an item
   * is first edited, at which point that single item is cloned so the live state is never mutated.
   */
  private editablePackItem(index: number): IHomebrewPackItem {
    const item = this.packItems[index];
    if (this.ownedPackItems.has(item)) return item;
    const copy: IHomebrewPackItem = { ...item, properties: { ...(item.properties ?? {}) } };
    this.packItems[index] = copy;
    this.ownedPackItems.add(copy);
    return copy;
  }

  private initPackForm(pack?: IHomebrewPack | null): FormGroup {
    return this.fb.group({
      name: [pack?.name ?? '', Validators.required],
      version: [pack?.version ?? '1.0.0', Validators.required],
      author: [pack?.author ?? '', Validators.required],
      description: [pack?.description ?? '']
    });
  }

  // --- End Homebrew Pack Methods ---

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
          this.snackBar.open(wasCreating ? 'Role created.' : 'Role saved.', 'OK', { duration: 2000 });
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

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.selectedFile = file;
    const reader = new FileReader();
    reader.onload = e => this.iconPreview = e.target?.result as string;
    reader.readAsDataURL(file);
  }

  onThemeBackgroundImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.selectedBackgroundImageFile = file;
    input.value = '';
    const reader = new FileReader();
    reader.onload = e => {
      this.backgroundImagePreview = e.target?.result as string;
      this.settingsForm.markAsDirty();
    };
    reader.readAsDataURL(file);
  }

  clearThemeBackgroundImage(input?: HTMLInputElement) {
    this.selectedBackgroundImageFile = null;
    this.backgroundImagePreview = null;
    this.settingsForm.get('themeBackgroundImage')?.setValue(null);
    this.settingsForm.markAsDirty();

    if (input) {
      input.value = '';
    }
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
        this.selectedFile,
        this.getThemeFormValue(),
        this.selectedBackgroundImageFile
      );
      this.snackBar.open('Server updated.', 'Close', { duration: 2000 });
      this.selectedFile = null;
      this.selectedBackgroundImageFile = null;
      const refreshedServer = this.serverService.getCurrentServer();
      if (refreshedServer?._id === this.server._id) {
        this.serverDetails = refreshedServer;
        this.resetOverviewForm(refreshedServer);
      } else {
        this.settingsForm.markAsPristine();
      }
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
    this.selectedFile = null;
    this.selectedBackgroundImageFile = null;
    this.resetOverviewForm(this.serverDetails ?? this.server);
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
          this.snackBar.open(wasCreating ? 'Channel created.' : 'Channel saved.', 'OK', { duration: 2000 });
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

  onDeleteServer() {
    this.openServerDangerOverlay('delete');
  }

  onLeaveServer() {
    this.openServerDangerOverlay('leave');
  }

  openServerDangerOverlay(action: ServerDangerAction) {
    if (this.isLoading) return;

    this.pendingServerAction = action;
    this.deleteConfirmationText = '';
  }

  closeServerDangerOverlay() {
    if (this.isLoading) return;

    this.pendingServerAction = null;
    this.deleteConfirmationText = '';
  }

  setDeleteConfirmationText(value: string) {
    this.deleteConfirmationText = value;
  }

  async confirmServerDangerAction() {
    if (!this.pendingServerAction || !this.canConfirmServerDangerAction) return;

    const action = this.pendingServerAction;
    this.isLoading = true;

    try {
      if (action === 'delete') {
        await this.serverService.deleteServer(this.server._id);
      } else {
        await this.serverService.leaveServer(this.server._id);
      }

      this.dialogRef.close(true);
    } catch {
      this.snackBar.open(
        action === 'delete' ? 'Server delete failed.' : 'Could not leave server.',
        'Close',
        { duration: 3000 }
      );
    } finally {
      this.isLoading = false;
    }
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

  private syncOverviewForm(server: IServer) {
    if (this.settingsForm.dirty || this.selectedFile || this.selectedBackgroundImageFile) return;

    this.resetOverviewForm(server);
  }

  private resetOverviewForm(server: IServer) {
    const themeValues = this.getThemeFormResetValue(server.defaultTheme);
    this.settingsForm.reset({
      name: server.name,
      ...themeValues
    });
    this.iconPreview = server.icon || null;
    this.backgroundImagePreview = themeValues.themeBackgroundImage;
    this.settingsForm.markAsPristine();
  }

  private getThemeFormValue(): IServerTheme {
    const value = this.settingsForm.getRawValue();
    return normalizeServerTheme({
      backgroundColor: value.themeBackgroundColor,
      textColor: value.themeTextColor,
      fontFamily: value.themeFontFamily,
      backgroundImage: value.themeBackgroundImage,
      backgroundImageBlur: value.themeBackgroundImageBlur
    });
  }

  private getThemeFormResetValue(theme: Partial<IServerTheme> | null | undefined) {
    const normalizedTheme = normalizeServerTheme(theme);
    return {
      themeBackgroundColor: normalizedTheme.backgroundColor,
      themeTextColor: normalizedTheme.textColor,
      themeFontFamily: normalizedTheme.fontFamily,
      themeBackgroundImage: normalizedTheme.backgroundImage,
      themeBackgroundImageBlur: normalizedTheme.backgroundImageBlur
    };
  }

  private toCssImageValue(imageUrl: string | null): string {
    if (!imageUrl) return 'none';
    return `url("${imageUrl.replace(/"/g, '\\"')}")`;
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

import { Component, Inject, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatSelectModule } from '@angular/material/select';
import { Subject, firstValueFrom, takeUntil } from 'rxjs';

import { ServerService } from '../../shared/services/server/server';
import { ChannelService } from '../../shared/services/channel/channel';
import { IServer } from '../../shared/models/server/server.model';
import {Role} from '../../shared/services/role/role';
import {MatSliderModule} from '@angular/material/slider';
import {MatSlideToggle} from '@angular/material/slide-toggle';
import {MatCheckbox} from '@angular/material/checkbox';
import {MatListItem} from '@angular/material/list';

@Component({
  selector: 'app-server-settings-dialog',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, MatDialogModule, MatButtonModule,
    MatFormFieldModule, MatInputModule, MatIconModule, MatDividerModule,
    MatSnackBarModule, MatSelectModule, MatSliderModule, MatSlideToggle, MatCheckbox, MatListItem
  ],
  templateUrl: './server-settings-dialog-component.html',
  styleUrls: ['./server-settings-dialog-component.scss'],
})
export class ServerSettingsDialogComponent implements OnInit, OnDestroy {
  activeTab: 'overview' | 'roles' | 'members' | 'channels' = 'overview';

  settingsForm: FormGroup;
  roleForm: FormGroup;
  channelForm: FormGroup;

  serverDetails: IServer | null = null;
  isLoading = false;

  iconPreview: string | null = null;
  selectedFile: File | null = null;
  selectedRole: any | null = null;

  selectedChannel: any | null = null;
  isCreatingChannel = false;

  isCreating = false;

  private destroy$ = new Subject<void>();

  constructor(
    @Inject(MAT_DIALOG_DATA) public server: IServer,
    private fb: FormBuilder,
    private serverService: ServerService,
    private roleService: Role,
    private channelService: ChannelService,
    private snackBar: MatSnackBar,
    protected dialogRef: MatDialogRef<ServerSettingsDialogComponent>
  ) {
    this.settingsForm = this.fb.group({ name: [server.name, Validators.required] });
    this.roleForm = this.fb.group({ name: ['', Validators.required], color: ['#ffffff'] });
    this.channelForm = this.fb.group({
      name: ['', [Validators.required, Validators.maxLength(100)]],
      type: ['text', Validators.required],
      icon: ['tag', Validators.required] // Default icon to match "text" type
    });
    this.iconPreview = server.icon || null;
  }

  ngOnInit() {
    // Reactive subscription: UI updates automatically when service data changes
    this.serverService.getServerDetailsObservable()
      .pipe(takeUntil(this.destroy$))
      .subscribe(data => {
        this.serverDetails = data;
        console.log(this.serverDetails)
      });

    this.roleForm = this.initRoleForm();
  }

  private initRoleForm() {
    return this.fb.group({
      name: ['', Validators.required],
      color: ['#99AAB5'],
      hoist: [false], // <--- Editable
      // All Permission Flags from your Mongoose Model
      ADMINISTRATOR: [false],
      MANAGE_SERVER: [false],
      MANAGE_CHANNELS: [false],
      MANAGE_ROLES: [false],
      SEND_MESSAGES: [true],
      READ_MESSAGE_HISTORY: [true],
      CONNECT: [true]
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  setTab(tab: typeof this.activeTab) {
    this.activeTab = tab;
  }

  // Helper for mat-select with populated objects
  compareRoles(role1: any, role2: any): boolean {
    // Extract IDs whether the input is a string or an object
    const id1 = role1?._id || role1;
    const id2 = role2?._id || role2;

    return id1 === id2;
  }

  /* --- Actions --- */

  async onSaveChanges() {
    if (this.settingsForm.invalid || this.isLoading) return;
    this.isLoading = true;
    try {
      await this.serverService.updateServer(
        this.server._id,
        this.settingsForm.value.name,
        this.selectedFile
      );
      this.snackBar.open('Server updated!', 'Close', { duration: 2000 });
      this.settingsForm.markAsPristine();
    } catch (err) {
      this.snackBar.open('Update failed.', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
      this.settingsForm.markAsPristine();
    }
  }
  async refreshData() {
    await this.serverService.getServerDetails(this.server._id);
  }

  // Update the Create Role button logic
  createRole() {
    this.selectedRole = null;
    this.isCreating = true;
    this.roleForm = this.initRoleForm(); // Reset to defaults
  }

  async onUpdateRole() {
    if (this.roleForm.invalid || !this.selectedRole) return;

    const { name, color, hoist, ...permissions } = this.roleForm.value;
    const payload = { name, color, hoist, permissions };

    this.isLoading = true;
    this.roleService.updateRole(this.server._id, this.selectedRole._id, payload).subscribe({
      next: () => {
        this.snackBar.open('Role updated', 'OK', { duration: 2000 });
        this.roleForm.markAsPristine();
        this.serverService.getServerDetails(this.server._id);
      },
      complete: () => this.isLoading = false
    });
  }
  selectRole(role: any) {
    this.isCreating = false;
    this.selectedRole = role;
    this.roleForm.patchValue({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      ...role.permissions
    });
    this.roleForm.markAsPristine();
  }

  async onSaveRole() {
    if (this.roleForm.invalid) return;

    const val = this.roleForm.value;
    const payload = {
      name: val.name,
      color: val.color,
      hoist: val.hoist,
      permissions: {
        ADMINISTRATOR: val.ADMINISTRATOR,
        MANAGE_SERVER: false, // Defaulting these as per your requirement
        MANAGE_ROLES: false,
        MANAGE_CHANNELS: val.MANAGE_CHANNELS,
        SEND_MESSAGES: val.SEND_MESSAGES,
        READ_MESSAGE_HISTORY: val.READ_MESSAGE_HISTORY,
        CONNECT: val.CONNECT
      }
    };

    this.isLoading = true;

    if (this.isCreating) {
      this.roleService.createRole(this.server._id, payload).subscribe({
        next: (newRole) => {
          this.snackBar.open('Role Created', 'OK', { duration: 2000 });
          this.isCreating = false;
          this.serverService.getServerDetails(this.server._id);

          this.roleForm.markAsPristine();
        },
        error: () => (this.isLoading = false)
      });
    } else {
      this.roleService.updateRole(this.server._id, this.selectedRole._id, payload).subscribe({
        next: () => {
          this.snackBar.open('Role Updated', 'OK', { duration: 2000 });
          this.serverService.getServerDetails(this.server._id);
          this.roleForm.markAsPristine();
        },
        error: () => (this.isLoading = false)
      });
    }
  }

  async deleteRole(roleId: string) {
    if (!confirm('Delete this role?')) return;
    this.roleService.deleteRole(this.server._id, roleId).subscribe(() => this.refreshData());
    this.selectedRole = null;
    this.selectRole(null);
  }

  /* --- Member Actions --- */
  async updateMemberRoles(userId: string, roleIds: string[]) {
    this.serverService.updateMemberRoles(this.server._id, userId, roleIds);
  }

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    this.selectedFile = file;
    const reader = new FileReader();
    reader.onload = e => this.iconPreview = e.target?.result as string;
    reader.readAsDataURL(file);
  }




  // Channel Controls:
  selectChannel(channel: any) {
    this.isCreatingChannel = false;
    this.selectedChannel = channel;
    this.channelForm.patchValue({
      name: channel.name,
      type: channel.type,
      icon: channel.icon || (channel.type === 'call' ? 'volume_up' : 'tag')
    });
    this.channelForm.markAsPristine();
  }

  createChannelMode() {
    this.selectedChannel = null;
    this.isCreatingChannel = true;
    this.channelForm.reset({ type: 'text', name: '' });
  }

  onTypeChange(type: string) {
    const icon = type === 'call' ? 'volume_up' : 'tag';
    this.channelForm.get('icon')?.setValue(icon);
  }

  async onSaveChannel() {
    if (this.channelForm.invalid) return;

    const payload = this.channelForm.value;
    this.isLoading = true;

    if (this.isCreatingChannel) {
      this.channelService.createChannel(this.server._id, payload).subscribe({
        next: () => {
          this.snackBar.open('Channel Created', 'OK', { duration: 2000 });
          this.isCreatingChannel = false;
          this.refreshData();
        },
        error: () => (this.isLoading = false)
      });
    } else {
      this.channelService.updateChannel(this.server._id, this.selectedChannel._id, payload).subscribe({
        next: () => {
          this.snackBar.open('Channel Updated', 'OK', { duration: 2000 });
          this.channelForm.markAsPristine();
          this.refreshData();
        },
        error: () => (this.isLoading = false)
      });
    }
  }

  async onDeleteChannel() {
    if (!this.selectedChannel) return;
    if (!confirm(`Are you sure you want to delete #${this.selectedChannel.name}?`)) return;

    this.isLoading = true;
    this.channelService.deleteChannel(this.server._id, this.selectedChannel._id).subscribe({
      next: () => {
        this.snackBar.open('Channel Deleted', 'OK', { duration: 2000 });
        this.selectedChannel = null;
        this.refreshData();
      },
      error: () => (this.isLoading = false)
    });
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
}

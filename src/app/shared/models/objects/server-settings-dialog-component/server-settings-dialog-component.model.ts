import type { ChannelType } from '../../server/channel.model';
import type { RolePermissions } from '../../server/role.model';

export type SettingsTab = 'overview' | 'roles' | 'members' | 'channels' | 'homebrew-packs';

export type ServerDangerAction = 'leave' | 'delete';

export type EditableChannelType = ChannelType.Text | ChannelType.Call;

export type ChannelPermissionKey = 'READ_MESSAGE_HISTORY' | 'SEND_MESSAGES' | 'CONNECT';

export type ChannelPermissionState = 'inherit' | 'allow' | 'deny';

export interface PermissionControl {
  key: keyof RolePermissions;
  label: string;
  description: string;
  defaultValue: boolean;
}

export interface ChannelTypeOption {
  value: EditableChannelType;
  label: string;
  icon: string;
  description: string;
  defaultIcon: string;
}

export interface ChannelPermissionControl {
  key: ChannelPermissionKey;
  label: string;
  icon: string;
  description: string;
}

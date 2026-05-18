import type { RolePermissions } from '../../../server/role.model';

export type ChannelAccessPermission = 'READ_MESSAGE_HISTORY' | 'SEND_MESSAGES' | 'CONNECT';

export type ServerManagementPermission = Extract<
  keyof RolePermissions,
  'ADMINISTRATOR' | 'MANAGE_SERVER' | 'MANAGE_ROLES' | 'MANAGE_CHANNELS'
>;

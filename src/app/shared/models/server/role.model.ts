export interface IRole {
  _id?: string;
  server: string;
  name: string;
  color: string;
  hoist: boolean;
  position: number;
  permissions: RolePermissions;
}

export interface RolePermissions {
  ADMINISTRATOR: boolean;
  MANAGE_SERVER: boolean;
  MANAGE_CHANNELS: boolean;
  MANAGE_ROLES: boolean;
  SEND_MESSAGES: boolean;
  READ_MESSAGE_HISTORY: boolean;
  CONNECT: boolean;
}

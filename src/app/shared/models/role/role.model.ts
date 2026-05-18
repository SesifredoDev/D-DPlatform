export interface IRolePayload {
  name: string;
  color?: string;
  hoist?: boolean;
  permissions: {
    ADMINISTRATOR: boolean;
    MANAGE_SERVER: boolean;
    MANAGE_CHANNELS: boolean;
    MANAGE_ROLES: boolean;
    SEND_MESSAGES: boolean;
    READ_MESSAGE_HISTORY: boolean;
    CONNECT: boolean;
  };
}

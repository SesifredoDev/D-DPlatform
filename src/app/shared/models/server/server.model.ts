import type { IRole } from './role.model';
import type { IUser } from '../user/user.model';
import type { IChannel } from './channel.model';
import type { ICharacter } from '../user/character.model';

export type TemporaryDmDuration = 'day' | 'week' | 'month' | 'permanent' | 'none';

export interface TemporaryDmGrant {
  enabled: boolean;
  expiresAt: string | Date | null;
  grantedBy?: string | IUser | null;
  grantedAt?: string | Date | null;
}

export interface IServerTheme {
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  backgroundImage: string | null;
  backgroundImageBlur: boolean;
  backgroundImageKey?: string | null;
}

export interface IServer {
  _id: string;
  name: string;
  icon: string | null;
  defaultTheme?: IServerTheme;
  joinCode?: string;
  roles: IRole[]; // Can be IDs or populated objects
  channels: IChannel[];
  owner: string | IUser; // User ID
  members: ServerMember[];
  createdAt: Date;
}

export interface ServerMember {
  user: IUser; // User ID
  roles: string[];
  temporaryDm?: TemporaryDmGrant;
  joinedAt: Date;
  characters: ICharacter[];
}

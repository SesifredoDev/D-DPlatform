import {IRole} from './role.model';
import {IUser} from '../user/user.model';
import {IChannel} from './channel.model';
import {ICharacter} from '../user/character.model';

export type TemporaryDmDuration = 'day' | 'week' | 'month' | 'permanent' | 'none';

export interface TemporaryDmGrant {
  enabled: boolean;
  expiresAt: string | Date | null;
  grantedBy?: string | IUser | null;
  grantedAt?: string | Date | null;
}

export interface IServer {
  _id: string;
  name: string;
  icon: string | null;
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

import {IRole} from './role.model';
import {IUser} from '../user/user.model';
import {IChannel} from './channel.model';

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
  joinedAt: Date;
}

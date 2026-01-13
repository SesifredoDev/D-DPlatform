import {IRole} from './role.model';

export interface IServer {
  _id: string;
  name: string;
  icon: string | null;
  joinCode?: string;
  roles: string[] | IRole[]; // Can be IDs or populated objects
  owner: string; // User ID
  members: ServerMember[];
  createdAt: Date;
}

export interface ServerMember {
  user: string; // User ID
  roles: string[] | IRole[];
  joinedAt: Date;
}

import {ICharacter} from '../user/character.model';

export enum ChannelType {
  Text = 'text',
  Call = 'call',
  Map = 'map'
}

export interface PermissionOverwrite {
  role: string;
  allow: string[];
  deny: string[];
}

export interface IChannel {
  _id?: string;
  server: string;
  name: string;
  icon: string;
  type: ChannelType;
  permissionOverwrites: PermissionOverwrite[];
  position?: number;
  createdAt: Date;
}

export interface IMessage {
  _id?: string;
  channel: string;
  server: string;
  author: string;
  character: string | ICharacter | null; // Populated or ID
  content: string;
  attachments: string[];
  createdAt: Date;
}

export interface Attachment {
  url: string;
  name: string;
  contentType: string;
  id?: string;
  key?: string;
  filename?: string;
  size?: number;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface MessageData {
  _id: string;
  channel: string;
  channelId?: string;
  server: string;
  author: any;
  character?: any;
  content: string;
  attachments: Attachment[];
  reactions: Reaction[];
  replyTo?: any;
  isWhisper?: boolean;
  recipient?: any;
  createdAt: string;
}

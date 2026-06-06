import type { ICharacter } from '../user/character.model';

export type TabType = 'text' | 'call' | 'character' | 'vtt' | 'spotify' | 'whisper' | 'obsidian' | 'livestream';

export type MainTabPane = 'left' | 'right';

export type TabPane = MainTabPane | (string & {});

export interface Tab {
  id: string;
  title: string;
  type: TabType;
  pane: TabPane;
  active: boolean;
  character?: ICharacter;
  whisperRecipient?: any;
  data?: any; // Added to support arbitrary data for different tab types
}

export interface TabPanel {
  id: string;
  title: string;
  createdAt: number;
}

export interface TabSyncMessage {
  type: 'state' | 'state-request';
  sourceId: string;
  tabs?: Tab[];
  panels?: TabPanel[];
}

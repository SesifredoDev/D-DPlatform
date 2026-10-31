export type PlayerSettingsTab = 'audio-video' | 'notifications' | 'table' | 'interface';

export interface IPlayerSettings {
  audioVideo: {
    microphoneId: string;      // '' = system default
    speakerId: string;         // '' = system default
    cameraId: string;          // '' = system default
    muteOnJoin: boolean;
    cameraOffOnJoin: boolean;
    noiseSuppression: boolean;
    echoCancellation: boolean;
  };
  notifications: {
    unreadBadges: boolean;
    messageSound: boolean;
    whisperSound: boolean;
    desktopNotifications: boolean;
  };
  table: {
    showTokenNames: boolean;
    showGrid: boolean;
    snapToGrid: boolean;
    showPlayerCursors: boolean;
  };
  interface: {
    reduceMotion: boolean;
    compactMemberList: boolean;
    startCollapsed: boolean;
  };
}

export const DEFAULT_PLAYER_SETTINGS: IPlayerSettings = {
  audioVideo: {
    microphoneId: '',
    speakerId: '',
    cameraId: '',
    muteOnJoin: false,
    cameraOffOnJoin: false,
    noiseSuppression: true,
    echoCancellation: true
  },
  notifications: {
    unreadBadges: true,
    messageSound: true,
    whisperSound: true,
    desktopNotifications: false
  },
  table: {
    showTokenNames: true,
    showGrid: true,
    snapToGrid: true,
    showPlayerCursors: true
  },
  interface: {
    reduceMotion: false,
    compactMemberList: false,
    startCollapsed: false
  }
};

export interface PlayerSettingsToggleRow {
  key: string;
  label: string;
  description: string;
  icon: string;
}

export interface PlayerSettingsSection {
  tab: PlayerSettingsTab;
  group: keyof IPlayerSettings;
  title: string;
  rows: PlayerSettingsToggleRow[];
}

export interface PlayerSettingsDialogData {
  initialTab?: PlayerSettingsTab;
}

export interface PlayerIdentity {
  username?: string;
  profileIcon?: string | null;
  profileIconUrl?: string | null;
}

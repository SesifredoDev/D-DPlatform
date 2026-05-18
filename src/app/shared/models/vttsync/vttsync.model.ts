export interface TurnOrderEntry {
  id: string;
  name: string;
  initiative: number;
  userId: string;
}

export interface TurnOrderState {
  isActive: boolean;
  isConfirmed: boolean;
  entries: TurnOrderEntry[];
  activeIndex: number;
}

export interface MapLibraryEntry {
  id: string;
  name: string;
  lastSaved: string;
  server: string;
  data: any;
  isArchived?: boolean;
}

export interface MapLoadingState {
    loading: boolean;
    progress: number;
    message: string;
}

export interface GridSettings {
  size: number;
  color: string;
  thickness: number;
  type: 'square' | 'hex';
}

export interface StartHostingOptions {
  preserveExistingState?: boolean;
}

export interface SessionStatus {
  ok: boolean;
  active: boolean;
  hasHost: boolean;
  hostId: string | null;
  version: number;
  reason?: string;
}

export interface SyncActionPayload {
  action: string;
  data: any;
  version?: number;
  sourceId?: string;
}

export interface VttCharacterTokenPayload {
  name: string;
  icon: string | null;
  ownerId: string | null;
}

export interface VttWindowCommand {
  type: 'add-character-token';
  requestId: string;
  sourceId: string;
  targetWindowLabel?: string | null;
  roomId?: string | null;
  token: VttCharacterTokenPayload;
  x?: number;
  y?: number;
}

export interface VttWindowCommandResult {
  type: 'add-character-token-result';
  requestId: string;
  sourceId: string;
  handled: boolean;
  roomId: string | null;
  reason?: string;
}

export type VttWindowMessage = VttWindowCommand | VttWindowCommandResult;

export interface VttWindowTarget {
  sourceId: string;
  attachmentId: string;
  roomId: string;
  windowLabel: string;
  updatedAt: number;
}

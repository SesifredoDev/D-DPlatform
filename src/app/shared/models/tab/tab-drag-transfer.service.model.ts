import type { Tab } from './tab-service.model';

export interface TabDragPayload {
  tabId: string;
  sourcePane: string;
  sourceWindowId: string;
  type: Tab['type'];
  title: string;
  startedAt: number;
  hasLiveConnection?: boolean;
}

export interface TabDragHandledPayload {
  tabId: string;
  handledAt: number;
}

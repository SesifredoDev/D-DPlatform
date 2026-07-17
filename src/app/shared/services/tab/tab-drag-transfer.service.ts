import { Injectable } from '@angular/core';
import type { Tab } from './tab-service';
import type { TabDragPayload, TabDragHandledPayload } from '../../models/tab/tab-drag-transfer.service.model';
export type { TabDragPayload } from '../../models/tab/tab-drag-transfer.service.model';
@Injectable({ providedIn: 'root' })
export class TabDragTransferService {
  private static readonly mimeType = 'application/x-dd-platform-tab';
  private static readonly textPrefix = 'dd-platform-tab:';
  private static readonly storageKey = 'dd-platform-tab-drag';
  private static readonly handledStorageKey = 'dd-platform-tab-drag-handled';
  private static readonly maxAgeMs = 10000;
  private readonly windowId = `tab-window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private cleanupTimer: number | null = null;

  write(event: DragEvent, tab: Tab, options: { hasLiveConnection?: boolean } = {}): TabDragPayload {
    this.removeHandledPayload();

    let payload: TabDragPayload = {
      tabId: tab.id,
      sourcePane: String(tab.pane),
      sourceWindowId: this.windowId,
      type: tab.type,
      title: tab.title,
      tab,
      startedAt: Date.now(),
      hasLiveConnection: options.hasLiveConnection
    };
    let serialized: string;

    try {
      serialized = JSON.stringify(payload);
    } catch {
      const fallbackTab: Tab = {
        id: tab.id,
        title: tab.title,
        type: tab.type,
        pane: tab.pane,
        active: tab.active
      };

      payload = {
        ...payload,
        tab: fallbackTab
      };
      serialized = JSON.stringify(payload);
    }

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.dropEffect = 'move';
      this.trySetData(event.dataTransfer, TabDragTransferService.mimeType, serialized);
    }

    this.writeStoredPayload(serialized);
    return payload;
  }

  hasPayload(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (types.includes('Files')) {
      return false;
    }

    if (types.includes(TabDragTransferService.mimeType)) {
      return true;
    }

    return this.readStoredPayload() !== null;
  }

  read(event: DragEvent): TabDragPayload | null {
    const transfer = event.dataTransfer;
    if (transfer) {
      const types = Array.from(transfer.types ?? []);
      if (types.includes('Files')) {
        return null;
      }

      const customPayload = this.parsePayload(transfer.getData(TabDragTransferService.mimeType));
      if (customPayload) {
        return customPayload;
      }

      const textPayload = transfer.getData('text/plain');
      if (textPayload.startsWith(TabDragTransferService.textPrefix)) {
        const parsedTextPayload = this.parsePayload(textPayload.slice(TabDragTransferService.textPrefix.length));
        if (parsedTextPayload) {
          return parsedTextPayload;
        }
      }
    }

    return this.readStoredPayload();
  }

  markHandled(tabId: string) {
    try {
      const payload: TabDragHandledPayload = { tabId, handledAt: Date.now() };
      localStorage.setItem(TabDragTransferService.handledStorageKey, JSON.stringify(payload));
    } catch {
      // Best effort only. The source window will fall back to its own drag state.
    }
  }

  wasHandled(tabId: string): boolean {
    try {
      const storedPayload = localStorage.getItem(TabDragTransferService.handledStorageKey);
      if (!storedPayload) {
        return false;
      }

      const payload = JSON.parse(storedPayload) as Partial<TabDragHandledPayload>;
      if (payload.tabId !== tabId || !payload.handledAt) {
        return false;
      }

      if (Date.now() - payload.handledAt > TabDragTransferService.maxAgeMs) {
        this.removeHandledPayload();
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  isFromCurrentWindow(payload: TabDragPayload): boolean {
    return payload.sourceWindowId === this.windowId;
  }

  isHandledStorageEvent(event: StorageEvent, tabId: string | null): boolean {
    if (event.key !== TabDragTransferService.handledStorageKey || !event.newValue || !tabId) {
      return false;
    }

    try {
      const payload = JSON.parse(event.newValue) as Partial<TabDragHandledPayload>;
      if (payload.tabId !== tabId || !payload.handledAt) {
        return false;
      }

      return Date.now() - payload.handledAt <= TabDragTransferService.maxAgeMs;
    } catch {
      return false;
    }
  }

  clear() {
    if (this.cleanupTimer !== null) {
      window.clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.removeStoredPayload();
    this.removeHandledPayload();
  }

  clearSoon() {
    if (this.cleanupTimer !== null) {
      window.clearTimeout(this.cleanupTimer);
    }

    this.cleanupTimer = window.setTimeout(() => {
      this.cleanupTimer = null;
      this.removeStoredPayload();
    }, 1500);
  }

  private trySetData(dataTransfer: DataTransfer, format: string, data: string) {
    try {
      dataTransfer.setData(format, data);
    } catch (error) {
      console.warn('Failed to write tab drag payload', error);
    }
  }

  private writeStoredPayload(serialized: string) {
    try {
      localStorage.setItem(TabDragTransferService.storageKey, serialized);
    } catch (error) {
      console.warn('Failed to persist tab drag payload', error);
    }
  }

  private readStoredPayload(): TabDragPayload | null {
    try {
      const storedPayload = localStorage.getItem(TabDragTransferService.storageKey);
      const payload = this.parsePayload(storedPayload);
      if (!payload) {
        return null;
      }

      if (Date.now() - payload.startedAt > TabDragTransferService.maxAgeMs) {
        this.removeStoredPayload();
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  private removeStoredPayload() {
    try {
      localStorage.removeItem(TabDragTransferService.storageKey);
    } catch {
      // Best effort cleanup only.
    }
  }

  private removeHandledPayload() {
    try {
      localStorage.removeItem(TabDragTransferService.handledStorageKey);
    } catch {
      // Best effort cleanup only.
    }
  }

  private parsePayload(value: string | null): TabDragPayload | null {
    if (!value) {
      return null;
    }

    try {
      const payload = JSON.parse(value) as Partial<TabDragPayload>;
      if (!payload.tabId || !payload.sourcePane || !payload.startedAt) {
        return null;
      }

      return {
        tabId: payload.tabId,
        sourcePane: payload.sourcePane,
        sourceWindowId: payload.sourceWindowId ?? '',
        type: payload.type ?? 'text',
        title: payload.title ?? 'Tab',
        tab: this.parseTab(payload),
        startedAt: payload.startedAt,
        hasLiveConnection: payload.hasLiveConnection === true
      };
    } catch {
      return null;
    }
  }

  private parseTab(payload: Partial<TabDragPayload>): Tab {
    const rawTab = payload.tab as Partial<Tab> | undefined;

    return {
      id: rawTab?.id ?? payload.tabId ?? '',
      title: rawTab?.title ?? payload.title ?? 'Tab',
      type: rawTab?.type ?? payload.type ?? 'text',
      pane: rawTab?.pane ?? payload.sourcePane ?? 'left',
      active: rawTab?.active === true,
      character: rawTab?.character,
      whisperRecipient: rawTab?.whisperRecipient,
      data: rawTab?.data
    };
  }
}

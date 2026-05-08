import { Injectable } from '@angular/core';
import { Tab } from './tab-service';

export interface TabDragPayload {
  tabId: string;
  sourcePane: string;
  title: string;
  startedAt: number;
}

interface TabDragHandledPayload {
  tabId: string;
  handledAt: number;
}

@Injectable({ providedIn: 'root' })
export class TabDragTransferService {
  private static readonly mimeType = 'application/x-dd-platform-tab';
  private static readonly textPrefix = 'dd-platform-tab:';
  private static readonly storageKey = 'dd-platform-tab-drag';
  private static readonly handledStorageKey = 'dd-platform-tab-drag-handled';
  private static readonly maxAgeMs = 10000;
  private cleanupTimer: number | null = null;

  write(event: DragEvent, tab: Tab): TabDragPayload {
    this.removeHandledPayload();

    const payload: TabDragPayload = {
      tabId: tab.id,
      sourcePane: String(tab.pane),
      title: tab.title,
      startedAt: Date.now()
    };
    const serialized = JSON.stringify(payload);

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
        title: payload.title ?? 'Tab',
        startedAt: payload.startedAt
      };
    } catch {
      return null;
    }
  }
}

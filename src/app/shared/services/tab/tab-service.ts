import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ICharacter } from '../../models/user/character.model';
import { Video } from '../video/video';
import { ThemeService } from '../theme/theme.service';
import type { UnlistenFn } from '@tauri-apps/api/event';

export type TabType = 'text' | 'call' | 'character' | 'vtt' | 'spotify' | 'whisper' | 'obsidian';
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

interface TabSyncMessage {
  type: 'state' | 'state-request';
  sourceId: string;
  tabs?: Tab[];
  panels?: TabPanel[];
}

@Injectable({ providedIn: 'root' })
export class TabService {
  private static readonly tabSyncEvent = 'dd-platform-tabs-sync';
  private static readonly channelName = 'dd-platform-tabs';

  private tabs = new BehaviorSubject<Tab[]>([]);
  tabs$ = this.tabs.asObservable();

  private panels = new BehaviorSubject<TabPanel[]>([]);
  panels$ = this.panels.asObservable();

  private readonly instanceId = this.createInstanceId();
  private readonly externalPanelId = this.getExternalPanelId();
  private readonly broadcastChannel?: BroadcastChannel;
  private tauriUnlisten?: UnlistenFn;
  private panelCounter = 0;
  private applyingRemoteState = false;

  constructor(private videoService: Video, private themeService: ThemeService) {
    this.broadcastChannel = this.createBroadcastChannel();
    void this.setupTauriSync().finally(() => queueMicrotask(() => this.requestRemoteState()));
  }

  static getPanelSecondaryPaneId(panelId: string): string {
    return `${panelId}:right`;
  }

  static panelOwnsPane(panelId: string, pane: TabPane): boolean {
    const paneId = String(pane);
    return paneId === panelId || paneId.startsWith(`${panelId}:`);
  }

  openTab(id: string, title: string, type: TabType, pane: TabPane = 'left', data?: any) { // Changed character to data
    pane = this.resolvePaneForCurrentWindow(pane);
    const current = this.tabs.value;
    const existing = current.find(t => t.id === id);

    if (existing) {
      const nextData = data === undefined ? existing.data : { ...(existing.data ?? {}), ...data };
      this.publishTabs(current.map(t => {
        if (t.id === id) {
          return { ...t, title, type, data: nextData, active: true };
        }

        return t.pane === existing.pane ? { ...t, active: false } : t;
      }));
      return;
    }

    const newTab: Tab = { id, title, type, pane, active: true, data }; // Passed data to newTab
    // Deactivate others in the same pane
    const updated = current.map(t => t.pane === pane ? { ...t, active: false } : t);
    this.publishTabs([...updated, newTab]);
  }

  selectTab(id: string) {
    const tabs = this.tabs.value;
    const target = tabs.find(t => t.id === id);
    if (!target) return;

    this.publishTabs(tabs.map(t => ({
      ...t,
      active: t.pane === target.pane ? t.id === id : t.active
    })));
  }

  moveTab(tabId: string, targetPane: TabPane, targetIndex?: number) {
    targetPane = this.resolvePaneForCurrentWindow(targetPane);
    const tab = this.tabs.value.find(t => t.id === tabId);
    if (!tab) return;

    const sourcePane = tab.pane;
    const movingWithinSamePane = sourcePane === targetPane;
    const movedTab: Tab = { ...tab, pane: targetPane, active: true };
    const remainingTabs = this.tabs.value
      .filter(t => t.id !== tabId)
      .map(t => t.pane === targetPane ? { ...t, active: false } : t);

    let nextTabs = this.insertTabAtPaneIndex(remainingTabs, movedTab, targetPane, targetIndex);
    if (!movingWithinSamePane) {
      nextTabs = this.ensurePaneHasActiveTab(nextTabs, sourcePane);
    }

    this.publishTabs(nextTabs);
  }

  createPanelFromTab(tabId: string): TabPanel | null {
    const tab = this.tabs.value.find(t => t.id === tabId);
    if (!tab) return null;

    const panel: TabPanel = {
      id: `tab-panel-${Date.now()}-${++this.panelCounter}-${Math.random().toString(36).slice(2, 8)}`,
      title: tab.title,
      createdAt: Date.now()
    };

    this.publishPanels([...this.panels.value, panel]);
    this.moveTab(tabId, panel.id);
    return panel;
  }

  dockPanel(panelId: string, targetPane: MainTabPane = 'left') {
    const panelTabs = this.tabs.value.filter(tab => TabService.panelOwnsPane(panelId, tab.pane));
    if (panelTabs.length === 0) {
      this.removePanel(panelId);
      return;
    }

    const activeTabId = panelTabs.find(tab => tab.active)?.id ?? panelTabs[0].id;
    let nextTabs = this.tabs.value
      .filter(tab => !TabService.panelOwnsPane(panelId, tab.pane))
      .map(tab => tab.pane === targetPane ? { ...tab, active: false } : tab);

    panelTabs.forEach(tab => {
      nextTabs = this.insertTabAtPaneIndex(nextTabs, {
        ...tab,
        pane: targetPane,
        active: tab.id === activeTabId
      }, targetPane);
    });

    this.removePanel(panelId, false);
    this.publishTabs(nextTabs);
  }

  closePanel(panelId: string) {
    const panelTabs = this.tabs.value.filter(tab => TabService.panelOwnsPane(panelId, tab.pane));
    panelTabs.forEach(tab => this.runTabCloseSideEffects(tab));

    this.removePanel(panelId, false);
    this.publishTabs(this.tabs.value.filter(tab => !TabService.panelOwnsPane(panelId, tab.pane)));
  }

  closeTab(id: string) {
    const tabToClose = this.tabs.value.find(t => t.id === id);

    if (tabToClose) {
      this.runTabCloseSideEffects(tabToClose);
    }

    let nextTabs = this.tabs.value.filter(t => t.id !== id);
    if (tabToClose) {
      nextTabs = this.ensurePaneHasActiveTab(nextTabs, tabToClose.pane);
    }

    this.publishTabs(nextTabs);
  }

  closeAllTabs() {
    this.tabs.value.forEach(tab => {
      this.runTabCloseSideEffects(tab);
    });
    this.publishTabs([]);
    this.publishPanels([]);
  }



  updateTab(id: string, data: Partial<Tab>) {
    const current = this.tabs.value;
    const updated = current.map(t => t.id === id ? { ...t, ...data } : t);
    this.publishTabs(updated);
  }

  getPanelTabs(panelId: string): Tab[] {
    return this.tabs.value.filter(tab => TabService.panelOwnsPane(panelId, tab.pane));
  }

  private runTabCloseSideEffects(tab: Tab) {
    if (tab.type === 'call') {
      this.videoService.leaveCall(tab.id);
      this.themeService.revertToSaved();
    }
  }

  private insertTabAtPaneIndex(tabs: Tab[], tab: Tab, pane: TabPane, targetIndex?: number): Tab[] {
    const paneIndexes = tabs.reduce<number[]>((indexes, currentTab, index) => {
      if (currentTab.pane === pane) {
        indexes.push(index);
      }
      return indexes;
    }, []);

    let insertAt = tabs.length;
    if (targetIndex !== undefined && targetIndex >= 0 && targetIndex < paneIndexes.length) {
      insertAt = paneIndexes[targetIndex];
    } else if (paneIndexes.length > 0) {
      insertAt = paneIndexes[paneIndexes.length - 1] + 1;
    }

    const nextTabs = [...tabs];
    nextTabs.splice(insertAt, 0, tab);
    return nextTabs;
  }

  private ensurePaneHasActiveTab(tabs: Tab[], pane: TabPane): Tab[] {
    const paneTabs = tabs.filter(tab => tab.pane === pane);
    if (paneTabs.length === 0 || paneTabs.some(tab => tab.active)) {
      return tabs;
    }

    const nextActiveId = paneTabs[0].id;
    return tabs.map(tab => tab.id === nextActiveId ? { ...tab, active: true } : tab);
  }

  private removePanel(panelId: string, publishState = true) {
    const nextPanels = this.panels.value.filter(panel => panel.id !== panelId);
    if (publishState) {
      this.publishPanels(nextPanels);
    } else {
      this.panels.next(nextPanels);
    }
  }

  private publishTabs(tabs: Tab[]) {
    this.tabs.next(tabs);
    this.removeEmptyPanels(tabs);
    this.broadcastState();
  }

  private publishPanels(panels: TabPanel[]) {
    this.panels.next(panels);
    this.broadcastState();
  }

  private removeEmptyPanels(tabs: Tab[]) {
    const activePaneIds = new Set(tabs.map(tab => String(tab.pane)));
    const nextPanels = this.panels.value.filter(panel =>
      Array.from(activePaneIds).some(paneId => TabService.panelOwnsPane(panel.id, paneId))
    );
    if (nextPanels.length !== this.panels.value.length) {
      this.panels.next(nextPanels);
    }
  }

  private applyRemoteState(tabs: Tab[], panels: TabPanel[]) {
    this.applyingRemoteState = true;
    this.tabs.next(tabs);
    this.panels.next(panels);
    this.applyingRemoteState = false;
  }

  private createBroadcastChannel(): BroadcastChannel | undefined {
    if (typeof BroadcastChannel === 'undefined') return undefined;

    const channel = new BroadcastChannel(TabService.channelName);
    channel.onmessage = event => this.handleSyncMessage(event.data as TabSyncMessage);
    return channel;
  }

  private async setupTauriSync() {
    if (!this.isTauriRuntime()) return;

    try {
      const { listen } = await import('@tauri-apps/api/event');
      this.tauriUnlisten = await listen<TabSyncMessage>(TabService.tabSyncEvent, event => {
        this.handleSyncMessage(event.payload);
      });
    } catch (error) {
      console.warn('Tauri tab sync is unavailable', error);
    }
  }

  private handleSyncMessage(message: TabSyncMessage) {
    if (!message || message.sourceId === this.instanceId) return;

    if (message.type === 'state-request') {
      this.broadcastState();
      return;
    }

    if (message.type === 'state' && message.tabs && message.panels) {
      this.applyRemoteState(message.tabs, message.panels);
    }
  }

  private requestRemoteState() {
    this.broadcastMessage({ type: 'state-request', sourceId: this.instanceId });
  }

  private broadcastState() {
    if (this.applyingRemoteState) return;

    this.broadcastMessage({
      type: 'state',
      sourceId: this.instanceId,
      tabs: this.tabs.value,
      panels: this.panels.value
    });
  }

  private broadcastMessage(message: TabSyncMessage) {
    this.broadcastChannel?.postMessage(message);

    if (!this.isTauriRuntime()) return;
    void import('@tauri-apps/api/event')
      .then(({ emit }) => emit(TabService.tabSyncEvent, message))
      .catch(error => console.warn('Failed to broadcast Tauri tab state', error));
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  private resolvePaneForCurrentWindow(pane: TabPane): TabPane {
    if (!this.externalPanelId) {
      return pane;
    }

    if (pane === 'left') {
      return this.externalPanelId;
    }

    if (pane === 'right') {
      return TabService.getPanelSecondaryPaneId(this.externalPanelId);
    }

    return pane;
  }

  private getExternalPanelId(): string | null {
    if (typeof window === 'undefined') {
      return null;
    }

    return new URLSearchParams(window.location.search).get('tabPanel');
  }

  private createInstanceId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

import { Injectable } from '@angular/core';
import { BehaviorSubject, map } from 'rxjs';
import { ICharacter } from '../../models/user/character.model';
import { Video } from '../video/video';

export type TabType = 'text' | 'call' | 'character' | 'vtt' | 'spotify' | 'whisper';

export interface Tab {
  id: string;
  title: string;
  type: TabType;
  pane: 'left' | 'right';
  active: boolean;
  character?: ICharacter;
  whisperRecipient?: any;
}

@Injectable({ providedIn: 'root' })
export class TabService {

  private tabs = new BehaviorSubject<Tab[]>([]);
  tabs$ = this.tabs.asObservable();

  activeTabId$ = this.tabs$.pipe(map(tabs => tabs.find(t => t.active)?.id));

  constructor(private videoService: Video) {}

  openTab(id: string, title: string, type: TabType, pane: "left" | "right" = 'left', character?: ICharacter) {
    const current = this.tabs.value;
    const existing = current.find(t => t.id === id);

    if (existing) {
      this.selectTab(id);
    } else {
      const newTab: Tab = { id, title, type, pane, active: true, character };
      // Deactivate others in the same pane
      const updated = current.map(t => t.pane === pane ? { ...t, active: false } : t);
      const res = [...updated.map(t=> (t.id === id ? {...t, active: true} : t))];
      if(!existing) res.push(newTab);
      this.tabs.next(res);
    }
  }

  selectTab(id: string) {
    const tabs = this.tabs.value;
    const target = tabs.find(t => t.id === id);
    if (!target) return;

    this.tabs.next(tabs.map(t => ({
      ...t,
      active: t.pane === target.pane ? t.id === id : t.active
    })));
  }

  moveTab(tabId: string, targetPane: 'left' | 'right') {
    this.tabs.next(this.tabs.value.map(t =>
      t.id === tabId ? { ...t, pane: targetPane, active: true } :
        (t.pane === targetPane ? { ...t, active: false } : t)
    ));
  }

  closeTab(id: string) {
    const tabToRemove = this.tabs.value.find(t => t.id === id);
    if (tabToRemove && tabToRemove.type === 'call') {
      this.videoService.leaveCall(id);
    }
    this.tabs.next(this.tabs.value.filter(t => t.id !== id));
  }

  closeAllTabs() {
    this.tabs.next([]);
  }

  updateTab(id: string, data: Partial<Tab>) {
    const current = this.tabs.value;
    const updated = current.map(t => t.id === id ? { ...t, ...data } : t);
    this.tabs.next(updated);
  }
}

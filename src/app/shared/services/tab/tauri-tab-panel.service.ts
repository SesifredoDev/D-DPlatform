import { Injectable } from '@angular/core';
import { TabPanel } from './tab-service';

@Injectable({ providedIn: 'root' })
export class TauriTabPanelService {
  isAvailable(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  async openPanel(panel: TabPanel): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(panel.id);

    if (existing) {
      await existing.setFocus();
      return true;
    }

    const webview = new WebviewWindow(panel.id, {
      url: this.buildPanelUrl(panel.id),
      title: panel.title,
      width: 760,
      height: 560,
      minWidth: 420,
      minHeight: 320,
      resizable: true,
      focus: true,
      decorations: true,
      dragDropEnabled: false,
      useHttpsScheme: true,
      parent: 'main'
    });

    return new Promise(resolve => {
      void webview.once('tauri://created', () => resolve(true));
      void webview.once<string>('tauri://error', error => {
        console.error('Failed to create Tauri tab panel', error.payload);
        resolve(false);
      });
    });
  }

  private buildPanelUrl(panelId: string): string {
    return `index.html?tabPanel=${encodeURIComponent(panelId)}`;
  }
}

import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './shared/services/theme/theme.service';
import { TabPanel } from './pages/dashboard/tab-panel/tab-panel';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { DndSearchDrawer } from './shared/components/dnd-search-drawer/dnd-search-drawer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, TabPanel, DndSearchDrawer],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  protected readonly title = signal('d-d-platform');
  readonly tabPanelId = new URLSearchParams(window.location.search).get('tabPanel');
  private mainWindowCloseUnlisten?: UnlistenFn;
  private mainWindowDestroying = false;

  constructor(private themeService: ThemeService) {
    // ThemeService constructor handles initial theme application to document root
  }

  ngOnInit() {
    void this.setupMainWindowCloseHandler();
  }

  ngOnDestroy() {
    this.mainWindowCloseUnlisten?.();
  }

  private async setupMainWindowCloseHandler() {
    if (this.tabPanelId || !this.isTauriRuntime()) return;

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const currentWindow = getCurrentWindow();

    this.mainWindowCloseUnlisten = await currentWindow.onCloseRequested(async event => {
      if (this.mainWindowDestroying) return;

      event.preventDefault();
      this.mainWindowDestroying = true;

      try {
        const windows = await WebviewWindow.getAll();
        await Promise.all(windows
          .filter(windowRef => windowRef.label.startsWith('tab-panel-'))
          .map(windowRef => windowRef.destroy().catch(error => {
            console.warn('Failed to destroy tab panel window', windowRef.label, error);
          })));
      } catch (error) {
        console.warn('Failed to collect tab panel windows during app close', error);
      } finally {
        await currentWindow.destroy();
      }
    });
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }
}

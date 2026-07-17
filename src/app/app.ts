import { Component, OnDestroy, OnInit, ViewChild, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './shared/services/theme/theme.service';
import { Dashboard } from './pages/dashboard/dashboard';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { DndSearchDrawer } from './shared/components/dnd-search-drawer/dnd-search-drawer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, Dashboard, DndSearchDrawer],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  @ViewChild(DndSearchDrawer) private dndSearchDrawer?: DndSearchDrawer;

  protected readonly title = signal('d-d-platform');
  protected readonly isTauriWindow = signal(false);
  protected readonly isWindowFullscreen = signal(false);
  protected readonly isWindowMaximized = signal(false);
  readonly tabPanelId = new URLSearchParams(window.location.search).get('tabPanel');
  private mainWindowCloseUnlisten?: UnlistenFn;
  private windowStateUnlistens: UnlistenFn[] = [];
  private mainWindowDestroying = false;
  private currentWindow?: TauriWindow;

  constructor(private themeService: ThemeService) {
    // ThemeService constructor handles initial theme application to document root
  }

  ngOnInit() {
    void this.setupWindowFrame();
  }

  ngOnDestroy() {
    this.mainWindowCloseUnlisten?.();
    for (const unlisten of this.windowStateUnlistens) {
      unlisten();
    }
  }

  protected async startWindowDrag(event: MouseEvent) {
    if (event.button !== 0 || this.isInteractiveWindowFrameTarget(event.target)) return;

    event.preventDefault();
    if (!this.isWindowFullscreen()) {
      await this.runWindowAction('start window drag', windowRef => windowRef.startDragging());
      return;
    }

    await this.runWindowAction('start window drag', async windowRef => {
      await windowRef.setFullscreen(false);
      await this.syncWindowState();
      await windowRef.startDragging();
    });
  }

  protected async shrinkWindow() {
    await this.runWindowAction('minimize window', windowRef => windowRef.minimize());
  }

  protected async toggleMaximize() {
    await this.runWindowAction('toggle window maximize', async windowRef => {
      if (this.isWindowFullscreen()) {
        await windowRef.setFullscreen(false);
      }

      await windowRef.toggleMaximize();
      await this.syncWindowState();
    });
  }

  protected async toggleFullscreen() {
    await this.runWindowAction('toggle fullscreen', async windowRef => {
      const fullscreen = await windowRef.isFullscreen();
      await windowRef.setFullscreen(!fullscreen);
      await this.syncWindowState();
    });
  }

  protected async closeWindow() {
    await this.runWindowAction('close window', windowRef => windowRef.close());
  }

  protected openDndSearch() {
    this.dndSearchDrawer?.openAndFocus();
  }

  private async setupWindowFrame() {
    if (!this.isTauriRuntime()) return;

    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    this.currentWindow = getCurrentWindow();
    this.isTauriWindow.set(true);

    await this.syncWindowState();
    this.windowStateUnlistens.push(
      await this.currentWindow.onResized(() => {
        void this.syncWindowState();
      })
    );

    await this.setupMainWindowCloseHandler();
  }

  private async setupMainWindowCloseHandler() {
    if (this.tabPanelId || !this.currentWindow) return;

    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const currentWindow = this.currentWindow;

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

  private async runWindowAction(
    actionName: string,
    action: (windowRef: TauriWindow) => Promise<void>
  ) {
    if (!this.currentWindow) return;

    try {
      await action(this.currentWindow);
    } catch (error) {
      console.warn(`Failed to ${actionName}`, error);
    }
  }

  private async syncWindowState() {
    if (!this.currentWindow) return;

    try {
      const [fullscreen, maximized] = await Promise.all([
        this.currentWindow.isFullscreen(),
        this.currentWindow.isMaximized()
      ]);
      this.isWindowFullscreen.set(fullscreen);
      this.isWindowMaximized.set(maximized);
    } catch (error) {
      console.warn('Failed to sync window state', error);
    }
  }

  private isInteractiveWindowFrameTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('button, a, input, textarea, select');
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }
}

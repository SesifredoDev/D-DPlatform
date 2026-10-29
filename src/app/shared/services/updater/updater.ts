import { Injectable } from '@angular/core';
import {tap} from 'rxjs/operators';
import {HttpClient, HttpResponse} from '@angular/common/http';
import {environment} from '../../../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class Updater {

  private readonly API = environment.apiURL;
  constructor(private http: HttpClient) {
    this.test();
  }
  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }
  test(){
    this.http
      .post<{ accessToken: string }>(
        `${this.API}/api/desktop-updates/latest?target=windows&arch=x86_64&current_version=1.0.5`,
        { withCredentials: true }
      ).subscribe({
      next: (response: any) => {
        console.log(response);
      }
    });
  }


  async checkForDesktopUpdate() {
    console.log("is runnning update function");
    console.log("is turi running?", this.isTauriRuntime());
    console.log("maaaybeee 👀");

    if (!this.isTauriRuntime()) return;

    const updateLogPrefix = '[desktop-update]';
    const updateStartedAt = Date.now();

    try {
      console.log(`${updateLogPrefix} check started`, {
        at: new Date(updateStartedAt).toISOString(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
      });

      const { check } = await import('@tauri-apps/plugin-updater');
      console.log(`${updateLogPrefix} updater module loaded`);

      const update = await check();
      console.log(`${updateLogPrefix} check completed`, {
        hasUpdate: !!update,
        elapsedMs: Date.now() - updateStartedAt
      });

      if (!update) {
        console.log(`${updateLogPrefix} no update available`);
        return;
      }

      console.log(`${updateLogPrefix} update metadata`, {
        currentVersion: update.currentVersion,
        targetVersion: update.version,
        releaseDate: update.date ?? null,
        releaseNotesLength: update.body?.length ?? 0,
        rawJson: update.rawJson
      });

      let downloadedBytes = 0;
      await update.downloadAndInstall(event => {
        switch (event.event) {
          case 'Started':
            console.log(`${updateLogPrefix} download started`, {
              contentLength: event.data.contentLength ?? null
            });
            break;
          case 'Progress':
            downloadedBytes += event.data.chunkLength;
            console.log(`${updateLogPrefix} download progress`, {
              chunkLength: event.data.chunkLength,
              downloadedBytes
            });
            break;
          case 'Finished':
            console.log(`${updateLogPrefix} download finished`, { downloadedBytes });
            break;
        }
      });

      console.log(`${updateLogPrefix} install triggered (app may close on Windows)`, {
        elapsedMs: Date.now() - updateStartedAt
      });
    } catch (error) {
      console.warn(`${updateLogPrefix} failed`, {
        elapsedMs: Date.now() - updateStartedAt,
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null
      });
    }
  }

}

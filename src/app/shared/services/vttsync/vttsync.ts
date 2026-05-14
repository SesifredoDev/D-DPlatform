import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import {TokenService} from '../auth/token';
import {ICharacter} from '../../models/user/character.model';
import {VttEngine} from '../../modules/vttEngine/VttEngine';
import {Video} from '../video/video';
import {environment} from '../../../../environments/environment';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { FileService } from '../file/file';

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

interface SyncActionPayload {
  action: string;
  data: any;
  version?: number;
  sourceId?: string;
}

@Injectable({ providedIn: 'root' })
export class VttSync {
  private socket: Socket | null = null;
  public currentRoomId: string | null = null;
  public isHosting = false;
  public isConnected = false;
  private engine: VttEngine| null = null;

  private localVersion = 0;
  private resyncing = false;
  private hostClaimedAt = 0;
  private localCharacter: ICharacter | null = null;
  private needsSessionRestore = false;
  private isStopping = false;

  public hostDisconnected$ = new BehaviorSubject<boolean>(false);
  public sessionEnded$ = new Subject<void>();
  public turnOrder$ = new BehaviorSubject<TurnOrderState>({
    isActive: false,
    isConfirmed: false,
    entries: [],
    activeIndex: 0
  });
  public playersCanControlAllPlayerTokens$ = new BehaviorSubject<boolean>(false);
  public playersCanUseFx$ = new BehaviorSubject<boolean>(false);
  public gridSettings$ = new BehaviorSubject<GridSettings>({
    size: 50,
    color: '#cccccc',
    thickness: 1,
    type: 'square'
  });

  public mapLoading$ = new BehaviorSubject<MapLoadingState>({
      loading: false,
      progress: 0,
      message: ''
  });

  private readonly mapApiUrl = `${environment.apiURL}map`;

  constructor(
    private tokenService: TokenService,
    private callService: Video,
    private http: HttpClient,
    private fileService: FileService
  ) {
  }

  private getSocket(): Socket {
    if (!this.socket) {
      this.socket = io(`${environment.mapUrl}`, {
        path: '/map/',
        withCredentials: true,
        transports: ['websocket'],
        auth: (cb) => {
          cb({ token: this.tokenService.getAccessToken() })
        }
      });

      this.socket.on('connect', () => {
        this.isConnected = true;
        if (this.needsSessionRestore) {
          this.restoreSessionAfterReconnect();
        }
      });

      this.socket.on('connect_error', (err) => {
        console.error('Socket Connection Error:', err.message);
        this.isConnected = false;
      });

      this.socket.on('host-disconnected', () => {
        console.warn('The DM has disconnected. You can assume hosting.');
        this.hostDisconnected$.next(true);
      });

      this.socket.on('session-ended', () => {
        console.warn('The DM has ended the VTT session.');
        this.sessionEnded$.next();
        this.stopSyncing(true);
      });

      this.socket.on('host-changed', (payload: any) => {
        if (payload.hostId === this.socket?.id) {
          this.hostDisconnected$.next(false);
          return;
        }

        if (this.isHosting && Date.now() - this.hostClaimedAt < 2000) {
          return;
        }

        if (payload.hostId !== this.socket?.id) {
            this.hostDisconnected$.next(false);
            if (this.isHosting) {
                this.isHosting = false;
                if (this.engine) this.engine.setPermissions(false);
            }
        }
      });

      this.socket.on('disconnect', () => {
          this.isConnected = false;
          if (!this.isStopping && this.currentRoomId) {
            this.needsSessionRestore = true;
          }
      });

      this.socket.on('reconnect', () => {
          this.isConnected = true;
          this.restoreSessionAfterReconnect();
      });
    }
    return this.socket;
  }

  private restoreSessionAfterReconnect() {
      if (!this.currentRoomId || !this.engine) return;

      const socket = this.getSocket();
      if (!socket.connected) return;

      const roomId = this.currentRoomId;
      this.needsSessionRestore = false;
      this.resyncing = false;

      if (this.isHosting) {
          socket.emit('host-session', {
              roomId,
              initialState: this.createHostState(this.engine)
          });
          return;
      }

      if (this.localCharacter) {
          socket.emit('join-session', { roomId, character: this.localCharacter });
          return;
      }

      this.requestResync();
  }

  private waitForConnection(timeoutMs: number = 3000): Promise<boolean> {
    const socket = this.getSocket();
    if (socket.connected) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;

      const settle = (connected: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        socket.off('connect', onConnect);
        resolve(connected);
      };

      const onConnect = () => settle(true);
      const timer = window.setTimeout(() => settle(socket.connected), timeoutMs);

      socket.on('connect', onConnect);
    });
  }

  async getSessionStatus(roomId: string, timeoutMs: number = 2000): Promise<SessionStatus> {
    const connected = await this.waitForConnection(timeoutMs);
    if (!connected) {
      return {
        ok: false,
        active: false,
        hasHost: false,
        hostId: null,
        version: 0,
        reason: 'socket-not-connected'
      };
    }

    const socket = this.getSocket();

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        resolve({
          ok: false,
          active: false,
          hasHost: false,
          hostId: null,
          version: 0,
          reason: 'timeout'
        });
      }, timeoutMs);

      socket.emit('session-status', { roomId }, (response?: Partial<SessionStatus>) => {
        window.clearTimeout(timer);
        resolve({
          ok: response?.ok === true,
          active: !!response?.active,
          hasHost: !!response?.hasHost,
          hostId: response?.hostId ?? null,
          version: typeof response?.version === 'number' ? response.version : 0,
          reason: response?.reason
        });
      });
    });
  }

  requestResync() {
      if (!this.currentRoomId || this.resyncing) return;
      console.log('Requesting resync for room:', this.currentRoomId);
      this.resyncing = true;
      this.getSocket().emit('request-resync', this.currentRoomId);
  }

  private createHostState(engine: VttEngine) {
      return {
          ...engine.getRawConfig(),
          turnOrder: this.turnOrder$.value,
          playersCanControlAllPlayerTokens: this.playersCanControlAllPlayerTokens$.value,
          playersCanUseFx: this.playersCanUseFx$.value
      };
  }

  startHosting(engine: VttEngine, roomId: string, options: StartHostingOptions = {}) {
    this.currentRoomId = roomId;
    this.isHosting = true;
    this.engine = engine;
    this.needsSessionRestore = false;

    const socket = this.getSocket();
    let announcedHosting = false;
    this.hostClaimedAt = Date.now();

    socket.off('remote-action');
    socket.on('remote-action', (payload: any) => {
      this.handleRemoteAction(engine, payload);
    });

    socket.off('host-action-request');
    socket.on('host-action-request', (payload: any) => {
      this.handleHostActionRequest(engine, payload);
    });

    socket.off('map-update');
    socket.on('map-update', (config: any) => {
      this.applyMapState(engine, config);
      if (!announcedHosting && this.isHosting && this.currentRoomId === roomId) {
        announcedHosting = true;
        this.callService.sendVttCommand('start', roomId);
      }
    });

    this.attachEngineListeners(engine);

    socket.emit('host-session', {
      roomId,
      initialState: options.preserveExistingState ? null : this.createHostState(engine)
    });

    this.hostDisconnected$.next(false);
  }

  joinSession(engine: VttEngine, roomId: string, character: ICharacter): Promise<boolean> {
    this.currentRoomId = roomId;
    this.isHosting = false;
    this.engine = engine;
    this.localCharacter = character;
    this.needsSessionRestore = false;

    engine.setLocalCharacter(character);

    const socket = this.getSocket();

    socket.off('map-update');
    socket.off('remote-action');
    socket.off('host-action-request');
    socket.off('error');

    return new Promise((resolve) => {
      let settled = false;
      let receivedMapUpdate = false;
      let receivedHostState = false;
      let hostStateTimeout: number | null = null;
      const hostChangedHandler = () => {
        receivedHostState = true;
        resolveWhenReady();
      };
      const sessionEndedHandler = () => settle(false);
      const settle = (joined: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(joinTimeout);
        if (hostStateTimeout !== null) {
          window.clearTimeout(hostStateTimeout);
        }
        socket.off('host-changed', hostChangedHandler);
        socket.off('session-ended', sessionEndedHandler);
        resolve(joined);
      };

      const resolveWhenReady = () => {
        if (!receivedMapUpdate) return;
        if (receivedHostState) {
          settle(true);
          return;
        }

        hostStateTimeout ??= window.setTimeout(() => settle(true), 1000);
      };

      const joinTimeout = window.setTimeout(() => {
        console.warn('VTT Sync Error: Timed out while joining room:', roomId);
        settle(false);
      }, 5000);

      socket.once('host-changed', hostChangedHandler);
      socket.once('session-ended', sessionEndedHandler);

      socket.on('map-update', (config: any) => {
        this.applyMapState(engine, config);
        receivedMapUpdate = true;
        resolveWhenReady();
      });

      socket.on('remote-action', (payload: any) => {
        this.handleRemoteAction(engine, payload);
      });

      socket.on('error', (msg: string) => {
        console.warn('VTT Sync Error:', msg);
        settle(false);
      });

      this.attachEngineListeners(engine);
      socket.emit('join-session', { roomId, character });
    });
  }

  private applyMapState(engine: VttEngine, config: any) {
    if (!config) return;

    this.resyncing = false;
    if (config.version !== undefined) {
      this.localVersion = config.version;
    }

    engine.loadConfigFromObject(config);
    this.publishGridSettings(engine);

    if (config.turnOrder) {
      this.turnOrder$.next(config.turnOrder);
    }
    this.applyPlayerTokenControlMode(engine, !!config.playersCanControlAllPlayerTokens);
    this.applyPlayerFxPermissionMode(engine, !!config.playersCanUseFx);
  }

  endSession() {
    this.stopSyncing(true, true);
  }

  stopSyncing(force: boolean = false, endHostedSession: boolean = false) {
    if (!force) return;

    if (this.socket) {
      const socket = this.socket;
      const roomId = this.currentRoomId;
      this.isStopping = true;

      if (!roomId) {
        socket.disconnect();
      } else if (this.isHosting && endHostedSession) {
        this.callService.sendVttCommand("stop", roomId);
        socket.emit('stop-hosting', roomId);
        window.setTimeout(() => socket.disconnect(), 250);
      } else {
        socket.emit('leave-session', roomId);
        socket.disconnect();
      }

      this.socket = null;
    }

    this.currentRoomId = null;
    this.isHosting = false;
    this.isConnected = false;
    this.hostDisconnected$.next(false);
    this.engine = null;
    this.localCharacter = null;
    this.needsSessionRestore = false;
    this.isStopping = false;
    this.localVersion = 0;
    this.turnOrder$.next({ isActive: false, isConfirmed: false, entries: [], activeIndex: 0 });
    this.playersCanControlAllPlayerTokens$.next(false);
    this.playersCanUseFx$.next(false);
    this.gridSettings$.next({ size: 50, color: '#cccccc', thickness: 1, type: 'square' });
  }

  broadcastAction(action: string, data: any) {
    const socket = this.getSocket();
    if (!socket.connected || !this.currentRoomId) return;
    const roomId = this.currentRoomId;
    socket.emit('sync-action', {
      roomId,
      action,
      data
    }, (response: any) => {
      if (response?.ok === false && this.currentRoomId === roomId) {
        this.requestResync();
      }
    });
  }

  private attachEngineListeners(engine: VttEngine) {
    engine.stage.off('tokenMoved');
    engine.stage.on('tokenMoved', (e: any) => {
      if (engine.isMeasuring?.()) return;
      this.broadcastAction('token-move', e);
    });

    engine.stage.off('measureAction');
    engine.stage.on('measureAction', (data: any) => {
      this.broadcastAction('measure-sync', data);
    });

    engine.stage.off('ping');
    engine.stage.on('ping', (data: any) => {
      this.broadcastAction('ping', data);
    });

    engine.stage.off('fxAdded');
    engine.stage.on('fxAdded', (event: any) => {
      const effect = event?.effect;
      if (effect) this.broadcastAction('fx-added', effect);
    });

    engine.stage.off('fxDeleted');
    engine.stage.on('fxDeleted', (event: any) => {
      if (event?.id) this.broadcastAction('fx-deleted', { id: event.id });
    });

    engine.stage.off('fxCleared');
    engine.stage.on('fxCleared', () => {
      this.broadcastAction('fx-cleared', {});
    });

    engine.stage.off('mapLoadingStarted');
    engine.stage.on('mapLoadingStarted', () => {
        this.mapLoading$.next({ loading: true, progress: 0, message: 'Processing map image...' });
    });

    engine.stage.off('mapLoadingFinished');
    engine.stage.on('mapLoadingFinished', () => {
        this.mapLoading$.next({ loading: false, progress: 0, message: '' });
    });

    engine.stage.off('tokenAdded');
    engine.stage.on('tokenAdded', (data: any) => {
      if (!data.remote) this.broadcastAction('token-added', data);
    });

    engine.stage.off('tokenDeleted');
    engine.stage.on('tokenDeleted', (data: any) => {
      if (!data.remote) this.broadcastAction('token-deleted', data);
    });

    engine.stage.off('tokenUpdated');
    engine.stage.on('tokenUpdated', (data: any) => {
      if (!data.remote) this.broadcastAction('token-update', data);
    });

    if (this.isHosting) {
      engine.stage.off('wallAdded');
      engine.stage.on('wallAdded', (data: any) => {
        this.broadcastAction('wall-added', data);
      });

      engine.stage.off('wallDeleted');
      engine.stage.on('wallDeleted', (data: any) => {
        this.broadcastAction('wall-deleted', data);
      });

      engine.stage.off('lightingToggled');
      engine.stage.on('lightingToggled', (data: any) => {
        this.broadcastAction('lighting-toggle', data);
      });

      engine.stage.off('gridSizeChanged');
      engine.stage.on('gridSizeChanged', (data: any) => {
        this.broadcastAction('grid-size-change', data);
      });

      engine.stage.off('gridSettingsChanged');
      engine.stage.on('gridSettingsChanged', (data: any) => {
        const settings = this.normalizeGridSettings(data);
        this.gridSettings$.next(settings);
        this.broadcastAction('grid-settings-change', settings);
      });
    }
  }


  private handleRemoteAction(engine: VttEngine, payload: SyncActionPayload) {
    if (!payload?.action) return;

    const { action, data, version, sourceId } = payload;
    const isOwnEcho = !!sourceId && sourceId === this.socket?.id;

    if (version !== undefined) {
        if (isOwnEcho) {
            this.localVersion = Math.max(this.localVersion, version);
            return;
        }

        if (version <= this.localVersion) {
            return;
        }

        if (version > this.localVersion + 1) {
            console.warn(`Out of sync! Local: ${this.localVersion}, Remote: ${version}. Requesting resync.`);
            this.requestResync();
            return;
        }
        this.localVersion = version;
    } else if (isOwnEcho) {
      return;
    }

    this.applyRemoteAction(engine, action, data);
  }

  private handleHostActionRequest(engine: VttEngine, payload: SyncActionPayload) {
    if (!this.isHosting || !payload?.action) return;

    const { action, data } = payload;

    if (action === 'turn-order-add') {
      this.addTurnOrderEntry(data);
      return;
    }

    if (action === 'turn-order-remove') {
      this.removeTurnOrderEntry(data.id);
      return;
    }

    this.applyRemoteAction(engine, action, data);
    this.broadcastAction(action, data);
  }

  private applyRemoteAction(engine: VttEngine, action: string, data: any) {
    switch (action) {
      case 'token-move':
        engine.animateTokenMove(data.id, data.x, data.y);
        break;

      case 'wall-added':
        engine.wallManager.addSingleWall(data.points);
        break;

      case 'wall-deleted':
        engine.wallManager.deleteWallByPoints(data.points);
        break;


      case 'token-added':
        engine.addToken(data.x, data.y, data.options, true);
        break;

      case 'token-deleted':
        engine.removeToken(data.id, true);
        break;

      case 'token-update':
        engine.updateTokenConfig(data.id, data.options, true);
        break;

      case 'lighting-toggle':
        engine.lightLayer.visible(data.visible);
        engine.updateLighting();
        break;

      case 'grid-size-change':
        engine.updateGridSize(data.size, true);
        this.publishGridSettings(engine);
        break;

      case 'grid-settings-change':
        engine.updateGridSettings(data, true);
        this.publishGridSettings(engine);
        break;

      case 'map-change':
        engine.setBackground(data.url, true);
        break;

      case 'map-load':
        engine.loadConfigFromObject(data);
        this.publishGridSettings(engine);
        if (data.turnOrder) {
            this.turnOrder$.next(data.turnOrder);
        }
        if (data.playersCanControlAllPlayerTokens !== undefined) {
          this.applyPlayerTokenControlMode(engine, data.playersCanControlAllPlayerTokens);
        }
        if (data.playersCanUseFx !== undefined) {
          this.applyPlayerFxPermissionMode(engine, data.playersCanUseFx);
        }
        break;

      case 'measure-sync':
        if (engine.measurementManager) {
          engine.measurementManager.handleRemoteAction(data);
        }
        break;

      case 'ping':
        engine.showPing(data.x, data.y, data.color);
        break;

      case 'player-token-control-change':
        this.applyPlayerTokenControlMode(engine, data.enabled);
        break;

      case 'fx-added':
        engine.addFxEffect(data, true);
        break;

      case 'fx-deleted':
        engine.removeFxEffect(data.id, true);
        break;

      case 'fx-cleared':
        engine.clearFxEffects(true);
        break;

      case 'player-fx-permission-change':
        this.applyPlayerFxPermissionMode(engine, data.enabled);
        break;

      case 'turn-order-sync':
        this.turnOrder$.next(data);
        break;

      case 'turn-order-add':
        if (this.isHosting) this.addTurnOrderEntry(data);
        break;

      case 'turn-order-remove':
        if (this.isHosting) this.removeTurnOrderEntry(data.id);
        break;
    }
    engine.stage.batchDraw();
  }

  addCharacterToken(engine: VttEngine, character: ICharacter, x?: number, y?: number) {
    const posX = x ?? 100;
    const posY = y ?? 100;

    const tokenOptions = {
      id: crypto.randomUUID(),
      name: character.name,
      icon: character.icon,
      ownerId: character.ownerId,
      isPlayer: true
    };

    engine.addToken(posX, posY, tokenOptions, false);
  }

  async setMap(mapSource: File | string, onProgress?: (progress: number) => void): Promise<void> {
    if (!this.engine) {
      console.error('VttEngine not initialized.');
      return;
    }

    let mapUrl: string;

    if (typeof mapSource === 'string') {
      mapUrl = mapSource;
    } else {
      if (!this.isHosting) {
        console.warn('Only the host can upload new map images directly.');
        return;
      }
      try {
        this.mapLoading$.next({ loading: true, progress: 0, message: 'Uploading map...' });
        const uploadedFile = await this.fileService.uploadFileInChunks(mapSource, (progress) => {
            this.mapLoading$.next({ loading: true, progress, message: `Uploading map (${progress}%)...` });
            if (onProgress) onProgress(progress);
        });
        mapUrl = uploadedFile.url;
      } catch (error) {
        this.mapLoading$.next({ loading: false, progress: 0, message: '' });
        console.error('Failed to upload map image:', error);
        throw error;
      }
    }

    this.engine.setBackground(mapUrl, false);

    if (this.isHosting) {
      this.broadcastAction('map-change', { url: mapUrl });
    }
  }

  async updateToken(tokenId: string, options: any, iconFile?: File): Promise<void> {
    if (!this.engine) return;

    if (iconFile) {
      try {
        this.mapLoading$.next({ loading: true, progress: 0, message: 'Uploading token icon...' });
        const uploadedFile = await this.fileService.uploadFileInChunks(iconFile, (progress) => {
          this.mapLoading$.next({ loading: true, progress, message: `Uploading icon (${progress}%)...` });
        });
        options.icon = uploadedFile.url;
      } catch (error) {
        this.mapLoading$.next({ loading: false, progress: 0, message: '' });
        console.error('Failed to upload token icon:', error);
        return;
      }
    }

    this.engine.updateTokenConfig(tokenId, options, false);
    this.mapLoading$.next({ loading: false, progress: 0, message: '' });
  }

  public setPlayersCanControlAllPlayerTokens(enabled: boolean) {
    if (!this.engine) return;

    this.applyPlayerTokenControlMode(this.engine, enabled);
    if (this.isHosting) {
      this.broadcastAction('player-token-control-change', { enabled });
    }
  }

  public setPlayersCanUseFx(enabled: boolean) {
    if (!this.engine) return;

    this.applyPlayerFxPermissionMode(this.engine, enabled);
    if (this.isHosting) {
      this.broadcastAction('player-fx-permission-change', { enabled });
    }
  }

  private applyPlayerTokenControlMode(engine: VttEngine, enabled: boolean) {
    const normalized = !!enabled;
    engine.setPlayerTokenControlMode(normalized);
    this.playersCanControlAllPlayerTokens$.next(normalized);
  }

  private applyPlayerFxPermissionMode(engine: VttEngine, enabled: boolean) {
    const normalized = !!enabled;
    engine.setPlayerFxPermissionMode(normalized);
    this.playersCanUseFx$.next(normalized);
  }

  public updateGridSettings(settings: Partial<GridSettings>) {
    if (!this.engine) return;

    this.engine.updateGridSettings(settings, false);
    this.publishGridSettings(this.engine);
  }

  private publishGridSettings(engine: VttEngine) {
    this.gridSettings$.next(this.normalizeGridSettings(engine.getGridSettings()));
  }

  private normalizeGridSettings(settings: any): GridSettings {
    const size = parseInt(settings?.size ?? settings?.gridSize ?? 50, 10);
    const thickness = parseFloat(settings?.thickness ?? settings?.gridThickness ?? 1);

    return {
      size: Number.isFinite(size) ? Math.max(8, size) : 50,
      color: settings?.color ?? settings?.gridColor ?? '#cccccc',
      thickness: Number.isFinite(thickness) ? Math.max(0.25, thickness) : 1,
      type: (settings?.gridType ?? settings?.type) === 'hex' ? 'hex' : 'square'
    };
  }

  public updateTurnOrder(state: TurnOrderState) {
    this.turnOrder$.next(state);
    if (this.isHosting) {
        this.broadcastAction('turn-order-sync', state);
    }
  }

  public activateTurnOrder() {
    this.updateTurnOrder({
      isActive: true,
      isConfirmed: false,
      entries: [],
      activeIndex: 0
    });
  }

  public endTurnOrder() {
    this.updateTurnOrder({
      isActive: false,
      isConfirmed: false,
      entries: [],
      activeIndex: 0
    });
  }

  public confirmTurnOrder() {
    const currentState = this.turnOrder$.value;
    const sortedEntries = [...currentState.entries].sort((a, b) => b.initiative - a.initiative);
    this.updateTurnOrder({
      ...currentState,
      isConfirmed: true,
      entries: sortedEntries,
      activeIndex: 0
    });
  }

  public nextTurn() {
    const currentState = this.turnOrder$.value;
    if (!currentState.entries.length) return;
    const nextIndex = (currentState.activeIndex + 1) % currentState.entries.length;
    this.updateTurnOrder({
      ...currentState,
      activeIndex: nextIndex
    });
  }

  public prevTurn() {
    const currentState = this.turnOrder$.value;
    if (!currentState.entries.length) return;
    const prevIndex = (currentState.activeIndex - 1 + currentState.entries.length) % currentState.entries.length;
    this.updateTurnOrder({
      ...currentState,
      activeIndex: prevIndex
    });
  }

  public addTurnOrderEntry(entry: TurnOrderEntry) {
    if (this.isHosting || !this.getSocket().connected) {
      const currentState = this.turnOrder$.value;
      const newEntries = [...currentState.entries, entry];
      if (currentState.isConfirmed) {
        newEntries.sort((a, b) => b.initiative - a.initiative);
      }
      this.updateTurnOrder({ ...currentState, entries: newEntries });
    } else {
      this.broadcastAction('turn-order-add', entry);
    }
  }

  public removeTurnOrderEntry(entryId: string) {
    if (this.isHosting || !this.getSocket().connected) {
      const currentState = this.turnOrder$.value;
      this.updateTurnOrder({
        ...currentState,
        entries: currentState.entries.filter(e => e.id !== entryId)
      });
    } else {
      this.broadcastAction('turn-order-remove', { id: entryId });
    }
  }

  getEngine() {
    return this.engine;
  }

  async saveMapLibrary(library: MapLibraryEntry[]): Promise<void> {
    await firstValueFrom(this.http.post(`${this.mapApiUrl}/library`, { library }, { withCredentials: true }));
  }

  async loadMapLibrary(): Promise<MapLibraryEntry[]> {
    try {
      return await firstValueFrom(this.http.get<MapLibraryEntry[]>(`${this.mapApiUrl}/library`, { withCredentials: true }));
    } catch (e) {
      console.error('Failed to load map library', e);
      return [];
    }
  }

  async saveMap(map: MapLibraryEntry): Promise<void> {
    await firstValueFrom(this.http.post(`${this.mapApiUrl}/save`, map, { withCredentials: true }));
  }

  async deleteMap(mapId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.mapApiUrl}/${mapId}`, { withCredentials: true }));
  }
}

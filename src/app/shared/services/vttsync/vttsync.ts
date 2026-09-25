import { Injectable, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import {TokenService} from '../auth/token';
import {ICharacter} from '../../models/user/character.model';
import {VttEngine} from '../../modules/vttEngine/VttEngine';
import {Video} from '../video/video';
import {environment} from '../../../../environments/environment';
import { BehaviorSubject, firstValueFrom, Subject, Subscription } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { FileService } from '../file/file';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { SessionRecordingService } from '../session-recording/session-recording';
import type { TurnOrderEntry, TurnOrderState, MapLibraryEntry, MapLoadingState, GridSettings, StartHostingOptions, SessionStatus, SyncActionPayload, VttCharacterTokenPayload, VttWindowCommand, VttWindowCommandResult, VttWindowMessage, VttWindowTarget } from '../../models/vttsync/vttsync.model';
export type { TurnOrderEntry, TurnOrderState, MapLibraryEntry, MapLoadingState, GridSettings, StartHostingOptions, SessionStatus } from '../../models/vttsync/vttsync.model';
@Injectable({ providedIn: 'root' })
export class VttSync implements OnDestroy {
  private static readonly windowCommandChannelName = 'dd-platform-vtt-window-commands';
  private static readonly windowCommandEventName = 'dd-platform-vtt-window-command';
  private static readonly commandClaimStoragePrefix = 'dd-platform-vtt-command-claim:';
  private static readonly windowTargetStorageKey = 'dd-platform-vtt-window-targets';
  private static readonly windowTargetTtlMs = 5000;
  private static readonly windowTargetHeartbeatMs = 1000;

  private socket: Socket | null = null;
  public currentRoomId: string | null = null;
  public isHosting = false;
  public isConnected = false;
  private engine: VttEngine| null = null;
  private readonly windowInstanceId = this.createWindowInstanceId();
  private currentWindowLabel = this.getFallbackWindowLabel();
  private readonly windowCommandChannel?: BroadcastChannel;
  private windowCommandUnlisten?: UnlistenFn;
  private pendingWindowCommands = new Map<string, {
    resolve: (handled: boolean) => void;
    timeoutId: number;
  }>();
  private handledWindowCommandIds = new Set<string>();
  private activeEngineRoomId: string | null = null;
  private activeEngineAttachmentId: string | null = null;
  private activeEngineTarget: VttWindowTarget | null = null;
  private engineTargetHeartbeatId: number | null = null;
  private pendingEngineDetachId: number | null = null;
  private readonly engineDetachGraceMs = 2000;

  private localVersion = 0;
  private resyncing = false;
  private hostClaimedAt = 0;
  private currentHostId: string | null = null;
  private localCharacter: ICharacter | null = null;
  private needsSessionRestore = false;
  private isStopping = false;
  private recordingStateSub?: Subscription;
  private wasSessionRecordingActive = false;

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
    private fileService: FileService,
    private sessionRecording: SessionRecordingService
  ) {
    this.windowCommandChannel = this.createWindowCommandChannel();
    void this.resolveCurrentWindowLabel();
    void this.setupTauriWindowCommands();
    this.recordingStateSub = this.sessionRecording.recordingState$.subscribe(state => {
      const becameActive = state.active && !this.wasSessionRecordingActive;
      this.wasSessionRecordingActive = state.active;
      if (becameActive) {
        this.captureCurrentVttRecordingState();
      }
    });
  }

  ngOnDestroy() {
    this.clearPendingEngineDetach();
    this.clearActiveEngineTarget();
    this.windowCommandChannel?.close();
    this.windowCommandUnlisten?.();
    this.recordingStateSub?.unsubscribe();
    this.pendingWindowCommands.forEach(pending => window.clearTimeout(pending.timeoutId));
    this.pendingWindowCommands.clear();
    this.handledWindowCommandIds.clear();
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
        this.currentHostId = null;
        this.hostDisconnected$.next(true);
      });

      this.socket.on('session-ended', () => {
        console.warn('The DM has ended the VTT session.');
        this.sessionEnded$.next();
        this.stopSyncing(true);
      });

      this.socket.on('host-changed', (payload: any) => {
        const hostId = typeof payload?.hostId === 'string' ? payload.hostId : null;
        this.currentHostId = hostId;

        if (hostId === this.socket?.id) {
          this.hostDisconnected$.next(false);
          return;
        }

        if (this.isHosting && Date.now() - this.hostClaimedAt < 2000) {
          return;
        }

        if (hostId !== this.socket?.id) {
            this.hostDisconnected$.next(false);
            if (this.isHosting) {
                this.isHosting = false;
                if (this.engine) this.engine.setPermissions(false);
            }
        }
      });

      this.socket.on('disconnect', () => {
          this.isConnected = false;
          this.currentHostId = null;
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

  private captureCurrentVttRecordingState() {
    if (!this.engine) return;

    this.sessionRecording.recordVttInitialState(
      this.currentRoomId ?? this.activeEngineRoomId,
      this.createHostState(this.engine)
    );
  }

  captureRecordingState() {
    this.captureCurrentVttRecordingState();
  }

  startHosting(engine: VttEngine, roomId: string, options: StartHostingOptions = {}) {
    this.clearPendingEngineDetach();
    this.currentRoomId = roomId;
    this.isHosting = true;
    this.engine = engine;
    this.activeEngineRoomId = roomId;
    this.needsSessionRestore = false;
    this.updateActiveEngineTargetHosting(roomId, true);

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

    this.captureCurrentVttRecordingState();
    this.hostDisconnected$.next(false);
  }

  joinSession(engine: VttEngine, roomId: string, character: ICharacter): Promise<boolean> {
    this.clearPendingEngineDetach();
    this.currentRoomId = roomId;
    this.isHosting = false;
    this.engine = engine;
    this.activeEngineRoomId = roomId;
    this.localCharacter = character;
    this.needsSessionRestore = false;
    this.updateActiveEngineTargetHosting(roomId, false);

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
      this.captureCurrentVttRecordingState();
    });
  }

  private applyMapState(engine: VttEngine, config: any, recordSnapshot: boolean = true) {
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

    if (recordSnapshot) {
      this.sessionRecording.recordVttSnapshot(
        this.currentRoomId ?? this.activeEngineRoomId,
        this.createHostState(engine)
      );
    }
  }

  endSession() {
    this.stopSyncing(true, true);
  }

  endSessionForRoom(roomId: string): Promise<boolean> {
    if (this.isHosting && this.currentRoomId === roomId) {
      this.endSession();
      return Promise.resolve(true);
    }

    return this.requestRemoteSessionEnd(roomId);
  }

  stopSyncing(force: boolean = false, endHostedSession: boolean = false) {
    if (!force) return;

    this.clearPendingEngineDetach();

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
    this.currentHostId = null;
    this.hostDisconnected$.next(false);
    this.clearActiveEngineTarget();
    this.engine = null;
    this.activeEngineRoomId = null;
    this.activeEngineAttachmentId = null;
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
    this.sessionRecording.recordVttAction(roomId, action, data, 'local');

    if (action === 'pointer-sync') {
      const emitSocket = (socket as any).volatile ?? socket;
      emitSocket.emit('sync-action', {
        roomId,
        action,
        data
      });
      return;
    }

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

    engine.stage.off('pointerAction');
    engine.stage.on('pointerAction', (data: any) => {
      this.broadcastAction('pointer-sync', data);
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
        if (!isOwnEcho) {
          if (!sourceId || !this.currentHostId || sourceId !== this.currentHostId) {
            console.warn(
              `Ignoring versioned VTT action from non-host source. Expected host=${this.currentHostId}, got=${sourceId}. Requesting resync.`
            );
            this.requestResync();
            return;
          }
        }

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
    this.sessionRecording.recordVttAction(
      this.currentRoomId ?? this.activeEngineRoomId,
      action,
      data,
      'remote'
    );
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

    if (this.isHostOnlyAction(action)) {
      console.warn(`Ignoring non-host VTT action: ${action}`);
      return;
    }

    this.applyRemoteAction(engine, action, data);
    this.broadcastAction(action, data);
  }

  private isHostOnlyAction(action: string): boolean {
    return [
      'token-added',
      'token-deleted',
      'token-update',
      'wall-added',
      'wall-deleted',
      'lighting-toggle',
      'grid-size-change',
      'grid-settings-change',
      'map-change',
      'map-load',
      'player-token-control-change',
      'player-fx-permission-change'
    ].includes(action);
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
        engine.showPing(data.x, data.y, data.userId ? engine.getUserColor(data.userId) : data.color);
        break;

      case 'pointer-sync':
        engine.handleRemotePointerAction(data);
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

  applyPlaybackSnapshot(engine: VttEngine, state: any) {
    this.applyMapState(engine, state, false);
  }

  applyPlaybackAction(engine: VttEngine, action: string, data: any) {
    this.applyRemoteAction(engine, action, data);
  }

  attachEngine(engine: VttEngine, roomId: string): string {
    this.clearPendingEngineDetach();
    const attachmentId = this.createWindowInstanceId();
    this.engine = engine;
    this.activeEngineRoomId = roomId;
    this.activeEngineAttachmentId = attachmentId;
    this.activeEngineTarget = {
      sourceId: this.windowInstanceId,
      attachmentId,
      roomId,
      windowLabel: this.currentWindowLabel,
      isHosting: this.isHosting && this.currentRoomId === roomId,
      updatedAt: Date.now()
    };
    this.publishActiveEngineTarget();
    this.startEngineTargetHeartbeat();
    void this.resolveCurrentWindowLabel();
    this.captureCurrentVttRecordingState();
    return attachmentId;
  }

  detachEngine(engine: VttEngine, roomId: string, attachmentId?: string | null) {
    if (attachmentId && this.activeEngineAttachmentId !== attachmentId) return;
    if (this.engine !== engine) return;
    if (this.activeEngineRoomId && this.activeEngineRoomId !== roomId) return;

    if (this.currentRoomId === roomId) {
      this.scheduleEngineDetach(engine, roomId, attachmentId);
      return;
    }

    this.detachEngineNow(engine, roomId, attachmentId);
  }

  private scheduleEngineDetach(engine: VttEngine, roomId: string, attachmentId?: string | null) {
    this.clearPendingEngineDetach();
    this.pendingEngineDetachId = window.setTimeout(() => {
      this.pendingEngineDetachId = null;
      this.detachEngineNow(engine, roomId, attachmentId);
    }, this.engineDetachGraceMs);
  }

  private clearPendingEngineDetach() {
    if (this.pendingEngineDetachId === null) return;

    window.clearTimeout(this.pendingEngineDetachId);
    this.pendingEngineDetachId = null;
  }

  private detachEngineNow(engine: VttEngine, roomId: string, attachmentId?: string | null) {
    if (attachmentId && this.activeEngineAttachmentId !== attachmentId) return;
    if (this.engine !== engine) return;
    if (this.activeEngineRoomId && this.activeEngineRoomId !== roomId) return;

    this.clearActiveEngineTarget(attachmentId);
    this.engine = null;
    this.activeEngineRoomId = null;
    this.activeEngineAttachmentId = null;
  }

  async addCharacterTokenToActiveVtt(
    character: ICharacter,
    roomId?: string | null,
    x?: number,
    y?: number
  ): Promise<boolean> {
    const token = this.createCharacterTokenPayload(character);
    const engine = this.getEngine();
    if (engine && this.canHandleVttWindowCommand(roomId ?? null)) {
      this.addCharacterTokenPayload(engine, token, x, y);
      return true;
    }

    return this.requestRemoteCharacterTokenAdd(token, roomId, x, y);
  }

  addCharacterToken(engine: VttEngine, character: ICharacter, x?: number, y?: number) {
    this.addCharacterTokenPayload(engine, this.createCharacterTokenPayload(character), x, y);
  }

  private addCharacterTokenPayload(engine: VttEngine, token: VttCharacterTokenPayload, x?: number, y?: number) {
    const posX = x ?? 100;
    const posY = y ?? 100;

    const tokenOptions = {
      id: crypto.randomUUID(),
      name: token.name,
      icon: token.icon,
      ownerId: token.ownerId,
      isPlayer: true
    };

    engine.addToken(posX, posY, tokenOptions, false);
  }

  private createCharacterTokenPayload(character: ICharacter): VttCharacterTokenPayload {
    return {
      name: typeof character?.name === 'string' && character.name.trim() ? character.name : 'Hero',
      icon: typeof character?.icon === 'string' && character.icon.trim() ? character.icon : null,
      ownerId: this.resolveCharacterOwnerId(character)
    };
  }

  private resolveCharacterOwnerId(character: ICharacter): string | null {
    const ownerId = (character as any)?.ownerId;
    if (typeof ownerId === 'string' && ownerId.trim()) {
      return ownerId;
    }

    if (ownerId && typeof ownerId === 'object') {
      const nestedId = (ownerId as any)._id ?? (ownerId as any).id;
      if (typeof nestedId === 'string' && nestedId.trim()) {
        return nestedId;
      }
    }

    return null;
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

  public canSetBroadcastBackground(): boolean {
    return !!this.engine && this.isConnected && this.isHosting;
  }

  async setBroadcastBackground(imageUrl: string): Promise<boolean> {
    const mapUrl = imageUrl?.trim();
    if (!mapUrl) return false;

    if (!this.canSetBroadcastBackground()) {
      console.warn('Only the active VTT host can set a broadcast image as the map background.');
      return false;
    }

    await this.setMap(mapUrl);
    return true;
  }

  async updateToken(tokenId: string, options: any, iconFile?: File): Promise<boolean> {
    if (!this.engine) return false;

    if (this.currentRoomId && !this.isHosting) {
      console.warn('Only the host can update token configuration.');
      return false;
    }

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
        return false;
      }
    }

    this.engine.updateTokenConfig(tokenId, options, false);
    this.mapLoading$.next({ loading: false, progress: 0, message: '' });
    return true;
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

  private requestRemoteCharacterTokenAdd(
    token: VttCharacterTokenPayload,
    roomId?: string | null,
    x?: number,
    y?: number
  ): Promise<boolean> {
    const requestId = this.createWindowInstanceId();
    const target = this.getWindowTarget(roomId ?? null);
    const command: VttWindowCommand = {
      type: 'add-character-token',
      requestId,
      sourceId: this.windowInstanceId,
      targetWindowLabel: target?.windowLabel ?? null,
      roomId: roomId ?? null,
      token,
      x,
      y
    };

    return new Promise(resolve => {
      const timeoutId = window.setTimeout(() => {
        this.pendingWindowCommands.delete(requestId);
        this.releaseCommandClaim(requestId);
        resolve(false);
      }, 1500);

      this.pendingWindowCommands.set(requestId, { resolve, timeoutId });
      this.broadcastWindowMessage(command, target?.windowLabel ?? null);
    });
  }

  private requestRemoteSessionEnd(roomId: string): Promise<boolean> {
    const requestId = this.createWindowInstanceId();
    const target = this.getWindowTarget(roomId, true);
    const command: VttWindowCommand = {
      type: 'end-session',
      requestId,
      sourceId: this.windowInstanceId,
      targetWindowLabel: target?.windowLabel ?? null,
      roomId
    };

    return new Promise(resolve => {
      const timeoutId = window.setTimeout(() => {
        this.pendingWindowCommands.delete(requestId);
        this.releaseCommandClaim(requestId);
        resolve(false);
      }, 1500);

      this.pendingWindowCommands.set(requestId, { resolve, timeoutId });
      this.broadcastWindowMessage(command, target?.windowLabel ?? null);
    });
  }

  private handleWindowMessage(message: VttWindowMessage | null | undefined) {
    if (!message || message.sourceId === this.windowInstanceId) return;

    if (message.type === 'add-character-token-result' || message.type === 'end-session-result') {
      this.resolvePendingWindowCommand(message.requestId, message.handled);
      return;
    }

    if (message.type === 'add-character-token') {
      if (message.targetWindowLabel && message.targetWindowLabel !== this.currentWindowLabel) {
        return;
      }

      this.handleAddCharacterTokenCommand(message);
      return;
    }

    if (message.type === 'end-session') {
      if (message.targetWindowLabel && message.targetWindowLabel !== this.currentWindowLabel) {
        return;
      }

      this.handleEndSessionCommand(message);
    }
  }

  private handleAddCharacterTokenCommand(command: VttWindowCommand) {
    if (!this.engine || !this.canHandleVttWindowCommand(command.roomId ?? null)) {
      return;
    }

    window.setTimeout(() => this.tryHandleAddCharacterTokenCommand(command), this.isHosting ? 0 : 50);
  }

  private tryHandleAddCharacterTokenCommand(command: VttWindowCommand) {
    if (command.type !== 'add-character-token' || !this.engine || !this.canHandleVttWindowCommand(command.roomId ?? null)) {
      return;
    }

    if (this.handledWindowCommandIds.has(command.requestId)) {
      return;
    }

    if (!this.claimCommand(command.requestId)) {
      return;
    }

    this.handledWindowCommandIds.add(command.requestId);
    window.setTimeout(() => this.handledWindowCommandIds.delete(command.requestId), 10000);

    try {
      this.addCharacterTokenPayload(this.engine, command.token, command.x, command.y);
      this.broadcastWindowMessage({
        type: 'add-character-token-result',
        requestId: command.requestId,
        sourceId: this.windowInstanceId,
        handled: true,
        roomId: this.currentRoomId
      });
    } catch (error) {
      console.error('Failed to handle VTT token add command', error);
      this.releaseCommandClaim(command.requestId);
      this.broadcastWindowMessage({
        type: 'add-character-token-result',
        requestId: command.requestId,
        sourceId: this.windowInstanceId,
        handled: false,
        roomId: this.currentRoomId,
        reason: 'handler-error'
      });
    }
  }

  private handleEndSessionCommand(command: VttWindowCommand) {
    if (command.type !== 'end-session' || !this.canHandleEndSessionCommand(command.roomId ?? null)) {
      return;
    }

    this.tryHandleEndSessionCommand(command);
  }

  private tryHandleEndSessionCommand(command: VttWindowCommand) {
    if (command.type !== 'end-session' || !this.canHandleEndSessionCommand(command.roomId ?? null)) {
      return;
    }

    if (this.handledWindowCommandIds.has(command.requestId)) {
      return;
    }

    if (!this.claimCommand(command.requestId)) {
      return;
    }

    this.handledWindowCommandIds.add(command.requestId);
    window.setTimeout(() => this.handledWindowCommandIds.delete(command.requestId), 10000);

    const roomId = this.currentRoomId;
    this.endSession();
    this.broadcastWindowMessage({
      type: 'end-session-result',
      requestId: command.requestId,
      sourceId: this.windowInstanceId,
      handled: true,
      roomId
    });
  }

  private canHandleVttWindowCommand(roomId: string | null): boolean {
    if (!this.engine || !this.isEngineMounted(this.engine)) {
      return false;
    }

    if (!roomId) {
      return true;
    }

    return this.activeEngineRoomId === roomId || this.currentRoomId === roomId;
  }

  private canHandleEndSessionCommand(roomId: string | null): boolean {
    if (!this.isHosting || !this.currentRoomId) {
      return false;
    }

    return !roomId || this.currentRoomId === roomId;
  }

  private isEngineMounted(engine: VttEngine): boolean {
    const container = this.getEngineContainer(engine);
    if (!container) return true;

    return container.isConnected !== false;
  }

  private getEngineContainer(engine: VttEngine): HTMLElement | null {
    if (typeof HTMLElement === 'undefined') return null;

    const stageContainer = (engine as any).stage?.container?.();
    if (stageContainer instanceof HTMLElement) {
      return stageContainer;
    }

    const engineContainer = (engine as any).containerId;
    return engineContainer instanceof HTMLElement ? engineContainer : null;
  }

  private resolvePendingWindowCommand(requestId: string, handled: boolean) {
    const pending = this.pendingWindowCommands.get(requestId);
    if (!pending) return;

    window.clearTimeout(pending.timeoutId);
    this.pendingWindowCommands.delete(requestId);
    this.releaseCommandClaim(requestId);
    pending.resolve(handled);
  }

  private broadcastWindowMessage(message: VttWindowMessage, targetWindowLabel?: string | null) {
    try {
      this.windowCommandChannel?.postMessage(message);
    } catch (error) {
      console.warn('Failed to post VTT window command', error);
    }

    if (!this.isTauriRuntime()) return;
    void this.emitTauriWindowMessage(message, targetWindowLabel)
      .catch(error => console.warn('Failed to broadcast VTT window command', error));
  }

  private async emitTauriWindowMessage(message: VttWindowMessage, targetWindowLabel?: string | null) {
    const { emit, emitTo } = await import('@tauri-apps/api/event');

    if (targetWindowLabel) {
      try {
        await emitTo(targetWindowLabel, VttSync.windowCommandEventName, message);
        return;
      } catch (error) {
        console.warn('Failed to emit VTT command to target window', targetWindowLabel, error);
        await emit(VttSync.windowCommandEventName, this.clearMessageTarget(message));
        return;
      }
    }

    await emit(VttSync.windowCommandEventName, message);
  }

  private clearMessageTarget(message: VttWindowMessage): VttWindowMessage {
    if (message.type !== 'add-character-token' && message.type !== 'end-session') {
      return message;
    }

    return {
      ...message,
      targetWindowLabel: null
    };
  }

  private createWindowCommandChannel(): BroadcastChannel | undefined {
    if (typeof BroadcastChannel === 'undefined') return undefined;

    const channel = new BroadcastChannel(VttSync.windowCommandChannelName);
    channel.onmessage = event => this.handleWindowMessage(event.data as VttWindowMessage);
    return channel;
  }

  private async setupTauriWindowCommands() {
    if (!this.isTauriRuntime()) return;

    try {
      const { listen } = await import('@tauri-apps/api/event');
      this.windowCommandUnlisten = await listen<VttWindowMessage>(
        VttSync.windowCommandEventName,
        event => this.handleWindowMessage(event.payload)
      );
    } catch (error) {
      console.warn('Tauri VTT window commands are unavailable', error);
    }
  }

  private claimCommand(requestId: string): boolean {
    try {
      const claimKey = `${VttSync.commandClaimStoragePrefix}${requestId}`;
      if (localStorage.getItem(claimKey)) {
        return false;
      }

      localStorage.setItem(claimKey, this.windowInstanceId);
      return localStorage.getItem(claimKey) === this.windowInstanceId;
    } catch {
      return true;
    }
  }

  private releaseCommandClaim(requestId: string) {
    try {
      localStorage.removeItem(`${VttSync.commandClaimStoragePrefix}${requestId}`);
    } catch {
      // Best effort cleanup only.
    }
  }

  private startEngineTargetHeartbeat() {
    if (this.engineTargetHeartbeatId !== null) return;

    this.engineTargetHeartbeatId = window.setInterval(() => {
      if (!this.activeEngineTarget || !this.engine || !this.isEngineMounted(this.engine)) {
        this.clearActiveEngineTarget();
        return;
      }

      this.publishActiveEngineTarget();
    }, VttSync.windowTargetHeartbeatMs);
  }

  private stopEngineTargetHeartbeat() {
    if (this.engineTargetHeartbeatId === null) return;

    window.clearInterval(this.engineTargetHeartbeatId);
    this.engineTargetHeartbeatId = null;
  }

  private publishActiveEngineTarget() {
    if (!this.activeEngineTarget) return;

    this.activeEngineTarget = {
      ...this.activeEngineTarget,
      windowLabel: this.currentWindowLabel,
      updatedAt: Date.now()
    };

    const nextTargets = this.readWindowTargets()
      .filter(target =>
        target.sourceId !== this.activeEngineTarget?.sourceId ||
        target.attachmentId !== this.activeEngineTarget?.attachmentId
      );

    nextTargets.push(this.activeEngineTarget);
    this.writeWindowTargets(nextTargets);
  }

  private updateActiveEngineTargetHosting(roomId: string, isHosting: boolean) {
    if (!this.activeEngineTarget || this.activeEngineTarget.roomId !== roomId) {
      return;
    }

    this.activeEngineTarget = {
      ...this.activeEngineTarget,
      isHosting
    };
    this.publishActiveEngineTarget();
  }

  private clearActiveEngineTarget(attachmentId?: string | null) {
    if (attachmentId && this.activeEngineTarget?.attachmentId !== attachmentId) return;

    const target = this.activeEngineTarget;
    this.activeEngineTarget = null;
    this.stopEngineTargetHeartbeat();

    if (!target) return;

    const nextTargets = this.readWindowTargets()
      .filter(existing =>
        existing.sourceId !== target.sourceId ||
        existing.attachmentId !== target.attachmentId
      );

    this.writeWindowTargets(nextTargets);
  }

  private getWindowTarget(roomId: string | null, hostingOnly = false): VttWindowTarget | null {
    const matchingTargets = this.readWindowTargets()
      .filter(target => target.sourceId !== this.windowInstanceId)
      .filter(target => !roomId || target.roomId === roomId)
      .filter(target => !hostingOnly || target.isHosting)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return matchingTargets[0] ?? null;
  }

  private readWindowTargets(): VttWindowTarget[] {
    try {
      const rawTargets = JSON.parse(
        localStorage.getItem(VttSync.windowTargetStorageKey) ?? '[]'
      ) as Array<Partial<VttWindowTarget>>;
      const now = Date.now();

      return rawTargets
        .filter(target =>
          typeof target.sourceId === 'string' &&
          typeof target.attachmentId === 'string' &&
          typeof target.roomId === 'string' &&
          typeof target.windowLabel === 'string' &&
          typeof target.updatedAt === 'number' &&
          now - target.updatedAt <= VttSync.windowTargetTtlMs
        )
        .map(target => ({
          sourceId: target.sourceId!,
          attachmentId: target.attachmentId!,
          roomId: target.roomId!,
          windowLabel: target.windowLabel!,
          isHosting: target.isHosting === true,
          updatedAt: target.updatedAt!
        }));
    } catch {
      return [];
    }
  }

  private writeWindowTargets(targets: VttWindowTarget[]) {
    try {
      localStorage.setItem(VttSync.windowTargetStorageKey, JSON.stringify(targets));
    } catch (error) {
      console.warn('Failed to persist VTT window targets', error);
    }
  }

  private async resolveCurrentWindowLabel() {
    if (!this.isTauriRuntime()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      this.currentWindowLabel = getCurrentWindow().label || this.currentWindowLabel;
      this.publishActiveEngineTarget();
    } catch (error) {
      console.warn('Failed to resolve current Tauri window label', error);
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
  }

  private getFallbackWindowLabel(): string {
    if (typeof window === 'undefined') {
      return 'main';
    }

    return new URLSearchParams(window.location.search).get('tabPanel') ?? 'main';
  }

  private createWindowInstanceId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import {TokenService} from '../auth/token';
import {ICharacter} from '../../models/user/character.model';
import {VttEngine} from '../../modules/vttEngine/VttEngine';
import {Video} from '../video/video';
import {environment} from '../../../../environments/environment';
import { BehaviorSubject } from 'rxjs';

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

@Injectable({ providedIn: 'root' })
export class VttSync {
  private socket: Socket | null = null;
  public currentRoomId: string | null = null;
  public isHosting = false;
  public isConnected = false;
  private engine: VttEngine| null = null;

  public hostDisconnected$ = new BehaviorSubject<boolean>(false);
  public turnOrder$ = new BehaviorSubject<TurnOrderState>({
    isActive: false,
    isConfirmed: false,
    entries: [],
    activeIndex: 0
  });

  constructor(private tokenService: TokenService, private callService: Video) {
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

      this.socket.on('connect_error', (err) => {
        console.error('Socket Connection Error:', err.message);
      });

      this.socket.on('host-disconnected', () => {
        console.warn('The DM has disconnected. You can assume hosting.');
        this.hostDisconnected$.next(true);
      });

      this.socket.on('host-changed', (payload: any) => {
        if (payload.hostId !== this.socket?.id) {
            this.hostDisconnected$.next(false);
            if (this.isHosting) {
                this.isHosting = false;
                if (this.engine) this.engine.setPermissions(false);
            }
        }
      });
    }
    return this.socket;
  }
  startHosting(engine: VttEngine, roomId: string) {
    const isReattaching = this.currentRoomId === roomId && this.isHosting && this.isConnected;

    this.currentRoomId = roomId;
    this.isHosting = true;
    this.isConnected = true;
    this.engine = engine;

    const socket = this.getSocket();

    // If we're reattaching, we don't want to overwrite the server's state with a (possibly blank) engine config.
    // Instead, we just re-join as host.
    socket.emit('host-session', {
      roomId,
      initialState: isReattaching ? null : engine.getRawConfig()
    });

    socket.off('remote-action');
    socket.on('remote-action', (payload: any) => {
      this.handleRemoteAction(engine, payload);
    });

    socket.off('map-update');
    socket.on('map-update', (config: any) => {
      // If we reattached but somehow the engine is blanker than the server,
      // or if we're a new host taking over, load the state.
      if (isReattaching && engine.currentMapUrl) return;
      engine.loadConfigFromObject(config);
    });

    this.attachEngineListeners(engine);
    this.callService.sendVttCommand("start", roomId);
    this.hostDisconnected$.next(false);
  }

  joinSession(engine: VttEngine, roomId: string, character: ICharacter) {
    const isReattaching = this.currentRoomId === roomId && !this.isHosting && this.isConnected;

    this.currentRoomId = roomId;
    this.isHosting = false;
    this.isConnected = true;
    this.engine = engine;

    engine.setLocalCharacter(character);

    const socket = this.getSocket();
    socket.emit('join-session', { roomId, character });

    socket.off('map-update');
    socket.off('remote-action');
    socket.off('error');
    socket.off('session-ended');

    socket.on('map-update', (config: any) => {
      // Only load if we don't already have a map loaded or if we're not reattaching
      if (!isReattaching || !engine.currentMapUrl) {
          engine.loadConfigFromObject(config);
      }
    });

    socket.on('remote-action', (payload: any) => {
      this.handleRemoteAction(engine, payload);
    });

    socket.on('error', (msg: string) => {
      console.warn('VTT Sync Error:', msg);
    });

    socket.on('session-ended', () => {
      alert('The DM has ended the session.');
      this.stopSyncing(true);
    });

    this.attachEngineListeners(engine);
  }

  stopSyncing(force: boolean = false) {
    if (!force) return;

    if (this.socket && this.currentRoomId) {
      if (this.isHosting) {
        this.socket.emit('stop-hosting', this.currentRoomId);
      }
      this.socket.disconnect();
      this.socket = null;
    }
    this.currentRoomId = null;
    this.isHosting = false;
    this.isConnected = false;
    this.hostDisconnected$.next(false);
    this.engine = null;
    this.turnOrder$.next({ isActive: false, isConfirmed: false, entries: [], activeIndex: 0 });
  }

  broadcastAction(action: string, data: any) {
    if (!this.isConnected || !this.currentRoomId) return;
    this.getSocket().emit('sync-action', {
      roomId: this.currentRoomId,
      action,
      data
    });
  }

  private attachEngineListeners(engine: VttEngine) {
    engine.stage.off('tokenMoved');
    engine.stage.on('tokenMoved', (e: any) => {
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

    if (this.isHosting) {
      engine.stage.off('wallAdded');
      engine.stage.on('wallAdded', (data: any) => {
        this.broadcastAction('wall-added', data);
      });

      engine.stage.off('wallDeleted');
      engine.stage.on('wallDeleted', (data: any) => {
        this.broadcastAction('wall-deleted', data);
      });

      engine.stage.off('tokenAdded');
      engine.stage.on('tokenAdded', (data: any) => {
        if (!data.remote) this.broadcastAction('token-added', data);
      });

      engine.stage.off('tokenDeleted');
      engine.stage.on('tokenDeleted', (data: any) => {
        if (!data.remote) this.broadcastAction('token-deleted', data);
      });

      engine.stage.off('mapChanged');
      engine.stage.on('mapChanged', (data: any) => {
        this.broadcastAction('map-change', data);
      })

      engine.stage.off('lightingToggled');
      engine.stage.on('lightingToggled', (data: any) => {
        this.broadcastAction('lighting-toggle', data);
      });

      engine.stage.off('gridSizeChanged');
      engine.stage.on('gridSizeChanged', (data: any) => {
        this.broadcastAction('grid-size-change', data);
      });
    }
  }


  private handleRemoteAction(engine: VttEngine, { action, data }: any) {
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
        const token = engine.tokenLayer.getChildren().find(g => g.id() === data.id);
        if (token) token.destroy();
        break;

      case 'lighting-toggle':
        engine.lightLayer.visible(data.visible);
        break;

      case 'grid-size-change':
        engine.updateGridSize(data.size, true);
        break;

      case 'map-change':
        engine.setBackground(data.url, true);
        break;

      case 'map-load':
        engine.loadConfigFromObject(data);
        break;

      case 'measure-sync':
        if (engine.measurementManager) {
          engine.measurementManager.handleRemoteAction(data);
        }
        break;

      case 'ping':
        engine.showPing(data.x, data.y, data.color);
        break;

      case 'turn-order-sync':
        this.turnOrder$.next(data);
        break;
    }
    engine.stage.batchDraw();
  }

  addCharacterToken(engine: VttEngine, character: ICharacter, x?: number, y?: number) {
    if (!this.isConnected || !this.currentRoomId) {
      console.error('Cannot add token: Not connected to a session.');
      return;
    }

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

    this.broadcastAction('token-added', {
      x: posX,
      y: posY,
      options: tokenOptions
    });
  }

  updateTurnOrder(state: TurnOrderState) {
    this.turnOrder$.next(state);
    this.broadcastAction('turn-order-sync', state);
  }


  getEngine() {
    return this.engine;
  }
}

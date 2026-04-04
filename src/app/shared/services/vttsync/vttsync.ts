import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import {TokenService} from '../auth/token';
import {ICharacter} from '../../models/user/character.model';
import {VttEngine} from '../../modules/vttEngine/VttEngine';
import {Video} from '../video/video';
import {environment} from '../../../../environments/environment';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class VttSync {
  private socket: Socket | null = null;
  public currentRoomId: string | null = null;
  public isHosting = false;
  public isConnected = false;
  private engine: VttEngine| null = null;

  public hostDisconnected$ = new BehaviorSubject<boolean>(false);

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
                // Someone else took over hosting
                this.isHosting = false;
                if (this.engine) this.engine.setPermissions(false);
            }
        }
      });
    }
    return this.socket;
  }
  startHosting(engine: VttEngine, roomId: string) {
    this.currentRoomId = roomId;
    this.isHosting = true;
    this.isConnected = true;
    this.engine = engine;

    const socket = this.getSocket();
    socket.emit('host-session', {
      roomId,
      initialState: engine.getRawConfig()
    });

    socket.off('remote-action');
    socket.on('remote-action', (payload: any) => {
      this.handleRemoteAction(engine, payload);
    });

    this.attachEngineListeners(engine);
    this.callService.sendVttCommand("start", roomId);
    this.hostDisconnected$.next(false);
  }

  joinSession(engine: VttEngine, roomId: string, character: ICharacter) {
    this.currentRoomId = roomId;

    this.isHosting = false;
    this.isConnected = true;

    this.engine = engine;


    engine.setLocalCharacter(character);
    console.log(character)

    const socket = this.getSocket();
    socket.emit('join-session', { roomId, character });

    socket.off('map-update');
    socket.off('remote-action');
    socket.off('error');
    socket.off('session-ended');

    socket.on('map-update', (config: any) => {
      engine.loadConfigFromObject(config);
    });

    socket.on('remote-action', (payload: any) => {
      this.handleRemoteAction(engine, payload);
    });

    socket.on('error', (msg: string) => {
      console.warn('VTT Sync Error:', msg);
      // We don't alert here to avoid annoying popups if it's just a "room doesn't exist yet"
      // while we're waiting for a host.
    });

    socket.on('session-ended', () => {
      alert('The DM has ended the session.');
      this.stopSyncing();
    });

    this.attachEngineListeners(engine);
  }

  stopSyncing() {
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


  getEngine() {
    return this.engine;
  }
}

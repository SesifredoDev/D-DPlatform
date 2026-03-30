import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { VttEngine } from '../../../shared/modules/vttEngine/vttEngine.js';
import {TokenService} from '../auth/token';
import {ICharacter} from '../../models/user/character.model';

@Injectable({ providedIn: 'root' })
export class VttSync {
  private socket: Socket | null = null;
  public currentRoomId: string | null = null;
  public isHosting = false;
  public isConnected = false;
  private engine: VttEngine| null = null;
  constructor(private tokenService: TokenService) {
  }
  private getSocket(): Socket {
    if (!this.socket) {
      this.socket = io('http://localhost', {
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
      alert(msg);
      this.stopSyncing();
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
        // Call a new method to add just one wall without clearing
        engine.wallManager.addSingleWall(data.points);
        break;

      case 'wall-deleted':
        // Find and destroy the specific wall segment
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
        // Use the remote flag 'true' to avoid infinite broadcast loops
        engine.updateGridSize(data.size, true);
        break;

      case 'map-change':
        engine.setBackground(data.url, true);
        break;

      // ADD THIS NEW CASE:
      case 'map-load':
        // The DM loaded a completely new map. This data contains
        // the full config (tokens, walls, grid, background).
        engine.loadConfigFromObject(data);
        break;

      case 'measure-sync':
        // Direct the packet to the MeasurementManager
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

  // Add this to vttsync.ts

  /**
   * Adds a character token to the map from an external component.
   * @param engine The current active VttEngine instance
   * @param character The ICharacter data to use for the token
   * @param x Optional X coordinate (defaults to center of view)
   * @param y Optional Y coordinate (defaults to center of view)
   */
  addCharacterToken(engine: VttEngine, character: ICharacter, x?: number, y?: number) {
    if (!this.isConnected || !this.currentRoomId) {
      console.error('Cannot add token: Not connected to a session.');
      return;
    }

    // 1. Determine position (default to 100,100 if not provided)
    const posX = x ?? 100;
    const posY = y ?? 100;

    // 2. Prepare the token options based on the ICharacter model
    const tokenOptions = {
      id: crypto.randomUUID(),     // Unique ID for sync
      name: character.name,        // From ICharacter
      icon: character.icon,        // Image URL from ICharacter
      ownerId: character.ownerId,  // For permission checks
      isPlayer: true               // Flags it as a player token
    };

    // 3. Add to local engine immediately
    // Note: 'remote: false' ensures we don't trigger an infinite loop
    // if the engine emits 'tokenAdded' back to the service.
    engine.addToken(posX, posY, tokenOptions, false);

    // 4. Broadcast to the server so other players see it
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

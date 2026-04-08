import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, Input, OnChanges, SimpleChanges, Output, EventEmitter, OnInit } from '@angular/core';
import { DatePipe, NgForOf, NgIf, NgStyle, AsyncPipe, NgClass } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { SaveMapDialog } from '../../../objects/save-map/save-map';
import {VttSync, TurnOrderState, TurnOrderEntry, MapLibraryEntry} from '../../../shared/services/vttsync/vttsync';
import {ICharacter} from '../../../shared/models/user/character.model';
import {MatIconButton, MatButton} from '@angular/material/button';
import {MatIcon} from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import {VttEngine} from '../../../shared/modules/vttEngine/VttEngine';
import {Subscription, Observable} from 'rxjs';

@Component({
  selector: 'app-vtt-canvas',
  standalone: true,
  imports: [
    DatePipe,
    NgForOf, NgIf, NgStyle, NgClass, AsyncPipe,
    MatIconButton, MatButton, MatIcon, MatMenuModule,
    FormsModule, MatFormFieldModule, MatInputModule,
    MatCheckboxModule, MatSelectModule, MatTooltipModule
  ],
  templateUrl: './vtt-canvas.html',
  styleUrl: './vtt-canvas.scss',
})
export class VttCanvas implements AfterViewInit, OnDestroy, OnChanges, OnInit {
  @Input() serverId!: string;
  @Input() userId!: string;
  @Input() character!: ICharacter;
  @Input() isHostVttSession: boolean = false;
  @Input() isJoiningVttSession: boolean = false;

  @Output() vttSessionHosted = new EventEmitter<string>();
  @Output() vttSessionStopped = new EventEmitter<string>();

  @ViewChild('vttContainer', { static: true }) container!: ElementRef;
  @ViewChild(MatMenuTrigger) menuTrigger!: MatMenuTrigger;


  private resizeObserver!: ResizeObserver;
  public engine!: VttEngine;
  public lightingEnabled = false;
  public activeTool: 'select' | 'draw' | 'delete' | 'line' | 'radius' | 'none' = 'select';

  public mapLibrary: MapLibraryEntry[] = [];
  public currentMapName: string = '';
  public currentMapId: string | null = null;
  public showLibraryOverlay = false;

  // Context Menu State
  public menuTopLeftPosition = { x: '0px', y: '0px' };
  public selectedToken: any = null;
  public tokenEditConfig: any = {
    name: '',
    icon: '',
    iconFile: null,
    size: 1,
    forceBorder: false,
    borderColor: '#ffffff',
    color: '#ff0000'
  };

  public colorPresets = [
    '#ff4444', '#ffbb33', '#00C851', '#33b5e5', '#2BBBAD', '#4285F4', '#aa66cc',
    '#2E2E2E', '#ffffff', '#ffeb3b', '#e91e63', '#9c27b0'
  ];

  public showHostTakeover = false;
  private hostDisconnectedSub!: Subscription;
  private turnOrderStateSub!: Subscription; // Subscription for turn order state

  // Turn Order State
  public turnOrderState$: Observable<TurnOrderState>;
  public newEntryName: string = '';
  public newEntryInitiative: number = 0;
  public turnOrderMinimized = false;
  private lastAddedEntryId: string | null = null; // To track the last added entry for clearing inputs

  // Expose sync state to UI
  get isSyncing() { return this.syncService.isConnected; }
  get isHosting() { return this.syncService.isHosting; }

  constructor(private dialog: MatDialog, public syncService: VttSync  ) {
    this.turnOrderState$ = this.syncService.turnOrder$.asObservable();
  }

  ngOnInit() {
    if (this.character) {
        this.newEntryName = this.character.name;
    }
  }

  ngAfterViewInit() {
    if (this.syncService.currentRoomId === this.serverId && this.syncService.getEngine()) {
      this.engine = this.syncService.getEngine()!;
      this.engine.setContainer(this.container.nativeElement);
      this.engine.stage.batchDraw();
    } else {
      this.engine = new VttEngine(this.container.nativeElement, this.userId, 50);
    }

    this.engine.stage.on('tokenContextMenu', (data: any) => {
      this.onTokenContextMenu(data);
    });

    this.loadLibrary();

    this.resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => this.handleResize());
    });
    this.resizeObserver.observe(this.container.nativeElement);

    this.hostDisconnectedSub = this.syncService.hostDisconnected$.subscribe(disconnected => {
        this.showHostTakeover = disconnected && !this.isHosting;
    });

    this.turnOrderStateSub = this.turnOrderState$.subscribe(state => {
      // Clear inputs only after the entry is confirmed in the state
      if (this.lastAddedEntryId && state.entries.some(entry => entry.id === this.lastAddedEntryId)) {
        this.newEntryInitiative = 0;
        this.lastAddedEntryId = null;
      }
    });

    this.handleSyncState();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isHostVttSession'] || changes['isJoiningVttSession']) && this.engine) {
      this.handleSyncState();
    }
    if (changes['character'] && this.character) {
        this.newEntryName = this.character.name;
    }
  }

  private handleSyncState() {
    if (this.isHostVttSession && !this.syncService.isHosting) {
      this.syncService.startHosting(this.engine, this.serverId);
      this.engine.setPermissions(true);
      this.engine.isDM = true;
    } else if (this.isJoiningVttSession && !this.syncService.isConnected) {
      this.joinSession();
      this.engine.setPermissions(false);
      this.engine.isDM = false;
    } else if (!this.isHostVttSession && !this.isJoiningVttSession && this.syncService.isConnected) {
      if (this.syncService.currentRoomId !== this.serverId) {
        this.syncService.stopSyncing(true);
      }
    }
  }

  joinSession() {
    this.syncService.joinSession(this.engine, this.serverId, this.character);
    this.engine.setPermissions(false);
    this.engine.isDM = false;
  }

  startHostingSession() {
      this.syncService.startHosting(this.engine, this.serverId);
      this.engine.setPermissions(true);
      this.engine.isDM = true;
      this.showHostTakeover = false;
  }

  stopSession() {
      this.vttSessionStopped.emit(this.serverId);
      this.syncService.stopSyncing(true);
  }

  ngOnDestroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.hostDisconnectedSub) this.hostDisconnectedSub.unsubscribe();
    if (this.turnOrderStateSub) this.turnOrderStateSub.unsubscribe(); // Unsubscribe
    if (this.syncService.currentRoomId !== this.serverId) {
      this.syncService.stopSyncing(true);
    }
  }

  private handleResize() {
    if (this.engine && this.container) {
      const rect = this.container.nativeElement.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      if (this.engine.stage.width() !== width || this.engine.stage.height() !== height) {
        this.engine.stage.width(width);
        this.engine.stage.height(height);
        this.engine.centerMap();
        this.engine.stage.batchDraw();
      }
    }
  }

  onTokenContextMenu({ token, evt }: any) {
    if (!token.checkPermissions()) return;

    this.selectedToken = token;
    this.tokenEditConfig = {
      name: token.name,
      icon: token.imageUrl,
      iconFile: null,
      size: token.size,
      forceBorder: token.forceBorder,
      borderColor: token.borderColor,
      color: token.color
    };

    this.menuTopLeftPosition.x = evt.clientX + 'px';
    this.menuTopLeftPosition.y = evt.clientY + 'px';
    this.menuTrigger.openMenu();
  }

  onTokenIconUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    this.tokenEditConfig.iconFile = file;

    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.tokenEditConfig.icon = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  async applyTokenConfig() {
    if (this.selectedToken) {
      const tokenId = this.selectedToken.id;
      const { iconFile, ...cleanConfig } = this.tokenEditConfig;
      await this.syncService.updateToken(tokenId, cleanConfig, iconFile);
      this.tokenEditConfig.iconFile = null;
    }
  }

  deleteSelectedToken() {
    if (this.selectedToken) {
      const id = this.selectedToken.id;
      this.engine.removeToken(id);
      if (this.isSyncing) {
        this.syncService.broadcastAction('token-deleted', { id });
      }
    }
  }

  addToken() {
    const id = crypto.randomUUID();
    const options = { id, name: "New Monster" };
    this.engine.addToken(100, 100, options);
    if (this.isSyncing) {
      this.syncService.broadcastAction('token-added', { x: 100, y: 100, options });
    }
  }

  addPlayer(){
    const id = crypto.randomUUID();
    const options = { id, name: "New Hero", isPlayer: true };
    this.engine.addToken(100, 100, options);
    if (this.isSyncing) {
      this.syncService.broadcastAction('token-added', { x: 100, y: 100, options });
    }
  }

  setMeasureTool(tool: 'line' | 'radius' | 'none') {
    this.activeTool = tool;
    this.engine.wallManager.setMode('none');
    this.engine.setMeasurementMode(tool);
  }

  setTool(mode: 'select' | 'draw' | 'delete') {
    this.activeTool = mode;
    this.engine.setMeasurementMode('none');
    if (mode === 'select') {
      this.engine.wallManager.setMode('none');
    } else {
      this.engine.wallManager.setMode(mode);
    }
  }

  toggleLighting() {
    this.lightingEnabled = !this.lightingEnabled;
    this.engine.lightLayer.visible(this.lightingEnabled);
    if (this.lightingEnabled) this.engine.updateLighting();
    this.engine.stage.batchDraw();
    if (this.isSyncing) {
      this.syncService.broadcastAction('lighting-toggle', { visible: this.lightingEnabled });
    }
  }

  async onMapUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await this.syncService.setMap(file);
    } catch (err) {
      console.error("Failed to upload map", err);
      alert("Failed to upload map image.");
    }
  }

  async saveCurrentMap(saveAs: boolean = false) {
    let name = this.currentMapName;
    let mapId = this.currentMapId;

    if (!mapId || saveAs) {
      const dialogRef = this.dialog.open(SaveMapDialog, {
        width: '400px',
        data: { name: name || 'New Map' },
        panelClass: 'custom-dialog-container'
      });

      const result = await dialogRef.afterClosed().toPromise();
      if (!result) return;
      name = result;
      mapId = crypto.randomUUID();
    }

    this.currentMapName = name;
    this.currentMapId = mapId;
    const mapData = this.engine.getRawConfig();

    const mapEntry: MapLibraryEntry = {
      id: this.currentMapId,
      name: this.currentMapName,
      lastSaved: new Date().toISOString(),
      server: this.serverId,
      data: mapData
    };

    const index = this.mapLibrary.findIndex(m => m.id === this.currentMapId);
    if (index > -1) {
      this.mapLibrary[index] = mapEntry;
    } else {
      this.mapLibrary.push(mapEntry);
    }

    await this.saveLibraryToDisk();
  }

  exportMapJson() {
    this.engine.exportConfig();
  }

  onMapJsonUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const config = JSON.parse(e.target.result);
        this.engine.loadConfigFromObject(config);
        if (this.isSyncing) {
          this.syncService.broadcastAction('map-load', config);
        }
      } catch (err) {
        console.error("Failed to parse map JSON", err);
        alert("Invalid map file format.");
      }
    };
    reader.readAsText(file);
  }

  loadFromLibrary(map: any) {
    this.currentMapId = map.id;
    this.currentMapName = map.name;
    this.engine.loadConfigFromObject(map.data);
    this.showLibraryOverlay = false;

    if (this.isSyncing) {
      this.syncService.broadcastAction('map-load', map.data);
    }
  }

  async toggleArchive(map: any, event: Event) {
    event.stopPropagation();
    map.isArchived = !map.isArchived;
    await this.saveLibraryToDisk();
  }

  async deleteMap(map: any, event: Event) {
    event.stopPropagation();
    if (confirm(`Are you sure you want to permanently delete "${map.name}"?`)) {
      this.mapLibrary = this.mapLibrary.filter(m => m.id !== map.id);
      await this.saveLibraryToDisk();
    }
  }

  private async saveLibraryToDisk() {
    const storageKey = `vtt_library_${this.serverId}`;
    localStorage.setItem(storageKey, JSON.stringify(this.mapLibrary));
    try {
      await this.syncService.saveMapLibrary(this.mapLibrary);
    } catch (e) {
      console.warn("Could not sync library to server, saved locally only.");
    }
  }

  async loadLibrary() {
    const storageKey = `vtt_library_${this.serverId}`;
    const localData = localStorage.getItem(storageKey);
    if (localData) {
      this.mapLibrary = JSON.parse(localData);
    } else {
      try {
        const library = await this.syncService.loadMapLibrary();
        this.mapLibrary = library.filter((e: MapLibraryEntry) => e.server == this.serverId);
      } catch (e) {
        this.mapLibrary = [];
      }
    }
  }

  createNewMap() {
    this.currentMapId = null;
    this.currentMapName = '';
    this.engine.clearAll();
    this.showLibraryOverlay = false;
    if (this.isSyncing) {
      this.syncService.broadcastAction('map-load', this.engine.getRawConfig());
    }
  }

  selectColor(color: string) {
    if (this.tokenEditConfig.forceBorder) {
      this.tokenEditConfig.borderColor = color;
    } else {
      this.tokenEditConfig.color = color;
    }
  }

  // Turn Order Actions (Calling centralized service methods)
  activateTurnOrder() {
    this.syncService.activateTurnOrder();
  }

  confirmTurnOrder() {
    this.syncService.confirmTurnOrder();
  }

  endTurnOrder() {
    this.syncService.endTurnOrder();
  }

  nextTurn() {
    this.syncService.nextTurn();
  }

  prevTurn() {
    this.syncService.prevTurn();
  }

  addTurnOrderEntry() {
    if (!this.newEntryName || this.newEntryInitiative === null) return;

    const newEntry: TurnOrderEntry = {
      id: crypto.randomUUID(),
      name: this.newEntryName,
      initiative: this.newEntryInitiative,
      userId: this.userId
    };

    this.lastAddedEntryId = newEntry.id; // Store the ID of the entry we're trying to add
    this.syncService.addTurnOrderEntry(newEntry);
    // Do NOT clear inputs here. They will be cleared by the turnOrderStateSub subscription.
  }

  removeTurnOrderEntry(entryId: string) {
    this.syncService.removeTurnOrderEntry(entryId);
  }

  toggleTurnOrderMinimize() {
    this.turnOrderMinimized = !this.turnOrderMinimized;
  }
}

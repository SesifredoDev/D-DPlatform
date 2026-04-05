import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, Input, OnChanges, SimpleChanges, Output, EventEmitter, OnInit } from '@angular/core';
import { DatePipe, NgForOf, NgIf, NgStyle, AsyncPipe } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { SaveMapDialog } from '../../../objects/save-map/save-map';
import {VttSync, TurnOrderState, TurnOrderEntry} from '../../../shared/services/vttsync/vttsync';
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
    NgForOf,
    NgIf,
    NgStyle,
    AsyncPipe,
    MatIconButton,
    MatButton,
    MatIcon,
    MatMenuModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatSelectModule,
    MatTooltipModule
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

  public mapLibrary: any[] = [];
  public currentMapName: string = '';
  public currentMapId: string | null = null;
  public showLibraryOverlay = true;

  // Context Menu State
  public menuTopLeftPosition = { x: '0px', y: '0px' };
  public selectedToken: any = null;
  public tokenEditConfig: any = {
    name: '',
    icon: '',
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

  // Turn Order State
  public turnOrderState$: Observable<TurnOrderState>;
  public newEntryName: string = '';
  public newEntryInitiative: number = 0;

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
    // Check if VttSync service already has an engine for this room
    if (this.syncService.currentRoomId === this.serverId && this.syncService.getEngine()) {
      this.engine = this.syncService.getEngine()!;
      // Re-attach the engine to the new container element
      this.engine.setContainer(this.container.nativeElement);
      this.engine.stage.batchDraw(); // Redraw to reflect new container
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
      // If the component is no longer marked as hosting or joining, but the service is still connected
      // to this room, it means the tab is being moved/closed without explicit stop.
      // We only stop syncing if the serverId doesn't match the currentRoomId in the service,
      // or if the component is explicitly telling it to stop.
      if (this.syncService.currentRoomId === this.serverId) {
        // Do nothing, let the service maintain the connection
      } else {
        this.syncService.stopSyncing(true); // Force stop if it's a different room or no longer active
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
      this.syncService.stopSyncing(true); // Explicitly stop when button is pressed
  }

  ngOnDestroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.hostDisconnectedSub) {
      this.hostDisconnectedSub.unsubscribe();
    }

    // Only stop syncing if the service is no longer managing this specific room,
    // or if the component is being completely destroyed (e.g., tab closed).
    // If the service is still connected to this room, it means the tab is being moved.
    if (this.syncService.currentRoomId === this.serverId) {
      // Do nothing, the service maintains the connection
    } else {
      this.syncService.stopSyncing(true); // Force stop if it's a different room or no longer active
    }
  }

  private handleResize() {
    if (this.engine && this.container) {
      const rect = this.container.nativeElement.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      // Only resize if values actually changed to prevent loop
      if (this.engine.stage.width() !== width || this.engine.stage.height() !== height) {
        this.engine.stage.width(width);
        this.engine.stage.height(height);
        this.engine.centerMap();
        this.engine.stage.batchDraw();
      }
    }
  }

  // --- Token Context Menu ---
  onTokenContextMenu({ token, evt }: any) {
    if (!token.checkPermissions()) return;

    this.selectedToken = token;
    this.tokenEditConfig = {
      name: token.name,
      icon: token.imageUrl,
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
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.tokenEditConfig.icon = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  selectColor(color: string) {
    if (this.tokenEditConfig.forceBorder) {
      this.tokenEditConfig.borderColor = color;
    } else {
      this.tokenEditConfig.color = color;
    }
  }

  applyTokenConfig() {
    if (this.selectedToken) {
      this.selectedToken.updateConfig(this.tokenEditConfig);
      if (this.isSyncing) {
        this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
      }
    }
  }

  deleteSelectedToken() {
    if (this.selectedToken) {
      this.engine.removeToken(this.selectedToken.id);
      if (this.isSyncing) {
        this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
      }
    }
  }

  // --- Engine Interactions ---
  addToken() {
    this.engine.addToken(100, 100, { name: "New Monster" });
    if (this.isSyncing) this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
  }

  addPlayer(){
    this.engine.addToken(100, 100, { name: "New Hero", isPlayer: true });
    if (this.isSyncing) this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
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
    if (this.lightingEnabled) {
      this.engine.updateLighting();
    }
    this.engine.stage.batchDraw();
    this.engine.stage.fire('lightingToggled', { visible:this.lightingEnabled });
  }

  // --- File/Library Management ---
  onMapUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.engine.setBackground(e.target.result);
      if (this.isSyncing) this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
    };
    reader.readAsDataURL(file);
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

    const mapEntry = {
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

    await (window as any).electronAPI.saveMapLibrary(this.mapLibrary);
  }

  loadFromLibrary(map: any) {
    this.currentMapId = map.id;
    this.currentMapName = map.name;
    this.engine.loadConfigFromObject(map.data);
    this.showLibraryOverlay = false;

    if (this.isSyncing) {
      this.syncService.broadcastAction('map-load', this.engine.getRawConfig());
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
    await (window as any).electronAPI.saveMapLibrary(this.mapLibrary);
  }

  async loadLibrary() {
    const library = await (window as any).electronAPI.loadMapLibrary();
    this.mapLibrary = library.filter((e: any) => e.server == this.serverId);
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

  // --- Turn Order ---
  activateTurnOrder() {
    this.syncService.updateTurnOrder({
      isActive: true,
      isConfirmed: false,
      entries: []
    });
  }

  confirmTurnOrder() {
    const currentState = this.syncService.turnOrder$.value;
    const sortedEntries = [...currentState.entries].sort((a, b) => b.initiative - a.initiative);
    this.syncService.updateTurnOrder({
      ...currentState,
      isConfirmed: true,
      entries: sortedEntries
    });
  }

  endTurnOrder() {
    this.syncService.updateTurnOrder({
      isActive: false,
      isConfirmed: false,
      entries: []
    });
  }

  addTurnOrderEntry() {
    if (!this.newEntryName || this.newEntryInitiative === null) return;

    const currentState = this.syncService.turnOrder$.value;
    const newEntry: TurnOrderEntry = {
      id: crypto.randomUUID(),
      name: this.newEntryName,
      initiative: this.newEntryInitiative,
      userId: this.userId
    };

    const newEntries = [...currentState.entries, newEntry];
    if (currentState.isConfirmed) {
        newEntries.sort((a, b) => b.initiative - a.initiative);
    }

    this.syncService.updateTurnOrder({
      ...currentState,
      entries: newEntries
    });

    // Reset fields (optionally keep name for player)
    this.newEntryInitiative = 0;
  }

  removeTurnOrderEntry(entryId: string) {
    const currentState = this.syncService.turnOrder$.value;
    this.syncService.updateTurnOrder({
      ...currentState,
      entries: currentState.entries.filter(e => e.id !== entryId)
    });
  }
}

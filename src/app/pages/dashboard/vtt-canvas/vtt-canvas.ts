import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, Input, OnChanges, SimpleChanges, Output, EventEmitter } from '@angular/core';
import { DatePipe, NgForOf, NgIf, NgStyle } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { SaveMapDialog } from '../../../objects/save-map/save-map';
import {VttSync} from '../../../shared/services/vttsync/vttsync';
import {ICharacter} from '../../../shared/models/user/character.model';
import {MatIconButton} from '@angular/material/button';
import {MatIcon} from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import {VttEngine} from '../../../shared/modules/vttEngine/VttEngine';

@Component({
  selector: 'app-vtt-canvas',
  imports: [
    DatePipe,
    NgForOf,
    NgIf,
    NgStyle,
    MatIconButton,
    MatIcon,
    MatMenuModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatSelectModule
  ],
  templateUrl: './vtt-canvas.html',
  styleUrl: './vtt-canvas.scss',
})
export class VttCanvas implements AfterViewInit, OnDestroy, OnChanges {
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

  // Expose sync state to UI
  get isSyncing() { return this.syncService.isConnected; }
  get isHosting() { return this.syncService.isHosting; }

  constructor(private dialog: MatDialog, public syncService: VttSync) { }

  ngAfterViewInit() {
    this.engine = new VttEngine(this.container.nativeElement, this.userId, 50);
    console.log("Character loaded!"+ this.character);

    this.engine.stage.on('tokenContextMenu', (data: any) => {
      this.onTokenContextMenu(data);
    });

    this.loadLibrary();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.container.nativeElement);

    this.handleSyncState();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isHostVttSession'] || changes['isJoiningVttSession']) && this.engine) {
      this.handleSyncState();
    }
  }

  private handleSyncState() {
    if (this.isHostVttSession && !this.syncService.isHosting) {
      this.syncService.startHosting(this.engine, this.serverId);
      this.engine.setPermissions(true);
    } else if (this.isJoiningVttSession && !this.syncService.isConnected) {
      this.syncService.joinSession(this.engine, this.serverId, this.character);
      this.engine.setPermissions(false);
    } else if (!this.isHostVttSession && !this.isJoiningVttSession && this.syncService.isConnected) {
      this.syncService.stopSyncing();
    }
  }

  startHostingSession() {
      this.vttSessionHosted.emit(this.serverId);
  }

  stopSession() {
      this.vttSessionStopped.emit(this.serverId);
  }

  ngOnDestroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.syncService.stopSyncing();
  }

  private handleResize() {
    if (this.engine && this.container) {
      const width = this.container.nativeElement.getBoundingClientRect().width;
      const height = this.container.nativeElement.getBoundingClientRect().height;
      this.engine.stage.width(width);
      this.engine.stage.height(height);
      this.engine.centerMap();
    }
  }

  // --- Token Context Menu ---
  onTokenContextMenu({ token, evt }: any) {
    // Only DM or Owner can edit
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
    // Turn off wall modes if we start measuring
    this.engine.wallManager.setMode('none');
    this.engine.setMeasurementMode(tool);
  }

  setTool(mode: 'select' | 'draw' | 'delete') {
    this.activeTool = mode;
    // Turn off measurement mode if we switch to a standard tool
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

    // Broadcast the full new map state if we are currently syncing
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
}

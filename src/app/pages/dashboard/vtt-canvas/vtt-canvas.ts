import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, Input } from '@angular/core';
import { VttEngine } from '../../../shared/modules/vttEngine/vttEngine.js';
import { DatePipe, NgForOf, NgIf } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { SaveMapDialog } from '../../../objects/save-map/save-map';
import {VttSync} from '../../../shared/services/vttsync/vttsync';
import {ICharacter} from '../../../shared/models/user/character.model';
import {MatIconButton} from '@angular/material/button';
import {MatIcon} from '@angular/material/icon';

@Component({
  selector: 'app-vtt-canvas',
  imports: [DatePipe, NgForOf, NgIf, MatIconButton, MatIcon],
  templateUrl: './vtt-canvas.html',
  styleUrl: './vtt-canvas.scss',
})
export class VttCanvas implements AfterViewInit, OnDestroy {
  @Input() serverId!: string;
  @Input() userId!: string;
  @Input() autoJoin : boolean = false;
  @Input() character!: ICharacter;
  @ViewChild('vttContainer', { static: true }) container!: ElementRef;


  private resizeObserver!: ResizeObserver;
  public engine!: VttEngine;
  public lightingEnabled = false;
  public activeTool: 'select' | 'draw' | 'delete' | 'line' | 'radius' | 'none' = 'select';

  public mapLibrary: any[] = [];
  public currentMapName: string = '';
  public currentMapId: string | null = null;
  public showLibraryOverlay = true;




  // Expose sync state to UI
  get isSyncing() { return this.syncService.isConnected; }
  get isHosting() { return this.syncService.isHosting; }

  constructor(private dialog: MatDialog, public syncService: VttSync) { }

  ngAfterViewInit() {
    this.engine = new VttEngine(this.container.nativeElement, this.userId, 50); //
    console.log("Character loaded!"+ this.character);
    this.loadLibrary();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize(); //
    });
    this.resizeObserver.observe(this.container.nativeElement); //

    if(this.autoJoin){
      this.joinSession();
    }
  }

  ngOnDestroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect(); //
    }
    this.syncService.stopSyncing();
  }

  private handleResize() {
    if (this.engine && this.container) {
      const width = this.container.nativeElement.getBoundingClientRect().width; //
      const height = this.container.nativeElement.getBoundingClientRect().height; //
      this.engine.stage.width(width); //
      this.engine.stage.height(height); //
      this.engine.centerMap(); //
    }
  }

  // --- Sync Controls ---
  startHostingSession() {
    this.syncService.startHosting(this.engine, this.serverId);
    this.engine.setPermissions(true);

  }

  joinSession() {
    this.syncService.joinSession(this.engine, this.serverId, this.character);

    this.engine.setPermissions(false);
  }

  stopSession() {
    this.syncService.stopSyncing();
  }

  // --- Engine Interactions ---
  addToken() {
    this.engine.addToken(100, 100, { name: "New Monster" }); //
    if (this.isSyncing) this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
  }

  addPlayer(){
    this.engine.addToken(100, 100, { name: "New Hero", isPlayer: true }); //
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
    this.lightingEnabled = !this.lightingEnabled; //
    this.engine.lightLayer.visible(this.lightingEnabled); //
    if (this.lightingEnabled) {
      this.engine.updateLighting(); //
    }
    this.engine.stage.batchDraw(); //
    this.engine.stage.fire('lightingToggled', { visible:this.lightingEnabled });
  }

  // --- File/Library Management ---
  onMapUpload(event: any) {
    const file = event.target.files[0]; //
    if (!file) return; //
    const reader = new FileReader(); //
    reader.onload = (e: any) => {
      this.engine.setBackground(e.target.result); //
      if (this.isSyncing) this.syncService.broadcastAction('full-sync', this.engine.getRawConfig());
    };
    reader.readAsDataURL(file); //
  }

  async saveCurrentMap(saveAs: boolean = false) {
    let name = this.currentMapName; //
    let mapId = this.currentMapId; //

    if (!mapId || saveAs) {
      const dialogRef = this.dialog.open(SaveMapDialog, {
        width: '400px', //
        data: { name: name || 'New Map' }, //
        panelClass: 'custom-dialog-container' //
      });

      const result = await dialogRef.afterClosed().toPromise(); //
      if (!result) return; //
      name = result; //
      mapId = crypto.randomUUID(); //
    }

    this.currentMapName = name; //
    this.currentMapId = mapId; //
    const mapData = this.engine.getRawConfig(); //

    const mapEntry = {
      id: this.currentMapId, //
      name: this.currentMapName, //
      lastSaved: new Date().toISOString(), //
      server: this.serverId, //
      data: mapData //
    };

    const index = this.mapLibrary.findIndex(m => m.id === this.currentMapId); //
    if (index > -1) {
      this.mapLibrary[index] = mapEntry; //
    } else {
      this.mapLibrary.push(mapEntry); //
    }

    await (window as any).electronAPI.saveMapLibrary(this.mapLibrary); //
  }

  loadFromLibrary(map: any) {
    this.currentMapId = map.id; //
    this.currentMapName = map.name; //
    this.engine.loadConfigFromObject(map.data); //
    this.showLibraryOverlay = false; //

    // Broadcast the full new map state if we are currently syncing
    if (this.isSyncing) {
      this.syncService.broadcastAction('map-load', this.engine.getRawConfig());
    }
  }

  async toggleArchive(map: any, event: Event) {
    event.stopPropagation(); //
    map.isArchived = !map.isArchived; //
    await this.saveLibraryToDisk(); //
  }

  async deleteMap(map: any, event: Event) {
    event.stopPropagation(); //
    if (confirm(`Are you sure you want to permanently delete "${map.name}"?`)) { //
      this.mapLibrary = this.mapLibrary.filter(m => m.id !== map.id); //
      await this.saveLibraryToDisk(); //
    }
  }

  private async saveLibraryToDisk() {
    await (window as any).electronAPI.saveMapLibrary(this.mapLibrary); //
  }

  async loadLibrary() {
    const library = await (window as any).electronAPI.loadMapLibrary(); //
    this.mapLibrary = library.filter((e: any) => e.server == this.serverId); //
  }

  createNewMap() {
    this.currentMapId = null; //
    this.currentMapName = ''; //
    this.engine.clearAll(); //
    this.showLibraryOverlay = false; //
    if (this.isSyncing) {
      this.syncService.broadcastAction('map-load', this.engine.getRawConfig());
    }
  }
}

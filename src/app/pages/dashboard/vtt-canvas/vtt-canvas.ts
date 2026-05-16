import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, Input, OnChanges, SimpleChanges, Output, EventEmitter, OnInit, Inject } from '@angular/core';
import { DatePipe, NgForOf, NgIf, NgStyle, AsyncPipe, NgClass } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { SaveMapDialog } from '../../../objects/save-map/save-map';
import {VttSync, TurnOrderState, TurnOrderEntry, MapLibraryEntry, StartHostingOptions, GridSettings, SessionStatus} from '../../../shared/services/vttsync/vttsync';
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
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {VttEngine} from '../../../shared/modules/vttEngine/VttEngine';
import {Subscription, Observable, firstValueFrom} from 'rxjs';
import {TabService} from '../../../shared/services/tab/tab-service';
import {ServerService} from '../../../shared/services/server/server';

type HostTakeoverChoice = 'take-control' | 'player';
type FxShapeTool = 'polygon' | 'square' | 'circle' | 'cone' | 'erase';
type TokenConfigTab = 'main' | 'style';
type ActiveTool =
  'select' | 'pointer' | 'draw' | 'delete' |
  'line' | 'radius' | 'cone' |
  'fx-polygon' | 'fx-square' | 'fx-circle' | 'fx-cone' | 'fx-erase' |
  'none';

interface TokenEffect {
  id: string;
  name: string;
  color: string;
}

interface TokenEditConfig {
  name: string;
  icon: string | null;
  iconFile: File | null;
  size: number;
  forceBorder: boolean;
  borderColor: string;
  color: string;
  notes: string;
  currentHealth: number | null;
  maxHealth: number | null;
  healthDelta: number;
  effects: TokenEffect[];
  newEffectName: string;
  newEffectColor: string;
}

type TokenConfigPayload = Omit<TokenEditConfig, 'healthDelta' | 'newEffectName' | 'newEffectColor'>;

@Component({
  selector: 'app-vtt-host-takeover-dialog',
  imports: [MatDialogModule, MatButton, MatIcon],
  template: `
    <div class="vtt-takeover-dialog">
      <h2 mat-dialog-title>Take control of the VTT?</h2>
      <mat-dialog-content>
        <p>Someone else is currently hosting this map. You can take control as DM, or join as a player.</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button (click)="dialogRef.close('player')">Join as Player</button>
        <button mat-raised-button color="primary" (click)="dialogRef.close('take-control')">
          <mat-icon>podcasts</mat-icon>
          Take Control
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .vtt-takeover-dialog {
      background: #313338;
      color: #dbdee1;
      padding: 16px;
      border-radius: 8px;
      max-width: 420px;
    }

    h2 {
      margin: 0;
      font-size: 20px;
    }

    p {
      margin: 0;
      color: #b5bac1;
      line-height: 1.5;
    }

    mat-dialog-actions {
      gap: 8px;
      padding: 16px 0 0;
    }

    button mat-icon {
      margin-right: 6px;
    }
  `]
})
export class VttHostTakeoverDialog {
  constructor(
    public dialogRef: MatDialogRef<VttHostTakeoverDialog, HostTakeoverChoice>,
    @Inject(MAT_DIALOG_DATA) public data: { hostId: string | null }
  ) {}
}

@Component({
  selector: 'app-vtt-canvas',
  standalone: true,
  imports: [
    DatePipe,
    NgForOf, NgIf, NgStyle, NgClass, AsyncPipe,
    MatIconButton, MatButton, MatIcon, MatMenuModule,
    FormsModule, MatFormFieldModule, MatInputModule,
    MatCheckboxModule, MatSelectModule, MatTooltipModule, MatSnackBarModule
  ],
  templateUrl: './vtt-canvas.html',
  styleUrl: './vtt-canvas.scss',
})
export class VttCanvas implements AfterViewInit, OnDestroy, OnChanges, OnInit {
  private static nextInstanceId = 0;

  @Input() serverId!: string;
  @Input() userId!: string;
  @Input() character!: ICharacter;
  @Input() isHostVttSession: boolean = false;
  @Input() isJoiningVttSession: boolean = false;

  @Output() vttSessionHosted = new EventEmitter<string>();
  @Output() vttSessionStopped = new EventEmitter<string>();

  @ViewChild('vttContainer', { static: true }) container!: ElementRef;
  @ViewChild('tokenMenuTrigger') menuTrigger!: MatMenuTrigger;


  private resizeObserver!: ResizeObserver;
  public engine!: VttEngine;
  public lightingEnabled = false;
  public activeTool: ActiveTool = 'select';
  public coneAngle = 53;
  public coneAngleOptions = [53, 30, 45, 60, 90];
  public fxColor = '#6fd6ff';

  public mapLibrary: MapLibraryEntry[] = [];
  public currentMapName: string = '';
  public currentMapId: string | null = null;
  public showLibraryOverlay = false;

  // Context Menu State
  public menuTopLeftPosition = { x: '0px', y: '0px' };
  public selectedToken: any = null;
  public tokenEditConfig: TokenEditConfig = this.createEmptyTokenEditConfig();
  public tokenConfigTab: TokenConfigTab = 'main';
  public tokenIconPreviewUrl: string | null = null;
  public isSavingTokenConfig = false;

  public colorPresets = [
    '#ff4444', '#ffbb33', '#00C851', '#33b5e5', '#2BBBAD', '#4285F4', '#aa66cc',
    '#2E2E2E', '#ffffff', '#ffeb3b', '#e91e63', '#9c27b0'
  ];

  public showHostTakeover = false;
  public isCheckingSession = true;
  private hostDisconnectedSub!: Subscription;
  private sessionEndedSub!: Subscription;
  private turnOrderStateSub!: Subscription; // Subscription for turn order state
  private playerTokenControlSub!: Subscription;
  private playerFxPermissionSub!: Subscription;
  private gridSettingsSub!: Subscription;
  private syncStateRun = 0;
  private noHostedGameClosed = false;
  private hostTakeoverPrompt: Promise<boolean> | null = null;
  private declinedTakeoverHostId: string | null = null;
  private destroyed = false;
  private engineAttachmentId: string | null = null;
  private readonly stageEventNamespace = `.vttCanvas${++VttCanvas.nextInstanceId}`;
  private readonly tokenContextMenuHandler = (data: any) => this.onTokenContextMenu(data);
  private readonly maxContainerReadyFrames = 30;
  public playersCanControlAllPlayerTokens = false;
  public playersCanUseFx = false;
  public gridSettings: GridSettings = {
    size: 50,
    color: '#cccccc',
    thickness: 1,
    type: 'square'
  };

  // Turn Order State
  public turnOrderState$: Observable<TurnOrderState>;
  public newEntryName: string = '';
  public newEntryInitiative: number = 0;
  public turnOrderMinimized = false;
  private lastAddedEntryId: string | null = null; // To track the last added entry for clearing inputs

  // Expose sync state to UI
  get isSyncing() { return this.isInCurrentSession; }
  get isHosting() { return this.syncService.isHosting; }
  get isInCurrentSession() {
    return this.syncService.isConnected && this.syncService.currentRoomId === this.serverId;
  }
  get canUseFx() {
    return !this.isInCurrentSession || this.syncService.isHosting || this.playersCanUseFx;
  }
  get canEditTokens() {
    return !!this.engine?.isDM;
  }
  get tokenPreviewIcon() {
    return this.tokenIconPreviewUrl || this.tokenEditConfig.icon || '';
  }
  get tokenHealthSummary() {
    const currentHealth = this.normalizeTokenHealth(this.tokenEditConfig.currentHealth);
    const maxHealth = this.normalizeTokenHealth(this.tokenEditConfig.maxHealth);

    if (currentHealth === null && maxHealth === null) return 'Not tracked';
    if (maxHealth === null) return `${currentHealth ?? 0} HP`;
    return `${currentHealth ?? maxHealth}/${maxHealth} HP`;
  }

  constructor(
    private dialog: MatDialog,
    public syncService: VttSync,
    private tabService: TabService,
    private serverService: ServerService,
    private snackBar: MatSnackBar
  ) {
    this.turnOrderState$ = this.syncService.turnOrder$.asObservable();
  }

  ngOnInit() {
    if (this.character) {
        this.newEntryName = this.character.name;
    }
  }

  ngAfterViewInit() {
    void this.initializeCanvas();
  }

  private async initializeCanvas() {
    await this.waitForContainerSize();
    if (this.destroyed) return;

    if (this.syncService.currentRoomId === this.serverId && this.syncService.getEngine()) {
      this.engine = this.syncService.getEngine()!;
      this.engine.setContainer(this.container.nativeElement);
      this.engine.stage.batchDraw();
    } else {
      this.engine = new VttEngine(this.container.nativeElement, this.userId, 50);
    }
    this.engineAttachmentId = this.syncService.attachEngine(this.engine, this.serverId);
    this.gridSettings = this.normalizeGridSettings(this.engine.getGridSettings());

    this.engine.stage.off(`tokenContextMenu${this.stageEventNamespace}`);
    this.engine.stage.on(`tokenContextMenu${this.stageEventNamespace}`, this.tokenContextMenuHandler);

    this.loadLibrary();

    this.resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => this.handleResize());
    });
    this.resizeObserver.observe(this.container.nativeElement);

    this.hostDisconnectedSub = this.syncService.hostDisconnected$.subscribe(disconnected => {
        void this.handleHostDisconnected(disconnected);
    });

    this.sessionEndedSub = this.syncService.sessionEnded$.subscribe(() => {
      this.showVttMessage('Session Closed', 4000);
      this.tabService.closeTab(this.serverId);
    });

    this.turnOrderStateSub = this.turnOrderState$.subscribe(state => {
      // Clear inputs only after the entry is confirmed in the state
      if (this.lastAddedEntryId && state.entries.some(entry => entry.id === this.lastAddedEntryId)) {
        this.newEntryInitiative = 0;
        this.lastAddedEntryId = null;
      }
    });

    this.playerTokenControlSub = this.syncService.playersCanControlAllPlayerTokens$.subscribe(enabled => {
      this.playersCanControlAllPlayerTokens = enabled;
    });

    this.playerFxPermissionSub = this.syncService.playersCanUseFx$.subscribe(enabled => {
      this.playersCanUseFx = enabled;
      if (!this.canUseFx && this.activeTool.startsWith('fx-')) {
        this.setTool('select');
      }
    });

    this.gridSettingsSub = this.syncService.gridSettings$.subscribe(settings => {
      this.gridSettings = { ...settings };
    });

    this.handleResize();
    void this.handleSyncState();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['isHostVttSession'] || changes['isJoiningVttSession']) && this.engine) {
      void this.handleSyncState();
    }
    if (changes['character'] && this.character) {
        this.newEntryName = this.character.name;
        if (this.engine && this.isCheckingSession) {
          void this.handleSyncState();
        }
    }
  }

  private async handleSyncState() {
    if (!this.engine || !this.serverId || !this.character) return;

    const runId = ++this.syncStateRun;
    this.isCheckingSession = true;

    if (this.isHostVttSession && !this.syncService.isHosting) {
      const status = await this.getHostedSessionStatus();
      if (runId !== this.syncStateRun) return;

      if (status?.active === false) {
        this.startHostingSession();
        return;
      }

      const resumed = await this.joinExistingSession();
      if (runId !== this.syncStateRun) return;
      this.startHostingSession(resumed ? { preserveExistingState: true } : {});
      return;
    }

    if (this.isInCurrentSession) {
      if (!this.syncService.isHosting && await this.canCurrentUserDm()) {
        const status = await this.getHostedSessionStatus();
        if (runId !== this.syncStateRun) return;

        if (await this.shouldTakeControlHostedSession(status)) {
          if (runId !== this.syncStateRun) return;
          this.startHostingSession({ preserveExistingState: true });
          return;
        }

        this.applyPermissions(false);
        this.isCheckingSession = false;
        return;
      }

      this.applyPermissions(this.syncService.isHosting);
      this.isCheckingSession = false;
      return;
    }

    if (this.isJoiningVttSession && !this.isInCurrentSession) {
      const status = await this.getHostedSessionStatus();
      if (runId !== this.syncStateRun) return;
      if (status?.active === false) {
        this.closeNoHostedGame();
        return;
      }

      const joined = await this.joinExistingSessionWithHostChoice(status);
      if (runId !== this.syncStateRun) return;
      if (!joined) {
        this.closeNoHostedGame();
      }
      return;
    }

    if (
      !this.isHostVttSession &&
      !this.isJoiningVttSession &&
      this.syncService.isConnected &&
      !!this.syncService.currentRoomId &&
      this.syncService.currentRoomId !== this.serverId
    ) {
      this.syncService.stopSyncing(true);
    }

    if (!this.isHostVttSession && !this.isJoiningVttSession) {
      if (await this.canCurrentUserDm()) {
        const status = await this.getHostedSessionStatus();
        if (runId !== this.syncStateRun) return;

        if (status?.active === false) {
          this.syncService.stopSyncing(true);
          this.applyPermissions(true);
          this.isCheckingSession = false;
          return;
        }

        const resumed = await this.joinExistingSessionWithHostChoice(status);
        if (runId !== this.syncStateRun) return;

        if (!resumed) {
          this.applyPermissions(true);
          this.isCheckingSession = false;
        }
        return;
      }

      const status = await this.getHostedSessionStatus();
      if (runId !== this.syncStateRun) return;
      if (status?.active === false) {
        this.closeNoHostedGame();
        return;
      }

      const joined = await this.joinExistingSession();
      if (runId !== this.syncStateRun) return;

      if (!joined) {
        this.closeNoHostedGame();
      } else {
        this.isCheckingSession = false;
      }
      return;
    }

    this.isCheckingSession = false;
  }

  async joinSession(): Promise<boolean> {
    const status = await this.getHostedSessionStatus();
    if (status?.active === false) {
      this.closeNoHostedGame();
      return false;
    }

    const joined = await this.joinExistingSessionWithHostChoice(status);
    if (!joined) {
      this.closeNoHostedGame();
    }
    return joined;
  }

  async requestHostingSession() {
    this.isCheckingSession = true;
    const status = await this.getHostedSessionStatus();

    if (status?.active && status.hasHost && !this.syncService.isHosting) {
      if (!(await this.canCurrentUserDm())) {
        const joined = await this.joinExistingSession();
        if (!joined) {
          this.closeNoHostedGame();
        } else {
          this.isCheckingSession = false;
        }
        return;
      }

      const takeControl = await this.promptForHostTakeover(status);
      if (!takeControl) {
        const joined = await this.joinExistingSession();
        if (!joined) {
          this.closeNoHostedGame();
        } else {
          this.isCheckingSession = false;
        }
        return;
      }

      const joined = await this.joinExistingSession();
      if (!joined) {
        this.closeNoHostedGame();
        return;
      }

      this.startHostingSession({ preserveExistingState: true });
      return;
    }

    this.startHostingSession(status?.active ? { preserveExistingState: true } : {});
  }

  startHostingSession(options: StartHostingOptions = {}) {
      this.syncService.startHosting(this.engine, this.serverId, options);
      this.applyPermissions(true);
      this.showHostTakeover = false;
      this.declinedTakeoverHostId = null;
      this.isCheckingSession = false;
  }

  stopSession() {
      this.vttSessionStopped.emit(this.serverId);
      this.syncService.endSession();
  }

  private async joinExistingSession(): Promise<boolean> {
    this.applyPermissions(false);
    const joined = await this.syncService.joinSession(this.engine, this.serverId, this.character);

    if (!joined) {
      this.syncService.stopSyncing(true);
    }

    return joined;
  }

  private async joinExistingSessionWithHostChoice(status: SessionStatus | null): Promise<boolean> {
    const takeControl = await this.shouldTakeControlHostedSession(status);
    const joined = await this.joinExistingSession();

    if (!joined) {
      return false;
    }

    if (takeControl) {
      this.startHostingSession({ preserveExistingState: true });
    } else {
      this.isCheckingSession = false;
    }

    return true;
  }

  private async shouldTakeControlHostedSession(status: SessionStatus | null): Promise<boolean> {
    if (!(await this.canCurrentUserDm())) {
      return false;
    }

    if (!status?.active) {
      return false;
    }

    if (!status.hasHost) {
      return true;
    }

    return this.promptForHostTakeover(status);
  }

  private async promptForHostTakeover(status: SessionStatus): Promise<boolean> {
    if (!status.hostId || this.declinedTakeoverHostId === status.hostId) {
      return false;
    }

    if (!this.hostTakeoverPrompt) {
      this.isCheckingSession = false;
      const dialogRef = this.dialog.open(VttHostTakeoverDialog, {
        width: '430px',
        disableClose: true,
        data: { hostId: status.hostId },
        panelClass: 'custom-dialog-container'
      });

      this.hostTakeoverPrompt = firstValueFrom(dialogRef.afterClosed())
        .then(choice => choice === 'take-control')
        .finally(() => {
          this.hostTakeoverPrompt = null;
        });
    }

    const takeControl = await this.hostTakeoverPrompt;
    if (!takeControl) {
      this.declinedTakeoverHostId = status.hostId;
    }

    return takeControl;
  }

  private async handleHostDisconnected(disconnected: boolean) {
    if (!disconnected || this.isHosting) {
      this.showHostTakeover = false;
      return;
    }

    if (await this.canCurrentUserDm()) {
      this.startHostingSession({ preserveExistingState: true });
      return;
    }

    this.showHostTakeover = true;
  }

  private applyPermissions(isHost: boolean) {
    this.engine.setPermissions(isHost);
  }

  private async canCurrentUserDm(): Promise<boolean> {
    let server = this.serverService.getCurrentServer();
    if ((!server || server._id !== this.serverId) && this.serverId) {
      await this.serverService.getServerDetails(this.serverId);
      server = this.serverService.getCurrentServer();
    }

    return this.serverService.canUserDm(server, this.userId);
  }

  private async getHostedSessionStatus(): Promise<SessionStatus | null> {
    const status = await this.syncService.getSessionStatus(this.serverId);
    return status.ok ? status : null;
  }

  private closeNoHostedGame() {
    this.isCheckingSession = false;
    if (this.noHostedGameClosed) return;

    this.noHostedGameClosed = true;
    this.syncService.stopSyncing(true);
    this.showVttMessage('there is no game right now', 4000);
    this.tabService.closeTab(this.serverId);
  }

  private showVttMessage(message: string, duration = 3000) {
    this.snackBar.open(message, 'Close', {
      duration,
      horizontalPosition: 'center',
      verticalPosition: 'bottom'
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.resetTokenEditorState();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.hostDisconnectedSub) this.hostDisconnectedSub.unsubscribe();
    if (this.sessionEndedSub) this.sessionEndedSub.unsubscribe();
    if (this.turnOrderStateSub) this.turnOrderStateSub.unsubscribe(); // Unsubscribe
    if (this.playerTokenControlSub) this.playerTokenControlSub.unsubscribe();
    if (this.playerFxPermissionSub) this.playerFxPermissionSub.unsubscribe();
    if (this.gridSettingsSub) this.gridSettingsSub.unsubscribe();
    if (this.engine) {
      this.engine.setPointerMode(false);
      this.engine.stage.off(`tokenContextMenu${this.stageEventNamespace}`);
      this.syncService.detachEngine(this.engine, this.serverId, this.engineAttachmentId);
      this.engineAttachmentId = null;
    }
    if (this.syncService.currentRoomId !== this.serverId) {
      this.syncService.stopSyncing(true);
    }
  }

  private handleResize() {
    if (this.engine && this.container) {
      const rect = this.container.nativeElement.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      if (width <= 0 || height <= 0) {
        return;
      }

      if (this.engine.stage.width() !== width || this.engine.stage.height() !== height) {
        this.engine.stage.width(width);
        this.engine.stage.height(height);
        this.engine.centerMap();
        this.engine.stage.batchDraw();
      }
    }
  }

  private waitForContainerSize(): Promise<void> {
    if (this.hasContainerSize()) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let attempts = 0;
      const check = () => {
        if (this.destroyed || this.hasContainerSize() || attempts >= this.maxContainerReadyFrames) {
          resolve();
          return;
        }

        attempts++;
        window.requestAnimationFrame(check);
      };

      window.requestAnimationFrame(check);
    });
  }

  private hasContainerSize(): boolean {
    const rect = this.container?.nativeElement?.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  private createEmptyTokenEditConfig(): TokenEditConfig {
    return {
      name: '',
      icon: null,
      iconFile: null,
      size: 1,
      forceBorder: false,
      borderColor: '#ffffff',
      color: '#ff0000',
      notes: '',
      currentHealth: null,
      maxHealth: null,
      healthDelta: 1,
      effects: [],
      newEffectName: '',
      newEffectColor: '#ffeb3b'
    };
  }

  onTokenContextMenu({ token, evt }: any) {
    if (!this.canEditTokens) return;

    this.resetTokenEditorState();
    this.selectedToken = token;
    this.tokenEditConfig = {
      name: token.name,
      icon: this.normalizeTokenIcon(token.imageUrl),
      iconFile: null,
      size: token.size,
      forceBorder: token.forceBorder,
      borderColor: token.borderColor,
      color: token.color,
      notes: token.notes || '',
      currentHealth: this.normalizeTokenHealth(token.currentHealth),
      maxHealth: this.normalizeTokenHealth(token.maxHealth),
      healthDelta: 1,
      effects: this.normalizeTokenEffects(token.effects),
      newEffectName: '',
      newEffectColor: this.getNextTokenEffectColor(token.effects?.length ?? 0)
    };

    this.menuTopLeftPosition.x = evt.clientX + 'px';
    this.menuTopLeftPosition.y = evt.clientY + 'px';
    this.menuTrigger.openMenu();
  }

  async onTokenConfigMenuClosed() {
    if (this.isSavingTokenConfig) return;

    if (!this.selectedToken || !this.canEditTokens) {
      this.resetTokenEditorState();
      return;
    }

    await this.saveTokenConfig({ closeMenu: false, resetOnFailure: true });
  }

  setTokenConfigTab(tab: TokenConfigTab) {
    this.tokenConfigTab = tab;
  }

  onTokenIconUpload(event: any) {
    if (!this.canEditTokens || !this.selectedToken) return;

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.showVttMessage('Please choose an image file.');
      return;
    }

    this.revokeTokenPreviewUrl();
    this.tokenEditConfig.iconFile = file;
    this.tokenIconPreviewUrl = URL.createObjectURL(file);
  }

  onTokenIconUrlChange() {
    this.tokenEditConfig.iconFile = null;
    this.revokeTokenPreviewUrl();
  }

  clearTokenIcon() {
    if (!this.canEditTokens) return;

    this.tokenEditConfig.iconFile = null;
    this.tokenEditConfig.icon = null;
    this.revokeTokenPreviewUrl();
  }

  async applyTokenConfig() {
    await this.saveTokenConfig({ closeMenu: true, resetOnFailure: false });
  }

  private async saveTokenConfig({ closeMenu, resetOnFailure }: { closeMenu: boolean; resetOnFailure: boolean }) {
    if (!this.selectedToken || !this.canEditTokens || this.isSavingTokenConfig) return;

    this.isSavingTokenConfig = true;
    let shouldResetEditor = resetOnFailure;

    try {
      const tokenId = this.selectedToken.id;
      const { iconFile, ...cleanConfig } = this.buildTokenConfigPayload();
      const updated = await this.syncService.updateToken(tokenId, cleanConfig, iconFile ?? undefined);

      if (!updated) {
        this.showVttMessage('Token update failed.');
        return;
      }

      this.tokenEditConfig.iconFile = null;
      this.revokeTokenPreviewUrl();
      shouldResetEditor = true;

      if (closeMenu) {
        this.menuTrigger.closeMenu();
      }
    } finally {
      if (shouldResetEditor) {
        this.resetTokenEditorState();
      }

      this.isSavingTokenConfig = false;
    }
  }

  deleteSelectedToken() {
    if (!this.selectedToken || !this.canEditTokens) return;

    const id = this.selectedToken.id;
    this.engine.removeToken(id);
    this.revokeTokenPreviewUrl();
    this.selectedToken = null;
    this.menuTrigger.closeMenu();
  }

  duplicateSelectedToken() {
    if (!this.selectedToken || !this.canEditTokens || this.isSavingTokenConfig) return;

    const source = this.selectedToken;
    const gridSize = this.engine?.gridSize || 50;
    const sourceX = source.group?.x?.() ?? 100;
    const sourceY = source.group?.y?.() ?? 100;
    const sourceName = source.name?.trim() || 'Token';

    this.engine.addToken(sourceX + gridSize, sourceY, {
      id: crypto.randomUUID(),
      name: `${sourceName} Copy`,
      icon: source.imageUrl,
      color: source.color,
      ownerId: source.ownerId,
      isPlayer: source.isPlayer,
      size: source.size,
      forceBorder: source.forceBorder,
      borderColor: source.borderColor,
      notes: source.notes,
      currentHealth: source.currentHealth,
      maxHealth: source.maxHealth,
      effects: this.normalizeTokenEffects(source.effects)
    });

    this.menuTrigger.closeMenu();
  }

  adjustTokenHealth(direction: -1 | 1) {
    if (this.isSavingTokenConfig) return;

    const amount = this.normalizeTokenHealth(this.tokenEditConfig.healthDelta) ?? 0;
    if (amount <= 0) return;

    const maxHealth = this.normalizeTokenHealth(this.tokenEditConfig.maxHealth);
    const currentHealth = this.normalizeTokenHealth(this.tokenEditConfig.currentHealth) ?? maxHealth ?? 0;
    this.tokenEditConfig.currentHealth = this.clampTokenHealth(currentHealth + (amount * direction), maxHealth);
  }

  onTokenHealthInputChange() {
    this.tokenEditConfig.currentHealth = this.normalizeTokenHealth(this.tokenEditConfig.currentHealth);
    this.tokenEditConfig.maxHealth = this.normalizeTokenHealth(this.tokenEditConfig.maxHealth);
    this.tokenEditConfig.healthDelta = this.normalizeTokenHealth(this.tokenEditConfig.healthDelta) ?? 1;

    if (this.tokenEditConfig.healthDelta <= 0) {
      this.tokenEditConfig.healthDelta = 1;
    }

    if (this.tokenEditConfig.currentHealth !== null) {
      this.tokenEditConfig.currentHealth = this.clampTokenHealth(
        this.tokenEditConfig.currentHealth,
        this.tokenEditConfig.maxHealth
      );
    }
  }

  addTokenEffect() {
    if (this.isSavingTokenConfig) return;

    const effect = this.createTokenEffect(this.tokenEditConfig.newEffectName, this.tokenEditConfig.newEffectColor);
    if (!effect) return;

    const effects = this.normalizeTokenEffects(this.tokenEditConfig.effects);
    if (this.hasTokenEffectNamed(effects, effect.name)) {
      this.showVttMessage('That effect is already on this token.');
      return;
    }

    this.tokenEditConfig.effects = [...effects, effect].slice(0, 12);
    this.tokenEditConfig.newEffectName = '';
    this.tokenEditConfig.newEffectColor = this.getNextTokenEffectColor(this.tokenEditConfig.effects.length);
  }

  removeTokenEffect(effectId: string) {
    if (this.isSavingTokenConfig) return;

    this.tokenEditConfig.effects = this.normalizeTokenEffects(this.tokenEditConfig.effects)
      .filter(effect => effect.id !== effectId);
  }

  private buildTokenConfigPayload(): TokenConfigPayload {
    const maxHealth = this.normalizeTokenHealth(this.tokenEditConfig.maxHealth);
    let currentHealth = this.normalizeTokenHealth(this.tokenEditConfig.currentHealth);
    const effects = this.getTokenEffectsForSave();

    if (currentHealth !== null) {
      currentHealth = this.clampTokenHealth(currentHealth, maxHealth);
    }

    return {
      name: this.tokenEditConfig.name?.trim() || 'Token',
      icon: this.normalizeTokenIcon(this.tokenEditConfig.icon),
      iconFile: this.tokenEditConfig.iconFile,
      size: this.normalizeTokenSize(this.tokenEditConfig.size),
      forceBorder: !!this.tokenEditConfig.forceBorder,
      borderColor: this.tokenEditConfig.borderColor || '#ffffff',
      color: this.tokenEditConfig.color || '#808080',
      notes: this.tokenEditConfig.notes || '',
      currentHealth,
      maxHealth,
      effects
    };
  }

  private normalizeTokenIcon(icon: unknown): string | null {
    if (typeof icon !== 'string') return null;

    const trimmedIcon = icon.trim();
    return trimmedIcon ? trimmedIcon : null;
  }

  private normalizeTokenSize(size: unknown): number {
    const parsedSize = Number(size);
    return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 1;
  }

  private normalizeTokenHealth(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;

    const parsedHealth = Number(value);
    return Number.isFinite(parsedHealth) ? Math.max(0, Math.round(parsedHealth)) : null;
  }

  private getTokenEffectsForSave(): TokenEffect[] {
    const effects = this.normalizeTokenEffects(this.tokenEditConfig.effects);
    const pendingEffect = this.createTokenEffect(
      this.tokenEditConfig.newEffectName,
      this.tokenEditConfig.newEffectColor
    );

    if (!pendingEffect || this.hasTokenEffectNamed(effects, pendingEffect.name)) {
      return effects;
    }

    return [...effects, pendingEffect].slice(0, 12);
  }

  private normalizeTokenEffects(effects: unknown): TokenEffect[] {
    if (!Array.isArray(effects)) return [];

    return effects
      .map((effect, index) => this.createTokenEffect(
        typeof effect === 'string' ? effect : (effect as Partial<TokenEffect>)?.name,
        typeof effect === 'string' ? this.getNextTokenEffectColor(index) : (effect as Partial<TokenEffect>)?.color,
        typeof effect === 'string' ? undefined : (effect as Partial<TokenEffect>)?.id,
        index
      ))
      .filter((effect): effect is TokenEffect => !!effect)
      .slice(0, 12);
  }

  private createTokenEffect(name: unknown, color: unknown, id?: unknown, fallbackIndex = 0): TokenEffect | null {
    if (typeof name !== 'string') return null;

    const trimmedName = name.trim();
    if (!trimmedName) return null;

    return {
      id: typeof id === 'string' && id.trim() ? id.trim() : crypto.randomUUID(),
      name: trimmedName,
      color: this.normalizeTokenEffectColor(color, fallbackIndex)
    };
  }

  private normalizeTokenEffectColor(color: unknown, fallbackIndex = 0): string {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())) {
      return color.trim().toLowerCase();
    }

    return this.getNextTokenEffectColor(fallbackIndex);
  }

  private getNextTokenEffectColor(index: number): string {
    const effectColors = ['#f44336', '#ff9800', '#ffeb3b', '#4caf50', '#2196f3', '#9c27b0'];
    return effectColors[Math.max(0, index) % effectColors.length];
  }

  private hasTokenEffectNamed(effects: TokenEffect[], name: string): boolean {
    const normalizedName = name.trim().toLowerCase();
    return effects.some(effect => effect.name.trim().toLowerCase() === normalizedName);
  }

  private clampTokenHealth(value: number, maxHealth: number | null): number {
    const nonNegativeValue = Math.max(0, Math.round(value));
    return maxHealth === null ? nonNegativeValue : Math.min(nonNegativeValue, maxHealth);
  }

  private revokeTokenPreviewUrl() {
    if (this.tokenIconPreviewUrl) {
      URL.revokeObjectURL(this.tokenIconPreviewUrl);
      this.tokenIconPreviewUrl = null;
    }
  }

  private resetTokenEditorState() {
    this.revokeTokenPreviewUrl();
    this.selectedToken = null;
    this.tokenConfigTab = 'main';
    this.tokenEditConfig = this.createEmptyTokenEditConfig();
  }

  addToken() {
    const id = crypto.randomUUID();
    const options = { id, name: "New Monster" };
    this.engine.addToken(100, 100, options);
  }

  addPlayer(){
    const id = crypto.randomUUID();
    const options = { id, name: "New Hero", isPlayer: true };
    this.engine.addToken(100, 100, options);
  }

  setMeasureTool(tool: 'line' | 'radius' | 'cone' | 'none', coneAngle = this.coneAngle) {
    this.activeTool = tool;
    if (tool === 'cone') {
      this.coneAngle = coneAngle;
    }
    this.engine.wallManager.setMode('none');
    this.engine.setFxMode('none');
    this.engine.setMeasurementMode(tool, tool === 'cone' ? { coneAngle: this.coneAngle } : {});
  }

  setTool(mode: 'select' | 'pointer' | 'draw' | 'delete') {
    this.activeTool = mode;

    if (mode === 'pointer') {
      this.engine.setPointerMode(true);
      return;
    }

    this.engine.setPointerMode(false);
    this.engine.setFxMode('none');
    this.engine.setMeasurementMode('none');
    if (mode === 'select') {
      this.engine.wallManager.setMode('none');
    } else {
      this.engine.wallManager.setMode(mode);
    }
  }

  setFxTool(tool: FxShapeTool, coneAngle = this.coneAngle) {
    if (!this.canUseFx) return;

    this.activeTool = `fx-${tool}` as ActiveTool;
    if (tool === 'cone') {
      this.coneAngle = coneAngle;
    }

    this.engine.setMeasurementMode('none');
    this.engine.setFxMode(tool, {
      color: this.fxColor,
      ...(tool === 'cone' ? { coneAngle: this.coneAngle } : {})
    });
  }

  onFxColorChange() {
    this.engine.setFxColor(this.fxColor);
    if (this.activeTool.startsWith('fx-')) {
      const tool = this.activeTool.replace('fx-', '') as FxShapeTool;
      this.engine.setFxMode(tool, {
        color: this.fxColor,
        ...(tool === 'cone' ? { coneAngle: this.coneAngle } : {})
      });
    }
  }

  setPlayersCanUseFx(enabled: boolean) {
    this.syncService.setPlayersCanUseFx(enabled);
  }

  clearFxEffects() {
    if (!this.canUseFx) return;
    this.engine.clearFxEffects(false);
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

  togglePlayerTokenControlMode() {
    this.syncService.setPlayersCanControlAllPlayerTokens(!this.playersCanControlAllPlayerTokens);
  }

  applyGridSettings() {
    if (this.syncService.getEngine() === this.engine) {
      this.syncService.updateGridSettings(this.gridSettings);
    } else {
      this.engine.updateGridSettings(this.gridSettings, false);
    }

    if (this.engine) {
      this.gridSettings = this.normalizeGridSettings(this.engine.getGridSettings());
    }
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

  async onMapUpload(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await this.syncService.setMap(file);
    } catch (err) {
      console.error("Failed to upload map", err);
      this.showVttMessage("Failed to upload map image.");
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
        this.showVttMessage("Invalid map file format.");
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

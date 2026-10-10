import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  OnChanges,SimpleChanges,
  HostListener,
  ViewChildren,
  QueryList,
  Output,
  EventEmitter,
  ChangeDetectorRef,
} from '@angular/core';
import { Video } from '../../../shared/services/video/video';
import type {
  CallParticipantMetadata,
  CallRecordingParticipant,
  CompanionDeviceOption,
  CompanionSourceId,
  MobileCallJoinMode,
  ParticipantMediaDiagnostics
} from '../../../shared/models/video/video.model';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf } from '@angular/common';
import { ICharacter } from '../../../shared/models/user/character.model';
import { TabService } from '../../../shared/services/tab/tab-service';
import { SoundCloudService } from '../../../shared/services/playlist/soundcloud.service';
import { ActivatedRoute } from '@angular/router';
import { SpotifyPlayer } from './spotify-player/spotify-player';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ThemeService } from '../../../shared/services/theme/theme.service';
import type { PinnedTheme, ThemeColors } from '../../../shared/models/theme/theme.service.model';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ServerService } from '../../../shared/services/server/server';
import { IServer, TemporaryDmDuration } from '../../../shared/models/server/server.model';
import { MarkdownComponent } from 'ngx-markdown';
import { AuthService } from '../../../shared/services/auth/auth';
import { DeviceService } from '../../../shared/services/device/device';
import { ObsidianVaultService, VaultEntry } from '../../../shared/services/ObsidianVault/obsidian-vault-service';
import { MilkdownEditorComponent } from '../../../shared/components/milkdown-editor/milkdown-editor.component';
import { SessionRecordingService } from '../../../shared/services/session-recording/session-recording';
import type {
  RecordedCallEnvironmentEvent,
  RecordedCallEnvironmentAction,
  SessionPlaybackState,
  SessionRecording,
  SessionRecordingMedia,
  SessionRecordingParticipantMedia
} from '../../../shared/models/session-recording/session-recording.model';
import { AstralRecordingService } from '../../../shared/services/astral-recording/astral-recording';
import type { AstralLocalRecordingEntry, AstralRecordingImportResponse, AstralUnpackedRecordingEntry } from '../../../shared/models/astral-recording/astral-recording.model';
import { AstralPlaybackDropService } from '../../../shared/services/astral-recording/astral-playback-drop';
import type { AstralPlaybackDropRequest } from '../../../shared/models/astral-recording/astral-playback-drop.model';
import { AstralOptimizerService } from '../../../shared/services/astral-recording/astral-optimizer';
import type { AstralOptimizationJob } from '../../../shared/services/astral-recording/astral-optimizer';
import { AstralPackagingQueueService } from '../../../shared/services/astral-recording/astral-packaging-queue';
import type { AstralPackagingJob } from '../../../shared/services/astral-recording/astral-packaging-queue';
import { VttSync } from '../../../shared/services/vttsync/vttsync';
import type { ParticipantStream, VttStopEvent, VttPlaybackEvent, VttSessionState, MicrophoneProcessingMode, RemoteVideoQualityLevel, StoredCallMediaPreferences, RemoteContextMenuState, PriorityGridPlacement, CallPlaybackSource, RecordedCallParticipantSnapshot, RecordedSpotifyState, RecordedCallEnvironmentState } from '../../../shared/models/pages/dashboard/call/call.model';
import {
  CALL_DEFAULT_PC_SOURCE,
  CALL_DM_CHARACTER,
  CALL_MAX_THEME_SYNC_PAYLOAD_BYTES,
  CALL_MICROPHONE_PROCESSING_OPTIONS,
  CALL_REMOTE_VIDEO_QUALITY_OPTIONS,
  CALL_TEMPORARY_DM_DURATIONS
} from './call.constants';
import {
  buildCallMediaConstraints,
  getRemoteVideoQualityPreference,
  isMobileCallJoinMode,
  isMicrophoneProcessingMode,
  isRemoteVideoQualityPreference,
  normalizeRemoteVideoQualityLevel,
  parseDeviceTypeParam,
  preferenceToRemoteVideoQualityLevel,
  readStoredCallMediaPreferences,
  resolveAvailableDeviceId,
  writeStoredCallMediaPreferences
} from './call-media-preferences';
import {
  getPriorityGridMaxHeightPx,
  getPriorityGridPlacement as getScenePriorityGridPlacement,
  getSceneMainAreaHeightPx,
  getSceneMainAreaHeightRatio,
  getSceneMainGridRowCount,
  getSceneMainRowHeightCss,
  getSceneMainRowHeightPx,
  getSceneSideRowCount,
  getSceneSideRowHeightCss,
  getSceneSideRowHeightPx,
  getSceneSideTileMaxWidthCss,
  measureSceneGridContent
} from './call-scene-grid';
import * as callDiagnostics from './call-diagnostics-formatters';
import { CallRemoteAudioRouter } from './call-remote-audio-router';
import {
  cloneThemeColors,
  compressThemeBackgroundImage,
  getRevertedThemeBackground,
  getTemporaryAtmosphereTheme,
  isThemePayloadSizeError,
  isThemeSyncPayloadTooLarge,
  toCssImageValue
} from './call-theme.helpers';
import {
  cloneSpotifyRequests,
  createRecordedSpotifyState,
  createRecordedSpotifyStateFromCurrent,
  createRecordedSpotifyStateFromPlaybackState,
  createRecordedSpotifyStateFromSyncPayload,
  normalizeSpotifyVolume
} from './call-recorded-spotify';
export type { VttStopEvent, VttPlaybackEvent } from '../../../shared/models/pages/dashboard/call/call.model';

type CallLivestreamBroadcastOverlayType = 'theme' | 'image' | 'text' | 'atmosphere';

interface CallLivestreamBroadcastOverlay {
  type: CallLivestreamBroadcastOverlayType;
  title: string;
  text: string | null;
  image: string | null;
  startedAtMs: number;
  durationMs: number;
}

interface CallLivestreamMusicState {
  title: string;
  artist: string;
  image: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  volumePercent: number;
  audioStream: MediaStream | null;
  canCaptureAudio: boolean;
  audioStreamIsPostVolume?: boolean;
  captureSource?: 'native' | 'output-capture' | 'none';
}

interface CallLivestreamParticipant {
  id: string;
  name: string;
  race: string;
  icon: string | null;
  level?: number;
  isDungeonMaster: boolean;
  avatarLabel: string;
  stream: MediaStream | null;
  videoElement: HTMLVideoElement | null;
  isLocal: boolean;
  isVideoHidden: boolean;
  volumePercent: number;
  isSceneMainCharacter: boolean;
}

interface CallLivestreamSourceSnapshot {
  channelId: string;
  hasLiveCall: boolean;
  isPlaybackMode: boolean;
  theme: ThemeColors;
  temporaryAtmosphereBackground: string | null;
  participants: CallLivestreamParticipant[];
  music: CallLivestreamMusicState | null;
  isSceneMainLayoutActive: boolean;
  broadcastOverlay: CallLivestreamBroadcastOverlay | null;
}

function toFiniteRecordingNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeParticipantPlaybackVolume(value: unknown): number {
  return Math.max(0, Math.min(200, Math.round(toFiniteRecordingNumber(value, 100))));
}

function getImportedRecordingDurationMs(
  recording: any,
  participantMedia: SessionRecordingParticipantMedia[]
): number {
  const directDuration = toFiniteRecordingNumber(recording?.durationMs, 0);
  if (directDuration > 0) {
    return Math.round(directDuration);
  }

  const participantDuration = participantMedia.reduce((maxDuration, participant) => {
    const endedAtMs = toFiniteRecordingNumber(participant?.endedAtMs, 0);
    return Math.max(maxDuration, endedAtMs);
  }, 0);

  return Math.max(0, Math.round(participantDuration));
}

function hasPlayableCallRecording(recording: SessionRecording | null | undefined): boolean {
  if (!recording) {
    return false;
  }

  const hasPrimaryMedia = !!recording.media?.url || !!recording.media?.path;
  const hasParticipantMedia = (recording.participantMedia ?? []).some(participant =>
    !!participant.media?.url || !!participant.media?.path
  );
  return hasPrimaryMedia || hasParticipantMedia;
}

function hasSameTrackSet(
  currentTracks: ReadonlyArray<MediaStreamTrack> | null | undefined,
  nextTracks: ReadonlyArray<MediaStreamTrack> | null | undefined
): boolean {
  const current = (currentTracks ?? []).map(track => `${track.kind}:${track.id}`).sort();
  const next = (nextTracks ?? []).map(track => `${track.kind}:${track.id}`).sort();
  if (current.length !== next.length) {
    return false;
  }

  return current.every((entry, index) => entry === next[index]);
}

function createCharacterSnapshot(userData: Partial<ICharacter> | null | undefined): Partial<ICharacter> | null {
  if (!userData) {
    return null;
  }

  return JSON.parse(JSON.stringify(userData)) as Partial<ICharacter>;
}

interface CallSessionNoteUpdatedEventDetail {
  serverId?: string | null;
  channelId?: string | null;
  path?: string;
  appendedContent?: string;
  content?: string;
  select?: boolean;
}

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, SpotifyPlayer, MatIconModule, MatTooltipModule, MatMenuModule, MatSnackBarModule, MarkdownComponent, MilkdownEditorComponent]
})
export class Call implements OnInit, OnDestroy, OnChanges {
  @Input() channelId!: string;
  @Input() character!: ICharacter;
  @Input() isTabActive: boolean = true;

  @Output() hostVtt = new EventEmitter<string>();
  @Output() joinVtt = new EventEmitter<string>();
  @Output() stopVtt = new EventEmitter<string | VttStopEvent>();
  @Output() playbackVtt = new EventEmitter<string | VttPlaybackEvent>();

  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('previewVideo') previewVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('micTestAudio') micTestAudio?: ElementRef<HTMLAudioElement>;
  @ViewChild('sessionNoteSearchInput') set sessionNoteSearchInput(value: ElementRef<HTMLInputElement> | undefined) {
    this.sessionNoteSearchInputRef = value;
    if (value && this.showSessionNotePicker) {
      setTimeout(() => value.nativeElement.focus(), 0);
    }
  }
  @ViewChild('gridContainer') set gridContainer(value: ElementRef<HTMLElement> | undefined) {
    this.gridContainerRef = value;
    this.observeSceneMainLayoutSize();
  }
  @ViewChildren('remoteVideo') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;

  videoDevices: MediaDeviceInfo[] = [];
  audioDevices: MediaDeviceInfo[] = [];
  audioOutputDevices: MediaDeviceInfo[] = [];
  selectedVideoId: string = '';
  selectedAudioId: string = '';
  selectedOutputId: string = '';
  microphoneProcessingMode: MicrophoneProcessingMode = 'studio';
  remoteVideoQualityLevel: RemoteVideoQualityLevel = 1;
  selectedPcVideoSource: CompanionSourceId = CALL_DEFAULT_PC_SOURCE;
  selectedPcAudioSource: CompanionSourceId = CALL_DEFAULT_PC_SOURCE;
  companionDevices: CompanionDeviceOption[] = [];
  readonly microphoneProcessingOptions = CALL_MICROPHONE_PROCESSING_OPTIONS;
  readonly remoteVideoQualityOptions = CALL_REMOTE_VIDEO_QUALITY_OPTIONS;
  readonly supportsMicTestRecording = false;
  readonly supportsSessionRecording = false;

  localStream: MediaStream | null = null;
  previewStream: MediaStream | null = null;
  remoteStreams: ParticipantStream[] = [];
  hideSelfView = false;
  sceneMainCharacterIds: string[] = [];
  maxSceneMainCharacters = 4;
  hasSceneMainLayoutSpace = true;
  sceneGridContentWidthPx = 0;
  sceneGridContentHeightPx = 0;
  localParticipantPing: number | undefined;
  localParticipantDiagnostics?: ParticipantMediaDiagnostics;
  micInputLevel = 0;
  isSessionRecording = false;
  sessionRecordingDurationSeconds = 0;
  sessionRecordingError = '';
  recordedSession: SessionRecording | null = null;
  isCallPlaybackMode = false;
  isLivestreaming = false;
  isStartingLivestream = false;
  isStoppingLivestream = false;
  fakeLivestreamCallerCount = 0;
  readonly maxFakeLivestreamCallers = 16;
  isSavingAstralRecording = false;
  isTauriDesktop = false;
  showLocalRecordingsLibrary = false;
  isLoadingLocalRecordings = false;
  packagingUnpackedRecordingIds = new Set<string>();
  optimizingLocalRecordingPaths = new Set<string>();
  localRecordingsError = '';
  localAstralRecordings: AstralLocalRecordingEntry[] = [];
  localUnpackedRecordings: AstralUnpackedRecordingEntry[] = [];
  pendingAstralPlaybackRequest: AstralPlaybackDropRequest | null = null;
  pendingAstralPlaybackFilename = '';
  pendingAstralPlaybackRequiresDisconnect = false;


  isAudioMuted = false;
  isVideoOff = false;
  isPreviewMuted = false;
  isPreviewVideoOff = false;
  isJoining = false;
  isMobileBrowser = false;
  isPreparingMobileMedia = false;
  mobileMediaReady = false;
  mobileMediaMessage = '';
  mobileJoinMode: MobileCallJoinMode = 'caller';
  joinError = '';
  experimentalMobile1080pEnabled = false;
  private hasRequestedMobileMedia = false;

  // UI States
  showSpotify: boolean = false;
  showThemePicker: boolean = false;
  showDeviceRouting: boolean = false;
  showDiagnosticsPanel: boolean = false;
  showPinNaming: boolean = false;
  newThemeName: string = '';
  remoteContextMenu: RemoteContextMenuState | null = null;
  private readonly clickOffSafeSelector = '.call-overlay-content, .call-overlay-trigger, .cdk-overlay-container';

  // Theme state
  activeColors: ThemeColors;
  pinnedThemes: PinnedTheme[] = [];
  private themePickerBaselineColors: ThemeColors | null = null;
  private lastValidThemeBackgroundImage: string | null = null;
  private lastValidThemeBackgroundImageBlur = false;

  // VTT Session state
  vttSession: VttSessionState = { active: false, roomId: null, hostId: null };
  showVttNotification: boolean = false;
  private vttNotificationTimeout: any;

  // Broadcast state
  activeOverlayImage: string | null = null;
  activeOverlayText: string | null = null;
  activeTemporaryAtmosphereBackground: string | null = null;
  broadcastOverlayNoteSaving: 'current' | 'new' | null = null;
  broadcastOverlayNoteStatus = '';
  private lastBroadcastOverlayActivatedAt = 0;
  private readonly broadcastOverlayDismissGraceMs = 250;
  private callLivestreamBroadcastOverlay: CallLivestreamBroadcastOverlay | null = null;
  private readonly callLivestreamBroadcastOverlayDurationMs = 20000;

  // Session notes state
  showSessionNotes = false;
  sessionNotesVaultName: string | null = null;
  sessionNotesPermissionGranted = false;
  sessionNotesLoading = false;
  sessionNotesError = '';
  sessionNoteEntries: VaultEntry[] = [];
  selectedSessionNotePath = '';
  selectedSessionNoteName = '';
  selectedSessionNoteContent = '';
  sessionNotesSaveState: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
  showSessionNotePicker = false;
  sessionNotesSearchQuery = '';
  sessionNotesActiveOptionIndex = 0;
  isCreatingSessionNote = false;
  newSessionNoteName = '';
  selectedSessionNoteTemplate = 'session';
  private sessionNotesSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionNoteSearchInputRef?: ElementRef<HTMLInputElement>;
  readonly sessionNoteTemplates = [
    { value: 'session', label: 'Session' },
    { value: 'blank', label: 'Blank' }
  ];

  // Spotify Requests
  spotifyRequests: any[] = [];
  showSpotifyRequests: boolean = false;
  playbackSpotifyState: RecordedSpotifyState | null = null;
  playbackSpotifyVolumePercent = 25;
  soundCloudVolumePercent = 25;

  // DM Mode State
  isServerOwner: boolean = false;
  canManageTemporaryDms: boolean = false;
  isDmMode: boolean = false;
  temporaryDmDurations: Array<{ duration: TemporaryDmDuration; label: string }> = CALL_TEMPORARY_DM_DURATIONS;
  dmCharacter: ICharacter = CALL_DM_CHARACTER;

  private readonly subscriptions = new Subscription();
  private syncDebounceTimer: any = null;
  private isSyncing: boolean = false;
  private pendingSoundCloudSyncState: any = null;
  private lastAppliedSoundCloudSyncTimestamp = 0;
  private soundCloudSyncApplySequence = 0;
  private readonly maxSoundCloudSyncDriftMs = 30000;
  private readonly soundCloudHostSyncIntervalMs = 12000;
  private readonly soundCloudStateRequestRetryDelaysMs = [0, 750, 2500];
  private soundCloudHostSyncInterval: ReturnType<typeof setInterval> | null = null;
  private soundCloudStateRequestTimers: Array<ReturnType<typeof setTimeout>> = [];
  private soundCloudParticipantSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly remoteAudioRouter = new CallRemoteAudioRouter(() => this.selectedOutputId);
  readonly supportsAudioOutputSelection = this.remoteAudioRouter.supportsAudioOutputSelection;
  readonly supportsRemoteAudioGain = this.remoteAudioRouter.supportsRemoteAudioGain;

  private isComponentDestroying = false;
  private lastAutoSelectedCompanionVideoId: string | null = null;
  private micLevelAudioContext: AudioContext | null = null;
  private micLevelAnalyser: AnalyserNode | null = null;
  private micLevelSource: MediaStreamAudioSourceNode | null = null;
  private micLevelStream: MediaStream | null = null;
  private micLevelData: Uint8Array | null = null;
  private micLevelInterval: any;
  private monitoredMicTrack: MediaStreamTrack | null = null;
  private callPlaybackRecordingId: string | null = null;
  private callPlaybackEnvironmentEventIndex = 0;
  private callPlaybackLastTimeMs = 0;
  private callEnvironmentBeforePlayback: RecordedCallEnvironmentState | null = null;
  private isApplyingCallPlaybackEnvironment = false;
  private isRestoringCallPlaybackEnvironment = false;
  private lastRecordedCallParticipantsSnapshot = '';
  private callPlaybackParticipantSnapshots = new Map<string, RecordedCallParticipantSnapshot>();
  private activePlaybackVttRoomId: string | null = null;
  playbackLocalParticipantStream: ParticipantStream | null = null;
  playbackParticipantStreams: ParticipantStream[] = [];
  callPlaybackPaused = true;
  isCallPlaybackBuffering = false;
  callPlaybackCurrentTimeMs = 0;
  callPlaybackDurationMs = 0;
  private callPlaybackSources: CallPlaybackSource[] = [];
  private callPlaybackSourcesRecordingId: string | null = null;
  private callPlaybackMediaHost: HTMLDivElement | null = null;
  private visiblePlaybackSourceTargets = new Map<string, HTMLVideoElement>();
  private readonly visibleRemoteVideoTrackAttachments =
    new WeakMap<HTMLVideoElement, NonNullable<ParticipantStream['remoteVideoTrack']>>();
  private callPlaybackSyncInterval: any;
  private isSeekingCallPlaybackSources = false;
  private callPlaybackClockStartedAtMs = 0;
  private callPlaybackClockStartTimeMs = 0;
  private callPlaybackBufferTimeMs = 0;
  private visiblePlaybackSyncToken = 0;
  private lastAppliedPlaybackSpotifySignature = '';
  private playbackSpotifyBaseState: RecordedSpotifyState | null = null;
  private playbackSpotifyRecordedAtMs = 0;
  private forceCallPlaybackEnvironmentReset = false;
  private readonly callPlaybackEnvironmentSeekResetThresholdMs = 1500;
  private readonly callPlaybackPreloadWindowMs = 30000;
  private readonly callPlaybackReleaseWindowMs = 120000;
  private readonly callPlaybackAttachRetryMs = 1000;
  private readonly callPlaybackBufferStartDriftMs = 750;
  private readonly callPlaybackBufferResumeDriftMs = 250;
  private isImportingAstralPlayback = false;
  private readonly astralOptimizationJobStatuses = new Map<string, AstralOptimizationJob['status']>();
  private readonly astralPackagingJobStatuses = new Map<string, AstralPackagingJob['status']>();
  private gridContainerRef?: ElementRef<HTMLElement>;
  private gridResizeObserver: ResizeObserver | null = null;
  private readonly recordingAndStreamingEnabled = false;
  private deviceReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private isLoadingDevices = false;
  private pendingDeviceReload = false;
  private isApplyingDeviceChange = false;
  private pendingDeviceChange = false;
  private readonly deviceReloadDebounceMs = 350;
  private readonly handleDeviceChangeBound = () => {
    this.scheduleDeviceReload();
  };

  constructor(
    private videoService: Video,
    private tabService: TabService,
    public spotify: SoundCloudService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    public themeService: ThemeService,
    private serverService: ServerService,
    private authService: AuthService,
    private deviceService: DeviceService,
    private obsidianVaultService: ObsidianVaultService,
    private snackBar: MatSnackBar,
    private sessionRecording: SessionRecordingService,
    private astralRecording: AstralRecordingService,
    private astralOptimizer: AstralOptimizerService,
    private astralPackagingQueue: AstralPackagingQueueService,
    private astralPlaybackDrop: AstralPlaybackDropService,
    private vttSync: VttSync
  ) {
    this.activeColors = this.themeService.getColors();
    this.rememberValidThemeBackground(this.activeColors);
  }

  async ngOnInit() {
    this.bindRouteParams();
    this.bindServerState();
    this.bindCallLivestreamState();
    await this.initializeMediaState();
    await this.restoreLiveCallOrStartPreview();
    this.bindRemoteStreamState();
    this.bindSoundCloudState();
    this.bindAtmosphereState();
    this.bindDeviceRoutingState();
    this.bindSessionRecordingState();
    this.bindAstralOptimizationState();
    this.bindAstralPackagingState();
    this.registerCallLivestreamSource();

    this.checkServerOwner();
    this.cdr.detectChanges();
  }

  private bindRouteParams() {
    this.subscriptions.add(this.route.queryParams.subscribe(params => {
      if (params['soundcloud_access_token']) {
        this.spotify.setTokens(params['soundcloud_access_token'], params['soundcloud_refresh_token']);
      } else if (params['access_token']) {
        this.spotify.setTokens(params['access_token'], params['refresh_token']);
      }

      const forcedDeviceType = parseDeviceTypeParam(params['deviceType']);
      if (forcedDeviceType) {
        this.deviceService.setDeviceTypeOverride(forcedDeviceType);
      } else if (params['clearDeviceTypeOverride'] === 'true') {
        this.deviceService.clearDeviceTypeOverride();
      }

      this.isMobileBrowser = this.deviceService.getDeviceType() === 'mobile';
    }));
  }

  private bindServerState() {
    this.subscriptions.add(this.serverService.getServerDetailsObservable().subscribe(() => {
      this.checkServerOwner();
      this.cdr.detectChanges();
    }));
  }

  private bindCallLivestreamState() {
    this.isLivestreaming = false;
    this.isStartingLivestream = false;
    this.isStoppingLivestream = false;
  }

  private registerCallLivestreamSource() {
    // Livestreaming is disabled.
  }

  private async initializeMediaState() {
    this.isMobileBrowser = this.deviceService.getDeviceType() === 'mobile';
    this.isTauriDesktop = this.recordingAndStreamingEnabled
      && await this.astralRecording.isAvailable().catch(() => false);
    this.microphoneProcessingMode = this.isMobileBrowser ? 'processed' : 'studio';
    await this.restoreStoredMediaPreferences();
    this.remoteVideoQualityLevel = preferenceToRemoteVideoQualityLevel(
      this.videoService.getRemoteVideoQualityPreference()
    );
    this.maxSceneMainCharacters = this.videoService.getMaxSceneMainCharacters();

    if (!this.isMobileBrowser) {
      await this.loadDevices();
      this.mobileMediaReady = true;
      navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChangeBound);
    }
  }

  private async restoreLiveCallOrStartPreview() {
    const existingStream = this.videoService.getLocalStream();
    if (existingStream && this.videoService.currentChannelId === this.channelId) {
      this.localStream = existingStream;
      this.isAudioMuted = !this.localStream.getAudioTracks().every(t => t.enabled);
      this.isVideoOff = !this.localStream.getVideoTracks().every(t => t.enabled);
      this.syncPreviewSetupFromLive();
      this.syncMicInputMonitor();

      setTimeout(() => {
        if (this.localVideo) {
          this.localVideo.nativeElement.srcObject = this.localStream;
        }
      }, 100);
    } else {
      if (!this.isMobileBrowser) {
        await this.startPreview();
      }
    }
  }

  private bindRemoteStreamState() {
    this.subscriptions.add(this.videoService.remoteStreams$.subscribe(streams => {
      const localParticipantData = streams.find(p => p.isLocal);
      if (localParticipantData) {
        this.localParticipantPing = localParticipantData.ping;
        this.localParticipantDiagnostics = localParticipantData.diagnostics;
      }

      this.refreshVisibleRemoteStreams(streams);
      this.recordCallParticipantsSnapshotIfChanged();
      if (
        this.remoteContextMenu &&
        !this.isContextMenuParticipantAvailable(this.remoteContextMenu.remoteId)
      ) {
        this.closeRemoteContextMenu();
      }

      this.updateLocalVideoDisplay(streams);

      setTimeout(() => {
        this.bindVisibleRemoteVideos();
        void this.applyAudioOutputToAllMedia();
      });
    }));
  }

  private bindSoundCloudState() {
    this.soundCloudVolumePercent = this.spotify.getVolumePercent();
    this.subscriptions.add(this.spotify.volumePercent$.subscribe(volumePercent => {
      this.soundCloudVolumePercent = this.normalizeSoundCloudVolumePercent(volumePercent);
      this.cdr.detectChanges();
    }));
    this.subscriptions.add(this.videoService.spotifySync$.subscribe(state => {
      void this.applyIncomingSoundCloudSync(state);
    }));
    this.subscriptions.add(this.spotify.syncAction$.subscribe(action => {
      this.handleLocalSoundCloudAction(action);
    }));
    this.subscriptions.add(this.videoService.spotifyStateRequest$.subscribe(() => {
      void this.broadcastCurrentSoundCloudState('auto', false);
    }));
    this.subscriptions.add(this.videoService.spotifyRequest$.subscribe(req => {
      this.addSoundCloudRequest(req);
    }));
    this.subscriptions.add(this.videoService.callReconnected$.subscribe(() => {
      this.handleSoundCloudCallSyncNudge();
    }));
    this.subscriptions.add(this.videoService.callParticipantConnected$.subscribe(() => {
      this.handleSoundCloudCallSyncNudge();
    }));
  }

  private handleSoundCloudCallSyncNudge() {
    if (!this.localStream) {
      return;
    }

    if (this.isServerOwner) {
      this.scheduleSoundCloudParticipantSync();
      return;
    }

    this.requestSoundCloudStateWithRetries();
  }

  private async applyIncomingSoundCloudSync(state: any) {
    if (!this.localStream) return;

    const isVolumeOnlyCommand = state.command === 'volume';
    if (!state.uri && !isVolumeOnlyCommand) return;

    const hasAuthorizedHost = !!state.hostId && this.isAuthorizedDmUserId(state.hostId);
    const stateTimestamp = this.normalizeSoundCloudSyncTimestamp(state.timestamp);
    if (this.isServerOwner) {
      if (!hasAuthorizedHost) return;
      if (state.source === 'auto' && (Date.now() - this.spotify.lastActionTime < 5000)) return;
    } else {
      if (!hasAuthorizedHost) return;
      if (this.isStaleSoundCloudSync(stateTimestamp)) return;
      if (this.isSyncing) {
        this.pendingSoundCloudSyncState = state;
        return;
      }
      this.isSyncing = true;
    }

    const applySequence = ++this.soundCloudSyncApplySequence;
    try {
      const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload(state);
      this.recordMusicAction(state.command ?? 'sync', state, state.source ?? 'remote', recordedSpotifyState);
      if (recordedSpotifyState) {
        this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
      }

      if (isVolumeOnlyCommand || !state.uri) {
        this.rememberAppliedSoundCloudSyncTimestamp(stateTimestamp);
        return;
      }

      const currentState = await this.spotify.getPlaybackState().catch(() => null);
      const isDifferentTrack = currentState?.track_window?.current_track?.uri !== state.uri;
      const drift = this.getSoundCloudSyncDriftMs(stateTimestamp, state.paused);
      const adjustedPosition = this.normalizeSoundCloudSyncPosition(state.position) + drift;
      const isDifferentPosition = !currentState ||
        Math.abs(currentState.position - adjustedPosition) > 2000;
      const isDifferentStatus = currentState?.paused !== state.paused;
      const isDifferentShuffle = state.shuffle !== undefined && currentState?.shuffle_state !== state.shuffle;

      if (isDifferentShuffle) {
        await this.spotify.toggleShuffle(state.shuffle, true);
      }

      if (state.command === 'seek') {
        if (currentState?.track_window?.current_track?.uri === state.uri) {
          await this.spotify.seek(adjustedPosition, true);
        }
      } else if (isDifferentTrack || isDifferentPosition || isDifferentStatus) {
        await this.applySoundCloudPlaybackSync(
          state,
          adjustedPosition,
          isDifferentTrack,
          isDifferentPosition,
          applySequence
        );
      }

      this.rememberAppliedSoundCloudSyncTimestamp(stateTimestamp);
    } finally {
      if (!this.isServerOwner) {
        this.isSyncing = false;
        const pendingState = this.pendingSoundCloudSyncState;
        this.pendingSoundCloudSyncState = null;
        if (pendingState) {
          queueMicrotask(() => void this.applyIncomingSoundCloudSync(pendingState));
        }
      }
    }
  }

  private normalizeSoundCloudSyncTimestamp(value: unknown): number | null {
    const timestamp = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  private isStaleSoundCloudSync(timestamp: number | null): boolean {
    return !!timestamp &&
      !!this.lastAppliedSoundCloudSyncTimestamp &&
      timestamp < this.lastAppliedSoundCloudSyncTimestamp;
  }

  private rememberAppliedSoundCloudSyncTimestamp(timestamp: number | null) {
    if (!timestamp || this.isServerOwner) {
      return;
    }

    this.lastAppliedSoundCloudSyncTimestamp = Math.max(
      this.lastAppliedSoundCloudSyncTimestamp,
      timestamp
    );
  }

  private getSoundCloudSyncDriftMs(timestamp: number | null, paused: boolean): number {
    if (!timestamp || paused) {
      return 0;
    }

    return Math.min(
      this.maxSoundCloudSyncDriftMs,
      Math.max(0, Date.now() - timestamp)
    );
  }

  private normalizeSoundCloudSyncPosition(value: unknown): number {
    const position = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(position) ? Math.max(0, Math.round(position)) : 0;
  }

  private async applySoundCloudPlaybackSync(
    state: any,
    adjustedPosition: number,
    isDifferentTrack: boolean,
    isDifferentPosition: boolean,
    applySequence: number
  ) {
    const metadata = {
      name: state.name,
      artist: state.artist,
      image: state.image,
      duration: state.duration
    };

    if (!state.paused) {
      if (isDifferentTrack || isDifferentPosition) {
        await this.spotify.play(state.uri, adjustedPosition, true, state.contextUri, metadata);
      } else {
        await this.spotify.togglePlay(true);
      }
    } else if (isDifferentTrack) {
      await this.spotify.play(state.uri, this.normalizeSoundCloudSyncPosition(state.position), true, state.contextUri, metadata);
      setTimeout(() => {
        if (applySequence === this.soundCloudSyncApplySequence && this.localStream) {
          void this.spotify.pause(true);
        }
      }, 1000);
    } else {
      await this.spotify.pause(true);
    }

    if (!isDifferentTrack && isDifferentPosition && !state.paused) {
      await this.spotify.seek(adjustedPosition, true);
    }
  }

  private handleLocalSoundCloudAction(action: any) {
    if (!this.localStream) return;

    // Keep volume local-only; do not sync volume across the call.
    if (action.command === 'volume') {
      return;
    }

    if (this.isServerOwner) {
      const payload = { ...action.data, hostId: this.character.ownerId };
      const recordedMusicState = this.createRecordedSpotifyStateFromSyncPayload(payload);
      this.recordMusicAction(action.command, payload, action.source, recordedMusicState);

      if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);

      this.syncDebounceTimer = setTimeout(() => {
        const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload(payload);
        if (recordedSpotifyState) {
          this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
        }
        void this.videoService.sendSpotifyCommand(action.command, payload, action.source);
      }, 400);
      return;
    }

    if (action.command === 'play' && action.data?.uri) {
      this.recordMusicAction('request', action.data, action.source ?? 'manual', null);
      void this.videoService.sendSpotifyRequest({
        uri: action.data.uri,
        name: action.data.name || 'Requested Song',
        artist: action.data.artist || 'Unknown Artist',
        image: action.data.image || ''
      }, this.character.name);
    }
  }

  private async broadcastCurrentSoundCloudState(
    source: 'manual' | 'auto' = 'manual',
    shouldRecord: boolean = true
  ) {
    if (!this.localStream || !this.isServerOwner) {
      return;
    }

    const state = await this.spotify.getPlaybackState().catch(() => null);
    if (state && state.track_window?.current_track) {
      const payload = {
        uri: state.track_window.current_track.uri,
        name: state.track_window.current_track.name,
        artist: state.track_window.current_track.artist || state.track_window.current_track.artists?.[0]?.name,
        image: state.track_window.current_track.image || state.track_window.current_track.album?.images?.[0]?.url,
        position: state.position,
        paused: state.paused,
        playing: !state.paused,
        contextUri: state.context?.uri,
        duration: state.duration,
        shuffle: state.shuffle_state,
        volumePercent: this.getCurrentSpotifyVolumePercent(),
        hostId: this.character.ownerId
      };

      await this.videoService.sendSpotifyCommand('sync', payload, source);
      if (shouldRecord) {
        const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload(payload);
        this.recordMusicAction('sync', payload, source, recordedSpotifyState);
        if (recordedSpotifyState) {
          this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
        }
      }
    }

    if (shouldRecord && this.activeColors) {
      this.safeSendThemeUpdate(this.activeColors);
    }
  }

  private requestSoundCloudStateWithRetries() {
    this.clearSoundCloudStateRequestTimers();

    this.soundCloudStateRequestTimers = this.soundCloudStateRequestRetryDelaysMs.map(delayMs =>
      setTimeout(() => {
        if (this.localStream && !this.isServerOwner) {
          void this.videoService.requestSpotifyState();
        }
      }, delayMs)
    );
  }

  private clearSoundCloudStateRequestTimers() {
    this.soundCloudStateRequestTimers.forEach(timer => clearTimeout(timer));
    this.soundCloudStateRequestTimers = [];
  }

  private scheduleSoundCloudParticipantSync() {
    if (this.soundCloudParticipantSyncTimer) {
      clearTimeout(this.soundCloudParticipantSyncTimer);
    }

    this.soundCloudParticipantSyncTimer = setTimeout(() => {
      this.soundCloudParticipantSyncTimer = null;
      void this.broadcastCurrentSoundCloudState('auto', false);
    }, 500);
  }

  private syncSoundCloudHostSyncTimer() {
    if (this.localStream && this.isServerOwner && !this.isCallPlaybackMode) {
      if (this.soundCloudHostSyncInterval) {
        return;
      }

      this.soundCloudHostSyncInterval = setInterval(() => {
        void this.broadcastCurrentSoundCloudState('auto', false);
      }, this.soundCloudHostSyncIntervalMs);
      return;
    }

    this.stopSoundCloudHostSyncTimer();
  }

  private stopSoundCloudHostSyncTimer() {
    if (!this.soundCloudHostSyncInterval) {
      return;
    }

    clearInterval(this.soundCloudHostSyncInterval);
    this.soundCloudHostSyncInterval = null;
  }

  private stopSoundCloudCallSyncTimers() {
    this.stopSoundCloudHostSyncTimer();
    this.clearSoundCloudStateRequestTimers();
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }
    this.pendingSoundCloudSyncState = null;
    this.isSyncing = false;
    this.lastAppliedSoundCloudSyncTimestamp = 0;
    this.soundCloudSyncApplySequence += 1;
    if (this.soundCloudParticipantSyncTimer) {
      clearTimeout(this.soundCloudParticipantSyncTimer);
      this.soundCloudParticipantSyncTimer = null;
    }
  }

  private addSoundCloudRequest(req: any) {
    if (!this.isServerOwner) {
      return;
    }

    if (!req?.uri) {
      return;
    }

    const isDuplicate = this.spotifyRequests.some(r =>
      (req.requestId && r.requestId === req.requestId) ||
      (r.uri === req.uri && r.fromName === req.fromName)
    );
    if (isDuplicate) {
      return;
    }

    this.spotifyRequests.push(req);
    this.recordSpotifyRequestsSnapshot();
    this.cdr.detectChanges();
  }

  private bindAtmosphereState() {
    this.subscriptions.add(this.videoService.themeSync$.subscribe(colors => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.activeColors = colors;
      this.rememberValidThemeBackground(colors);
      this.themeService.applyTheme(colors, false); // DO NOT save call atmosphere to local player preference
      this.activateCallLivestreamBroadcastOverlay({
        type: 'theme',
        title: 'Atmosphere Broadcast',
        text: 'Atmosphere updated',
        image: colors.backgroundImage ?? null
      });
      this.recordCallEnvironmentEvent('theme-sync', colors);
    }));

    this.subscriptions.add(this.themeService.pinnedThemes$.subscribe(themes => {
      this.pinnedThemes = themes;
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.vttSession$.subscribe(session => {
      const wasActive = this.vttSession.active;
      const recordedSession = this.createRecordedVttSessionState(session, this.vttSession);
      this.vttSession = session;
      if (session.active && !wasActive && session.hostId !== this.videoService.getCurrentParticipantIdentity()) {
        this.triggerVttNotification();
      } else if (!session.active) {
        this.showVttNotification = false;
        if (this.vttNotificationTimeout) clearTimeout(this.vttNotificationTimeout);
      }
      this.recordCallEnvironmentEvent('vtt-session', recordedSession);
    }));

    this.subscriptions.add(this.videoService.overlayImage$.subscribe(url => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      if (url) {
        this.activateCallLivestreamBroadcastOverlay({
          type: 'image',
          title: 'Image Broadcast',
          text: null,
          image: url
        });
      } else {
        this.clearCallLivestreamBroadcastOverlay('image');
      }
      if (url === this.activeOverlayImage && !(url && this.activeOverlayText)) {
        return;
      }
      this.activeOverlayImage = url;
      if (url) {
        this.lastBroadcastOverlayActivatedAt = Date.now();
        this.broadcastOverlayNoteStatus = '';
        this.activeOverlayText = null;
      }
      this.recordCallEnvironmentEvent('overlay-image', { url });
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.overlayText$.subscribe(text => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      const broadcastText = text?.trim() || '';
      if (broadcastText) {
        this.activateCallLivestreamBroadcastOverlay({
          type: 'text',
          title: 'Text Broadcast',
          text: broadcastText,
          image: null
        });
      } else {
        this.clearCallLivestreamBroadcastOverlay('text');
      }
      if (text === this.activeOverlayText && !(text && this.activeOverlayImage)) {
        return;
      }
      this.activeOverlayText = text;
      if (text) {
        this.lastBroadcastOverlayActivatedAt = Date.now();
        this.broadcastOverlayNoteStatus = '';
        this.activeOverlayImage = null;
      }
      this.recordCallEnvironmentEvent('overlay-text', { text });
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.temporaryAtmosphereBackground$.subscribe(url => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      if (url) {
        this.activateCallLivestreamBroadcastOverlay({
          type: 'atmosphere',
          title: 'Atmosphere Broadcast',
          text: 'Temporary atmosphere updated',
          image: url
        });
      } else {
        this.clearCallLivestreamBroadcastOverlay('atmosphere');
      }
      if (url === this.activeTemporaryAtmosphereBackground) {
        return;
      }
      this.activeTemporaryAtmosphereBackground = url;
      this.recordCallEnvironmentEvent('temporary-atmosphere-background', { url });
      this.applyTemporaryAtmosphereBackground(url);
    }));
  }

  private bindDeviceRoutingState() {
    this.subscriptions.add(this.videoService.callKicked$.subscribe(async reason => {
      await this.handleCallKickout(reason);
    }));

    this.subscriptions.add(this.videoService.companionDevices$.subscribe(devices => {
      const previousCompanionIds = new Set(this.companionDevices.map(device => device.identity));
      this.companionDevices = devices;
      void this.autoSelectCompanionCamera(devices, previousCompanionIds);
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.selectedVideoSource$.subscribe(sourceId => {
      this.selectedPcVideoSource = sourceId;
      if (sourceId === 'desktop-local') {
        this.lastAutoSelectedCompanionVideoId = null;
      }
      this.updateLocalVideoDisplay();
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.selectedAudioSource$.subscribe(sourceId => {
      this.selectedPcAudioSource = sourceId;
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.remoteVideoQualityPreference$.subscribe(preference => {
      this.remoteVideoQualityLevel = preferenceToRemoteVideoQualityLevel(preference);
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.participantVolumes$.subscribe(() => {
      this.remoteStreams = this.remoteStreams.map(remote => ({
        ...remote,
        volumePercent: this.videoService.getParticipantVolume(remote.id)
      }));
      this.applyRemoteVolumes();
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.videoService.sceneMainCharacters$.subscribe(state => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.sceneMainCharacterIds = state.participantIds;
      this.refreshSceneMainCharacterFlags();
      this.recordCallEnvironmentEvent('scene-main-characters', state);
      this.cdr.detectChanges();
    }));
  }

  private bindSessionRecordingState() {
    if (!this.recordingAndStreamingEnabled) {
      this.isSessionRecording = false;
      this.sessionRecordingDurationSeconds = 0;
      this.recordedSession = null;
      return;
    }

    this.subscriptions.add(this.sessionRecording.recordingState$.subscribe(state => {
      this.isSessionRecording = state.active;
      this.sessionRecordingDurationSeconds = Math.floor(state.elapsedMs / 1000);
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.sessionRecording.lastRecording$.subscribe(recording => {
      this.recordedSession = recording;
      this.cdr.detectChanges();
    }));

    this.subscriptions.add(this.sessionRecording.playbackState$.subscribe(state => {
      this.applyCallPlaybackState(state);
    }));

    this.subscriptions.add(this.astralPlaybackDrop.requests$.subscribe(request => {
      this.handleAstralPlaybackRequest(request);
    }));
    this.handlePendingAstralPlaybackRequest();
  }

  private bindAstralPackagingState() {
    if (!this.recordingAndStreamingEnabled) {
      this.packagingUnpackedRecordingIds.clear();
      return;
    }

    this.subscriptions.add(this.astralPackagingQueue.jobs$.subscribe(jobs => {
      this.packagingUnpackedRecordingIds = new Set(
        jobs
          .filter(job => this.isActiveAstralPackagingJob(job))
          .map(job => job.recordingId)
      );

      const knownJobIds = new Set(jobs.map(job => job.id));
      for (const jobId of Array.from(this.astralPackagingJobStatuses.keys())) {
        if (!knownJobIds.has(jobId)) {
          this.astralPackagingJobStatuses.delete(jobId);
        }
      }

      const shouldRefreshLocalRecordings = jobs.some(job => {
        const previousStatus = this.astralPackagingJobStatuses.get(job.id);
        this.astralPackagingJobStatuses.set(job.id, job.status);
        return previousStatus && previousStatus !== job.status && job.status === 'completed';
      });

      if (shouldRefreshLocalRecordings && this.showLocalRecordingsLibrary) {
        void this.refreshLocalRecordings();
        return;
      }

      this.cdr.detectChanges();
    }));
  }

  private isActiveAstralPackagingJob(job: AstralPackagingJob): boolean {
    return job.status === 'queued' || job.status === 'running';
  }

  private bindAstralOptimizationState() {
    if (!this.recordingAndStreamingEnabled) {
      this.optimizingLocalRecordingPaths.clear();
      return;
    }

    this.subscriptions.add(this.astralOptimizer.jobs$.subscribe(jobs => {
      this.optimizingLocalRecordingPaths = new Set(
        jobs
          .filter(job => this.isActiveAstralOptimizationJob(job))
          .map(job => job.packagePath)
      );

      const knownJobIds = new Set(jobs.map(job => job.id));
      for (const jobId of Array.from(this.astralOptimizationJobStatuses.keys())) {
        if (!knownJobIds.has(jobId)) {
          this.astralOptimizationJobStatuses.delete(jobId);
        }
      }

      const shouldRefreshLocalRecordings = jobs.some(job => {
        const previousStatus = this.astralOptimizationJobStatuses.get(job.id);
        this.astralOptimizationJobStatuses.set(job.id, job.status);
        return previousStatus && previousStatus !== job.status && job.status === 'completed';
      });

      if (shouldRefreshLocalRecordings && this.showLocalRecordingsLibrary) {
        void this.refreshLocalRecordings();
        return;
      }

      this.cdr.detectChanges();
    }));
  }

  private isActiveAstralOptimizationJob(job: AstralOptimizationJob): boolean {
    return job.status === 'queued' || job.status === 'running';
  }

  checkServerOwner() {
    const server = this.serverService.getCurrentServer();
    const serverOwnerId = server ? this.extractOwnerId(server) : '';
    const currentUserId = this.character?.ownerId || '';
    const dmControllerUserIds = server ? this.getActiveDmUserIds(server) : [];

    this.videoService.setSceneMainCharacterControllerUserIds(dmControllerUserIds);
    this.canManageTemporaryDms = !!serverOwnerId && serverOwnerId === currentUserId;
    this.isServerOwner = this.serverService.canUserDm(server, currentUserId);
    this.syncSoundCloudHostSyncTimer();

    if (!this.isServerOwner && this.isDmMode) {
      this.isDmMode = false;
      if (this.channelId && this.character) {
        this.videoService.updateUserData(this.channelId, this.character);
      }
    }
  }

  private extractOwnerId(server: IServer): string {
    return this.serverService.getServerOwnerId(server);
  }

  private getActiveDmUserIds(server: IServer): string[] {
    const userIds = new Set<string>();
    const ownerId = this.extractOwnerId(server);
    if (ownerId) userIds.add(ownerId);

    server.members?.forEach(member => {
      const memberId = this.serverService.getMemberUserId(member);
      if (memberId && this.serverService.isTemporaryDmGrantActive(member.temporaryDm)) {
        userIds.add(memberId);
      }
    });

    return Array.from(userIds);
  }

  private isAuthorizedDmUserId(userId: string | null | undefined): boolean {
    return this.serverService.canUserDm(this.serverService.getCurrentServer(), userId);
  }

  private buildMediaConstraints(): MediaStreamConstraints {
    return buildCallMediaConstraints({
      isMobileBrowser: this.isMobileBrowser,
      experimentalMobile1080pEnabled: this.experimentalMobile1080pEnabled,
      selectedVideoId: this.selectedVideoId,
      selectedAudioId: this.selectedAudioId,
      microphoneProcessingMode: this.microphoneProcessingMode
    });
  }

  private scheduleDeviceReload() {
    if (this.deviceReloadTimer) {
      clearTimeout(this.deviceReloadTimer);
    }

    this.deviceReloadTimer = setTimeout(() => {
      this.deviceReloadTimer = null;
      void this.loadDevices();
    }, this.deviceReloadDebounceMs);
  }

  private async applySelectedSourceBandwidthOptimizations(stream: MediaStream) {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      return;
    }

    const selectedCameraLabel = this.videoDevices.find(device => device.deviceId === this.selectedVideoId)?.label ?? '';
    const label = `${selectedCameraLabel} ${videoTrack.label || ''}`.toLowerCase();
    const isObsVirtualCamera = label.includes('obs') && label.includes('virtual');
    if (!isObsVirtualCamera) {
      return;
    }

    const settings = videoTrack.getSettings();
    const currentWidth = settings.width ?? 0;
    const currentHeight = settings.height ?? 0;
    const currentFps = settings.frameRate ?? 0;
    if (
      currentWidth > 0 &&
      currentHeight > 0 &&
      currentFps > 0 &&
      currentWidth <= 1280 &&
      currentHeight <= 720 &&
      currentFps <= 30
    ) {
      return;
    }

    try {
      await videoTrack.applyConstraints({
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 }
      });
    } catch (error) {
      console.warn('Could not apply OBS virtual camera bandwidth optimization constraints', error);
    }
  }

  async loadDevices() {
    if (this.isLoadingDevices) {
      this.pendingDeviceReload = true;
      return;
    }

    this.isLoadingDevices = true;
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const needsPermissionProbe = devices.some(device =>
        (device.kind === 'audioinput' || device.kind === 'videoinput') && !device.label
      );

      if (needsPermissionProbe && !this.localStream && !this.previewStream) {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        permissionStream.getTracks().forEach(track => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }

      this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');
      this.audioOutputDevices = devices.filter(d => d.kind === 'audiooutput');

      this.selectedVideoId = resolveAvailableDeviceId(this.videoDevices, this.selectedVideoId);
      this.selectedAudioId = resolveAvailableDeviceId(this.audioDevices, this.selectedAudioId);
      this.selectedOutputId = resolveAvailableDeviceId(this.audioOutputDevices, this.selectedOutputId);
      this.mobileMediaReady = true;
      this.mobileMediaMessage = '';
      await this.applyAudioOutputToAllMedia();
    } catch (err) {
      console.warn('Media device access partially or fully denied', err);
    } finally {
      this.isLoadingDevices = false;
      if (this.pendingDeviceReload) {
        this.pendingDeviceReload = false;
        this.scheduleDeviceReload();
      }
    }
  }

  async startPreview() {
    this.resetMicTestForCaptureChange();
    if (this.previewStream) {
      this.previewStream.getTracks().forEach(t => t.stop());
      this.previewStream = null;
    }

    try {
      this.previewStream = await navigator.mediaDevices.getUserMedia(this.buildMediaConstraints());
      await this.applySelectedSourceBandwidthOptimizations(this.previewStream);
      this.applyPreviewSetupToStream();

      if (this.previewVideo) {
        this.previewVideo.nativeElement.srcObject = this.previewStream;
      }
      this.mobileMediaReady = true;
      this.syncMicInputMonitor();
      await this.applyAudioOutputToAllMedia();
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Preview failed, trying fallback', err);
      try {
        this.previewStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.applyPreviewSetupToStream();
        this.syncMicInputMonitor();
        await this.applyAudioOutputToAllMedia();
        this.cdr.detectChanges();
      } catch (fallbackErr) {
        console.error('All media access failed', fallbackErr);
      }
    }
  }

  async onDeviceChange() {
    this.persistMediaPreferences();
    if (this.isApplyingDeviceChange) {
      this.pendingDeviceChange = true;
      return;
    }

    this.isApplyingDeviceChange = true;
    try {
      do {
        this.pendingDeviceChange = false;
        if (this.localStream) {
          await this.replaceActiveMediaStream();
        } else {
          await this.startPreview();
        }
      } while (this.pendingDeviceChange);
    } finally {
      this.isApplyingDeviceChange = false;
    }
  }

  async onMicrophoneProcessingChange() {
    this.persistMediaPreferences();
    if (!this.localStream && !this.previewStream && this.isMobileBrowser && !this.mobileMediaReady) {
      return;
    }

    await this.onDeviceChange();
  }

  get selectedVideoInputRoute(): string {
    return this.selectedPcVideoSource === CALL_DEFAULT_PC_SOURCE
      ? this.getLocalInputRouteValue(this.selectedVideoId)
      : this.getCompanionInputRouteValue(this.selectedPcVideoSource);
  }

  get selectedAudioInputRoute(): string {
    return this.selectedPcAudioSource === CALL_DEFAULT_PC_SOURCE
      ? this.getLocalInputRouteValue(this.selectedAudioId)
      : this.getCompanionInputRouteValue(this.selectedPcAudioSource);
  }

  getLocalInputRouteValue(deviceId: string): string {
    return `local:${deviceId}`;
  }

  getCompanionInputRouteValue(sourceId: CompanionSourceId): string {
    return `companion:${sourceId}`;
  }

  async changeVideoInputRoute(routeValue: string) {
    if (routeValue.startsWith('companion:')) {
      await this.changePcVideoSource(routeValue.slice('companion:'.length));
      return;
    }

    this.selectedVideoId = routeValue.startsWith('local:')
      ? routeValue.slice('local:'.length)
      : routeValue;
    await this.onDeviceChange();
    if (this.selectedPcVideoSource !== CALL_DEFAULT_PC_SOURCE) {
      await this.changePcVideoSource(CALL_DEFAULT_PC_SOURCE);
    }
  }

  async changeAudioInputRoute(routeValue: string) {
    if (routeValue.startsWith('companion:')) {
      await this.changePcAudioSource(routeValue.slice('companion:'.length));
      return;
    }

    this.selectedAudioId = routeValue.startsWith('local:')
      ? routeValue.slice('local:'.length)
      : routeValue;
    await this.onDeviceChange();
    if (this.selectedPcAudioSource !== CALL_DEFAULT_PC_SOURCE) {
      await this.changePcAudioSource(CALL_DEFAULT_PC_SOURCE);
    }
  }

  get isMicTestRecording(): boolean {
    return false;
  }

  get micTestDurationSeconds(): number {
    return 0;
  }

  get micTestPlaybackUrl(): string | null {
    return null;
  }

  get micTestError(): string {
    return '';
  }

  get astralRecordingPath(): string | null {
    return null;
  }

  get hasMicTestSource(): boolean {
    return false;
  }

  get canRunMicTest(): boolean {
    return false;
  }

  get micInputLevelPercent(): number {
    return Math.round(this.micInputLevel * 100);
  }

  get micTestStatusText(): string {
    return 'Mic test disabled';
  }

  startMicTestRecording() {
    this.snackBar.open('Recording is disabled.', 'Close', { duration: 3000 });
  }

  stopMicTestRecording(discardSample: boolean = false) {
    void discardSample;
  }

  clearMicTestSample() {
    // Recording is disabled.
  }

  private getActiveMicTrack(): MediaStreamTrack | null {
    return this.localStream?.getAudioTracks()[0]
      || this.previewStream?.getAudioTracks()[0]
      || null;
  }

  private resetMicTestForCaptureChange() {
    this.stopMicInputMonitor();
  }

  get sessionRecordingStatusText(): string {
    return 'Recording disabled';
  }

  get hasRecordedSessionPlayback(): boolean {
    return false;
  }

  get canUseSessionRecording(): boolean {
    return false;
  }

  get showDmRecordingToolbar(): boolean {
    return false;
  }

  get callLivestreamStatusText(): string {
    return 'Livestream disabled';
  }

  addFakeLivestreamCaller() {
    this.snackBar.open('Livestreaming is disabled.', 'Close', { duration: 3000 });
  }

  clearFakeLivestreamCallers() {
    this.fakeLivestreamCallerCount = 0;
  }

  openLivestreamManager() {
    this.snackBar.open('Livestreaming is disabled.', 'Close', { duration: 3000 });
  }

  get canSaveAstralRecording(): boolean {
    return false;
  }

  get hasDownloadableAstralRecording(): boolean {
    return false;
  }

  get hasOptimizedAstralRecording(): boolean {
    return false;
  }

  get isAstralRecordingAwaitingOptimization(): boolean {
    return false;
  }

  get isAstralPlaybackImporting(): boolean {
    return false;
  }

  get isPlaybackVttLive(): boolean {
    return false;
  }

  get recordedSessionDurationMs(): number {
    return 0;
  }

  async startSessionRecording() {
    this.sessionRecordingError = 'Recording is disabled.';
    this.snackBar.open(this.sessionRecordingError, 'Close', { duration: 3000 });
  }

  stopSessionRecording(discardRecording: boolean = false) {
    void discardRecording;
    this.isSessionRecording = false;
  }

  private createCallLivestreamSourceSnapshot(): CallLivestreamSourceSnapshot {
    const participants = this.getCallLivestreamParticipants();

    return {
      channelId: this.channelId,
      hasLiveCall: !!this.localStream,
      isPlaybackMode: this.isCallPlaybackMode,
      theme: this.activeColors,
      temporaryAtmosphereBackground: this.activeTemporaryAtmosphereBackground,
      participants,
      music: this.getCallLivestreamMusicState(),
      isSceneMainLayoutActive: this.isCallLivestreamSceneMainLayoutActive(participants),
      broadcastOverlay: this.getActiveCallLivestreamBroadcastOverlay()
    };
  }

  private isCallLivestreamSceneMainLayoutActive(participants: CallLivestreamParticipant[]): boolean {
    return participants.some(participant => participant.isSceneMainCharacter);
  }

  private getCallLivestreamMusicState(): CallLivestreamMusicState | null {
    const playback = this.spotify.getLivestreamPlaybackState();
    if (!playback) {
      return null;
    }

    return {
      title: playback.title,
      artist: playback.artist,
      image: playback.image,
      positionMs: playback.positionMs,
      durationMs: playback.durationMs,
      paused: playback.paused,
      volumePercent: playback.volumePercent,
      audioStream: playback.audioStream,
      canCaptureAudio: playback.canCaptureAudio,
      audioStreamIsPostVolume: playback.audioStreamIsPostVolume,
      captureSource: playback.captureSource
    };
  }

  private getCallLivestreamParticipants(): CallLivestreamParticipant[] {
    const participants: CallLivestreamParticipant[] = [];
    const localStream = this.getLocalRecordingStream();

    if (this.showLocalSelfView && localStream) {
      const character = this.localDisplayCharacter;
      const name = character.name || 'You';
      participants.push({
        id: this.getLocalDisplayParticipantId() || 'local',
        name,
        race: character.race || '',
        icon: this.getLivestreamParticipantIcon(character),
        level: character.classes?.[0]?.level,
        isDungeonMaster: this.localDisplayIsDm,
        avatarLabel: this.getAvatarLabel(name),
        stream: localStream,
        videoElement: this.localVideo?.nativeElement ?? null,
        isLocal: true,
        isVideoHidden: this.isVideoOff || !this.hasVideoTrack(localStream),
        volumePercent: 100,
        isSceneMainCharacter: this.localSceneMainCharacter
      });
    }

    const remoteVideoElements = this.remoteVideos?.toArray() ?? [];
    this.remoteStreams.forEach((remote, index) => {
      const character = remote.userData;
      const name = character?.name || 'Player';
      const volumePercent = this.getLiveParticipantVolumePercent(remote);
      participants.push({
        id: remote.id,
        name,
        race: character?.race || '',
        icon: this.getLivestreamParticipantIcon(character),
        level: character?.classes?.[0]?.level,
        isDungeonMaster: character?.name === 'DM',
        avatarLabel: this.getAvatarLabel(name),
        stream: remote.stream ?? null,
        videoElement: remoteVideoElements[index]?.nativeElement ?? null,
        isLocal: false,
        isVideoHidden: !this.hasVideoTrack(remote.stream),
        volumePercent,
        isSceneMainCharacter: remote.isSceneMainCharacter
      });
    });

    participants.push(...this.getFakeCallLivestreamParticipants());

    return participants;
  }

  private getFakeCallLivestreamParticipants(): CallLivestreamParticipant[] {
    const fakeCallers = [
      { name: 'Mira Ashvale', race: 'Human Fighter', level: 5 },
      { name: 'Thorn Bramblefoot', race: 'Halfling Rogue', level: 4 },
      { name: 'Vael Stormscribe', race: 'Elf Wizard', level: 6 },
      { name: 'Borin Ironvale', race: 'Dwarf Cleric', level: 5 },
      { name: 'Nyx Underbough', race: 'Tiefling Bard', level: 4 },
      { name: 'Seraphine Dawn', race: 'Aasimar Paladin', level: 7 },
      { name: 'Korrin Reed', race: 'Half-Elf Ranger', level: 5 },
      { name: 'Old Marrow', race: 'Dungeon Master', level: 20, isDungeonMaster: true },
      { name: 'Ilyra Moonfall', race: 'Elf Druid', level: 6 },
      { name: 'Garruk Stonejaw', race: 'Orc Barbarian', level: 5 },
      { name: 'Pip Copperpot', race: 'Gnome Artificer', level: 4 },
      { name: 'Sable Vey', race: 'Changeling Warlock', level: 6 },
      { name: 'Rook Emberhand', race: 'Dragonborn Monk', level: 5 },
      { name: 'Cassia Wren', race: 'Human Sorcerer', level: 4 },
      { name: 'Fen Blackwater', race: 'Half-Orc Fighter', level: 6 },
      { name: 'Elowen Thistle', race: 'Firbolg Cleric', level: 5 }
    ];

    return fakeCallers.slice(0, this.fakeLivestreamCallerCount).map((caller, index) => ({
      id: `fake-livestream-caller-${index + 1}`,
      name: caller.name,
      race: caller.race,
      icon: null,
      level: caller.level,
      isDungeonMaster: !!caller.isDungeonMaster,
      avatarLabel: this.getAvatarLabel(caller.name),
      stream: null,
      videoElement: null,
      isLocal: false,
      isVideoHidden: true,
      volumePercent: 0,
      isSceneMainCharacter: false
    }));
  }

  private getLiveParticipantVolumePercent(remote: ParticipantStream): number {
    return this.normalizeParticipantVolume(
      this.videoService.getParticipantVolume(remote.id) ?? remote.volumePercent,
      200
    );
  }

  private getLivestreamParticipantIcon(character: ICharacter | undefined): string | null {
    if (!character) {
      return null;
    }

    return character.icon || (character._id ? `https://www.gravatar.com/avatar/${character._id}?d=identicon` : null);
  }

  private getAvatarLabel(name: string): string {
    return (name.trim().charAt(0) || '?').toUpperCase();
  }

  async saveAstralRecording(recording: SessionRecording | null = this.recordedSession) {
    void recording;
    this.snackBar.open('Recording is disabled.', 'Close', { duration: 3000 });
  }

  private async recoverAstralPackageForRecording(recording: SessionRecording | null): Promise<string | null> {
    void recording;
    return null;
  }

  private hasRecoverableAstralMedia(recording: SessionRecording | null): boolean {
    void recording;
    return false;
  }

  private getAstralMediaPaths(recording: SessionRecording): string[] {
    void recording;
    return [];
  }

  async openLocalRecordingsLibrary() {
    this.showLocalRecordingsLibrary = false;
    this.snackBar.open('Recording is disabled.', 'Close', { duration: 3000 });
  }

  closeLocalRecordingsLibrary() {
    this.showLocalRecordingsLibrary = false;
    this.localAstralRecordings = [];
    this.localUnpackedRecordings = [];
    this.localRecordingsError = '';
  }

  async refreshLocalRecordings() {
    this.isLoadingLocalRecordings = false;
    this.localAstralRecordings = [];
    this.localUnpackedRecordings = [];
    this.localRecordingsError = 'Recording is disabled.';
    this.cdr.detectChanges();
  }

  packageUnpackedRecording(recording: AstralUnpackedRecordingEntry, event?: Event) {
    void recording;
    event?.stopPropagation();
    this.snackBar.open('Recording is disabled.', 'Close', { duration: 3000 });
  }

  isPackagingUnpackedRecording(recording: AstralUnpackedRecordingEntry): boolean {
    void recording;
    return false;
  }

  optimizeLocalRecording(recording: AstralLocalRecordingEntry, event?: Event) {
    void recording;
    event?.stopPropagation();
    this.snackBar.open('Recording is disabled.', 'Close', { duration: 3000 });
  }

  isOptimizingLocalRecording(recording: AstralLocalRecordingEntry): boolean {
    void recording;
    return false;
  }

  playUnpackedRecording(recording: AstralUnpackedRecordingEntry, event?: Event) {
    void recording;
    event?.stopPropagation();
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  playLocalRecording(recording: AstralLocalRecordingEntry) {
    void recording;
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  getLocalRecordingSummary(recording: AstralLocalRecordingEntry | AstralUnpackedRecordingEntry): string {
    void recording;
    return 'Recording disabled';
  }

  private formatLocalRecordingDate(recording: AstralLocalRecordingEntry | AstralUnpackedRecordingEntry): string {
    const timestamp = recording.startedAt ? Date.parse(recording.startedAt) : recording.modifiedAtMs;
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return 'Unknown date';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(timestamp));
  }

  private formatFileSize(size: number): string {
    if (!Number.isFinite(size) || size <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  private promptAstralPlaybackRequest(request: AstralPlaybackDropRequest) {
    void request;
    this.clearAstralPlaybackPrompt();
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  private handleAstralPlaybackRequest(request: AstralPlaybackDropRequest) {
    void request;
    this.clearAstralPlaybackPrompt();
  }

  private handlePendingAstralPlaybackRequest() {
    this.clearAstralPlaybackPrompt();
  }

  cancelAstralPlaybackPrompt() {
    this.clearAstralPlaybackPrompt();
  }

  confirmAstralPlaybackPrompt() {
    this.clearAstralPlaybackPrompt();
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  private clearAstralPlaybackPrompt() {
    this.pendingAstralPlaybackRequest = null;
    this.pendingAstralPlaybackFilename = '';
    this.pendingAstralPlaybackRequiresDisconnect = false;
  }

  private hasActiveLiveCallConnection(): boolean {
    return !this.isCallPlaybackMode &&
      this.videoService.currentChannelId === this.channelId &&
      !!this.videoService.getLocalStream();
  }

  private async disconnectAndPlayAstralRequest(request: AstralPlaybackDropRequest) {
    void request;
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  private async importAndPlayAstralRequest(request: AstralPlaybackDropRequest) {
    void request;
    this.isImportingAstralPlayback = false;
    this.sessionRecordingError = 'Recording playback is disabled.';
    this.snackBar.open(this.sessionRecordingError, 'Close', { duration: 3000 });
    this.cdr.detectChanges();
  }

  private async createSessionRecordingFromAstralImport(imported: AstralRecordingImportResponse): Promise<SessionRecording> {
    const manifest = imported.manifest ?? {};
    const sourceRecording = manifest.recording ?? manifest;
    const participantMedia = await this.createImportedAstralParticipantMedia(imported, sourceRecording.participantMedia);
    const durationMs = getImportedRecordingDurationMs(sourceRecording, participantMedia);
    const packagePath = typeof imported.packagePath === 'string' ? imported.packagePath : '';
    const recordingPackage = !imported.remoteMediaUrlTemplate && packagePath.toLowerCase().endsWith('.astral')
      ? {
          storage: 'astral' as const,
          path: packagePath,
          size: imported.packageSize,
          formatVersion: Number(manifest.formatVersion) || 1,
          createdAt: manifest.packagedAt ?? new Date().toISOString()
        }
      : null;

    return {
      id: `${sourceRecording.id || 'astral-recording'}:${imported.sessionId}`,
      callRoomId: sourceRecording.callRoomId ?? null,
      startedAt: sourceRecording.startedAt ?? manifest.packagedAt ?? new Date().toISOString(),
      endedAt: sourceRecording.endedAt ?? null,
      durationMs,
      media: await this.createImportedAstralMedia(imported, sourceRecording.media),
      participantMedia,
      package: recordingPackage,
      vtt: {
        roomId: sourceRecording.vtt?.roomId ?? sourceRecording.callRoomId ?? null,
        initialState: sourceRecording.vtt?.initialState ?? null,
        actions: Array.isArray(sourceRecording.vtt?.actions) ? sourceRecording.vtt.actions : []
      },
      callEnvironment: {
        initialState: sourceRecording.callEnvironment?.initialState ?? null,
        events: Array.isArray(sourceRecording.callEnvironment?.events) ? sourceRecording.callEnvironment.events : []
      }
    };
  }

  private async createImportedAstralParticipantMedia(
    imported: AstralRecordingImportResponse,
    participantMedia: any
  ): Promise<SessionRecordingParticipantMedia[]> {
    if (!Array.isArray(participantMedia)) {
      return [];
    }

    const participants = await Promise.all(participantMedia.map(async participant => {
      const media = await this.createImportedAstralMedia(imported, participant?.media);
      if (!participant?.participantId || !media) {
        return null;
      }

      const startedAtMs = toFiniteRecordingNumber(participant.startedAtMs, 0);
      const endedAtMs = toFiniteRecordingNumber(participant.endedAtMs, startedAtMs + media.durationMs);
      return {
        participantId: String(participant.participantId),
        isLocal: !!participant.isLocal,
        userData: participant.userData ?? null,
        participantMeta: participant.participantMeta ?? null,
        volumePercent: normalizeParticipantPlaybackVolume(participant.volumePercent),
        startedAtMs,
        endedAtMs: Math.max(startedAtMs, endedAtMs),
        media
      } satisfies SessionRecordingParticipantMedia;
    }));

    return participants.filter((participant): participant is SessionRecordingParticipantMedia => !!participant);
  }

  private async createImportedAstralMedia(
    imported: AstralRecordingImportResponse,
    mediaManifest: any
  ): Promise<SessionRecordingMedia | null> {
    if (!mediaManifest) {
      return null;
    }

    const mimeType = mediaManifest.mimeType || 'video/webm';
    const mediaPath = this.astralRecording.resolveImportedMediaPath(imported, mediaManifest.path);
    if (!mediaPath) {
      return null;
    }

    return {
      blob: null,
      storage: 'astral',
      mimeType,
      url: await this.astralRecording.getImportedFileUrl(imported, mediaPath, mimeType),
      durationMs: toFiniteRecordingNumber(mediaManifest.durationMs, 0),
      size: toFiniteRecordingNumber(mediaManifest.size, 0),
      path: mediaPath
    };
  }

  startSessionPlayback(recording: SessionRecording | null = this.recordedSession) {
    void recording;
    this.sessionRecordingError = 'Recording playback is disabled.';
    this.snackBar.open(this.sessionRecordingError, 'Close', { duration: 3000 });
  }

  private clearSpotifyPlaybackForSessionStart() {
    this.playbackSpotifyState = null;
    this.playbackSpotifyBaseState = null;
    this.playbackSpotifyRecordedAtMs = 0;
    this.lastAppliedPlaybackSpotifySignature = '';
    void this.spotify.clearCurrentPlayback(true);
  }

  stopSessionPlayback() {
    this.isCallPlaybackMode = false;
    this.callPlaybackPaused = true;
    this.cleanupCallPlaybackSources();
  }

  onCallPlaybackEnded() {
    this.stopSessionPlayback();
  }

  openSessionPlaybackVtt(recording: SessionRecording | null = this.recordedSession) {
    void recording;
    this.snackBar.open('Recording playback is disabled.', 'Close', { duration: 3000 });
  }

  private hasRecordedVttTimeline(recording: SessionRecording | null | undefined): boolean {
    return !!recording?.vtt?.initialState || !!recording?.vtt?.actions?.length;
  }

  formatSessionRecordingDuration(durationMs: number | null | undefined): string {
    const totalSeconds = Math.max(0, Math.floor((durationMs ?? 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private applyCallPlaybackState(state: SessionPlaybackState) {
    const nextPlaybackMode = state.active && hasPlayableCallRecording(state.recording);
    const wasCallPlaybackMode = this.isCallPlaybackMode;
    const wasPlaybackPaused = this.callPlaybackPaused;

    if (nextPlaybackMode && !this.isCallPlaybackMode) {
      this.callEnvironmentBeforePlayback = this.createCallEnvironmentState();
    }

    if (!nextPlaybackMode && this.isCallPlaybackMode) {
      this.closeActivePlaybackVtt();
      try {
        this.isRestoringCallPlaybackEnvironment = true;
        this.restoreCallEnvironmentAfterPlayback();
      } finally {
        this.isRestoringCallPlaybackEnvironment = false;
      }
      this.resetCallPlaybackEnvironmentTimeline();
      this.cleanupCallPlaybackSources();
    }

    this.isCallPlaybackMode = nextPlaybackMode;
    this.callPlaybackPaused = state.paused;
    this.callPlaybackCurrentTimeMs = state.currentTimeMs;
    this.callPlaybackDurationMs = state.durationMs;
    this.syncSoundCloudHostSyncTimer();

    if (nextPlaybackMode) {
      this.prepareCallPlaybackSources(state.recording!);
      this.syncCallPlaybackSourcesToState(state);
      this.applyCallPlaybackEnvironment(state);
      if (wasCallPlaybackMode && wasPlaybackPaused !== state.paused) {
        this.syncRecordedSpotifyPlaybackForTime(state.currentTimeMs, true);
      }
    }

    this.cdr.detectChanges();
    setTimeout(() => this.bindVisibleRemoteVideos());
  }

  private applyCallPlaybackEnvironment(state: SessionPlaybackState) {
    const recording = state.recording;
    if (!recording) {
      return;
    }

    if (this.shouldResetCallPlaybackEnvironment(recording, state.currentTimeMs)) {
      this.resetCallPlaybackEnvironment(recording, state.currentTimeMs);
    }

    const events = recording.callEnvironment?.events ?? [];
    while (
      this.callPlaybackEnvironmentEventIndex < events.length &&
      events[this.callPlaybackEnvironmentEventIndex].timeMs <= state.currentTimeMs
    ) {
      this.applyCallEnvironmentEvent(events[this.callPlaybackEnvironmentEventIndex]);
      this.callPlaybackEnvironmentEventIndex += 1;
    }

    this.callPlaybackLastTimeMs = state.currentTimeMs;
  }

  private shouldResetCallPlaybackEnvironment(recording: SessionRecording, currentTimeMs: number): boolean {
    const elapsedSinceLastStateMs = currentTimeMs - this.callPlaybackLastTimeMs;
    return this.forceCallPlaybackEnvironmentReset ||
      this.callPlaybackRecordingId !== recording.id ||
      currentTimeMs < this.callPlaybackLastTimeMs ||
      elapsedSinceLastStateMs > this.callPlaybackEnvironmentSeekResetThresholdMs;
  }

  private resetCallPlaybackEnvironment(recording: SessionRecording, currentTimeMs: number = 0) {
    this.callPlaybackRecordingId = recording.id;
    this.callPlaybackEnvironmentEventIndex = 0;
    this.callPlaybackLastTimeMs = 0;
    this.forceCallPlaybackEnvironmentReset = false;
    this.callPlaybackParticipantSnapshots.clear();

    const initialState = recording.callEnvironment?.initialState as RecordedCallEnvironmentState | null;
    if (initialState) {
      this.applyCallEnvironmentState(initialState, currentTimeMs);
    }
  }

  private resetCallPlaybackEnvironmentTimeline() {
    this.callPlaybackRecordingId = null;
    this.callPlaybackEnvironmentEventIndex = 0;
    this.callPlaybackLastTimeMs = 0;
    this.forceCallPlaybackEnvironmentReset = false;
  }

  private restoreCallEnvironmentAfterPlayback() {
    if (!this.callEnvironmentBeforePlayback) {
      return;
    }

    this.applyCallEnvironmentState(this.callEnvironmentBeforePlayback);
    this.callEnvironmentBeforePlayback = null;
  }

  private applyCallEnvironmentEvent(event: RecordedCallEnvironmentEvent) {
    const data = event.data;
    this.isApplyingCallPlaybackEnvironment = true;
    try {
      switch (event.action) {
        case 'theme-sync':
          this.applyRecordedTheme(data);
          this.activateCallLivestreamBroadcastOverlay({
            type: 'theme',
            title: 'Atmosphere Broadcast',
            text: 'Atmosphere updated',
            image: data?.backgroundImage ?? null
          });
          break;
        case 'overlay-image':
          this.activeOverlayImage = data?.url ?? data ?? null;
          if (this.activeOverlayImage) {
            this.activateCallLivestreamBroadcastOverlay({
              type: 'image',
              title: 'Image Broadcast',
              text: null,
              image: this.activeOverlayImage
            });
          } else {
            this.clearCallLivestreamBroadcastOverlay('image');
          }
          if (this.activeOverlayImage) {
            this.activeOverlayText = null;
          }
          break;
        case 'overlay-text':
          this.activeOverlayText = data?.text ?? data ?? null;
          if (this.activeOverlayText?.trim()) {
            this.activateCallLivestreamBroadcastOverlay({
              type: 'text',
              title: 'Text Broadcast',
              text: this.activeOverlayText.trim(),
              image: null
            });
          } else {
            this.clearCallLivestreamBroadcastOverlay('text');
          }
          if (this.activeOverlayText) {
            this.activeOverlayImage = null;
          }
          break;
        case 'temporary-atmosphere-background':
          this.activeTemporaryAtmosphereBackground = data?.url ?? data ?? null;
          if (this.activeTemporaryAtmosphereBackground) {
            this.activateCallLivestreamBroadcastOverlay({
              type: 'atmosphere',
              title: 'Atmosphere Broadcast',
              text: 'Temporary atmosphere updated',
              image: this.activeTemporaryAtmosphereBackground
            });
          } else {
            this.clearCallLivestreamBroadcastOverlay('atmosphere');
          }
          this.applyTemporaryAtmosphereBackground(this.activeTemporaryAtmosphereBackground);
          break;
        case 'scene-main-characters':
          this.sceneMainCharacterIds = Array.isArray(data?.participantIds)
            ? [...data.participantIds]
            : Array.isArray(data)
              ? [...data]
              : [];
          this.refreshSceneMainCharacterFlags();
          break;
        case 'dm-mode':
          this.isDmMode = !!data?.enabled;
          if (data?.character) {
            this.dmCharacter = { ...this.dmCharacter, ...data.character };
          }
          break;
        case 'participants':
          this.setCallPlaybackParticipantSnapshots(data);
          this.refreshCallPlaybackParticipantStreams(this.callPlaybackCurrentTimeMs);
          break;
        case 'vtt-session':
          this.applyRecordedVttSession(data);
          break;
        case 'music-action':
          this.applyRecordedMusicAction(data, event.timeMs, this.callPlaybackCurrentTimeMs);
          break;
        case 'spotify-state':
          this.applyRecordedSpotifyState(data, event.timeMs, this.callPlaybackCurrentTimeMs);
          break;
        case 'spotify-requests':
          this.spotifyRequests = cloneSpotifyRequests(data);
          break;
      }
    } finally {
      this.isApplyingCallPlaybackEnvironment = false;
    }
  }

  private applyCallEnvironmentState(state: RecordedCallEnvironmentState, playbackTimeMs: number = this.callPlaybackCurrentTimeMs) {
    this.isApplyingCallPlaybackEnvironment = true;
    try {
      this.applyRecordedTheme(state.activeColors);
      this.activeOverlayImage = state.activeOverlayImage ?? null;
      this.activeOverlayText = state.activeOverlayText ?? null;
      this.activeTemporaryAtmosphereBackground = state.activeTemporaryAtmosphereBackground ?? null;
      this.sceneMainCharacterIds = Array.isArray(state.sceneMainCharacterIds)
        ? [...state.sceneMainCharacterIds]
        : [];
      this.isDmMode = !!state.isDmMode;
      this.applyRecordedVttSession(state.vttSession);
      this.applyRecordedSpotifyState(state.spotify, 0, playbackTimeMs);
      this.spotifyRequests = cloneSpotifyRequests(state.spotifyRequests);
      this.setCallPlaybackParticipantSnapshots(state.participants);
      this.refreshSceneMainCharacterFlags();
      this.applyTemporaryAtmosphereBackground(this.activeTemporaryAtmosphereBackground);
    } finally {
      this.isApplyingCallPlaybackEnvironment = false;
    }
  }

  private applyRecordedTheme(colors: ThemeColors | null | undefined) {
    if (!colors) {
      return;
    }

    this.activeColors = colors;
    this.rememberValidThemeBackground(colors);
    this.themeService.applyTheme(colors, false);
  }

  private createRecordedVttSessionState(
    session: Partial<VttSessionState> | null | undefined,
    previousSession: Partial<VttSessionState> | null | undefined
  ): VttSessionState {
    const active = !!session?.active;
    const roomId = session?.roomId ?? previousSession?.roomId ?? (active ? this.getVttRoomId() : null);

    return {
      active,
      roomId,
      hostId: active
        ? session?.hostId ?? previousSession?.hostId ?? null
        : null
    };
  }

  private applyRecordedVttSession(session: Partial<VttSessionState> | null | undefined) {
    const normalizedSession = session
      ? this.createRecordedVttSessionState(session, { active: false, roomId: null, hostId: null })
      : { active: false, roomId: null, hostId: null };
    this.vttSession = normalizedSession;
    this.syncPlaybackVttSession(normalizedSession);
  }

  private syncPlaybackVttSession(session: VttSessionState) {
    if (!this.isCallPlaybackMode || this.isRestoringCallPlaybackEnvironment) {
      return;
    }

    if (session.active && session.roomId) {
      if (this.activePlaybackVttRoomId && this.activePlaybackVttRoomId !== session.roomId) {
        this.playbackVtt.emit({ roomId: this.activePlaybackVttRoomId, active: false });
      }

      this.activePlaybackVttRoomId = session.roomId;
      this.playbackVtt.emit({ roomId: session.roomId, active: true });
      return;
    }

    this.closeActivePlaybackVtt(session.roomId ?? undefined);
  }

  private closeActivePlaybackVtt(roomId: string | undefined = this.activePlaybackVttRoomId ?? undefined) {
    const closeRoomId = roomId ?? this.activePlaybackVttRoomId;
    if (!closeRoomId) {
      return;
    }

    this.playbackVtt.emit({ roomId: closeRoomId, active: false });
    if (this.activePlaybackVttRoomId === closeRoomId || !roomId) {
      this.activePlaybackVttRoomId = null;
    }
  }

  private createRecordedSpotifyStateFromCurrent(): RecordedSpotifyState | null {
    return createRecordedSpotifyStateFromCurrent(
      this.spotify.currentTrack$.value,
      this.spotify.isPaused$.value,
      this.spotify.shuffleState$.value,
      this.getCurrentSpotifyVolumePercent(),
      this.spotify.playbackPositionMs$.value
    );
  }

  private createRecordedSpotifyStateFromSyncPayload(payload: any): RecordedSpotifyState | null {
    return createRecordedSpotifyStateFromSyncPayload(
      payload,
      this.spotify.currentTrack$.value,
      this.spotify.isPaused$.value,
      this.getCurrentSpotifyVolumePercent()
    );
  }

  private applyRecordedMusicAction(
    actionEvent: any,
    recordedAtMs: number = this.callPlaybackCurrentTimeMs,
    playbackTimeMs: number = this.callPlaybackCurrentTimeMs
  ) {
    const recordedState = actionEvent?.state
      ?? this.createRecordedSpotifyStateFromSyncPayload(actionEvent?.data ?? actionEvent);
    if (recordedState) {
      this.applyRecordedSpotifyState(recordedState, recordedAtMs, playbackTimeMs);
      return;
    }

    if (actionEvent?.command === 'volume' && Number.isFinite(Number(actionEvent?.data?.volumePercent))) {
      this.setPlaybackSpotifyVolume(actionEvent.data.volumePercent);
    }
  }

  private applyRecordedSpotifyState(
    state: Partial<RecordedSpotifyState> | null | undefined,
    recordedAtMs: number = this.callPlaybackCurrentTimeMs,
    playbackTimeMs: number = this.callPlaybackCurrentTimeMs
  ) {
    if (!state?.uri) {
      this.playbackSpotifyState = null;
      this.playbackSpotifyBaseState = null;
      this.playbackSpotifyRecordedAtMs = 0;
      this.lastAppliedPlaybackSpotifySignature = '';
      if (this.isCallPlaybackMode && !this.isRestoringCallPlaybackEnvironment) {
        void this.spotify.clearCurrentPlayback(true);
      }
      return;
    }

    this.playbackSpotifyBaseState = createRecordedSpotifyState(
      state,
      this.getCurrentSpotifyVolumePercent()
    );
    this.playbackSpotifyRecordedAtMs = Math.max(0, Number(recordedAtMs) || 0);
    this.syncRecordedSpotifyPlaybackForTime(playbackTimeMs);
  }

  private syncRecordedSpotifyPlaybackForTime(playbackTimeMs: number, force: boolean = false) {
    if (!this.playbackSpotifyBaseState) {
      return;
    }

    this.playbackSpotifyState = {
      ...this.playbackSpotifyBaseState,
      position: this.getRecordedSpotifyPositionAtPlaybackTime(
        this.playbackSpotifyBaseState,
        this.playbackSpotifyRecordedAtMs,
        playbackTimeMs
      )
    };
    this.playbackSpotifyVolumePercent = this.playbackSpotifyState.volumePercent;
    if (force) {
      this.lastAppliedPlaybackSpotifySignature = '';
    }
    this.syncSpotifyPlayerToPlaybackState(this.playbackSpotifyState);
  }

  private getRecordedSpotifyPositionAtPlaybackTime(
    state: RecordedSpotifyState,
    recordedAtMs: number,
    playbackTimeMs: number
  ): number {
    const basePositionMs = Math.max(0, Number(state.position) || 0);
    if (state.paused || !state.playing) {
      return basePositionMs;
    }

    return Math.max(0, Math.round(basePositionMs + Math.max(0, playbackTimeMs - recordedAtMs)));
  }

  private getCurrentSpotifyVolumePercent(): number {
    return normalizeSpotifyVolume(this.spotify.getVolumePercent());
  }

  setPlaybackSpotifyVolume(value: number | string) {
    const volumePercent = normalizeSpotifyVolume(value);
    this.playbackSpotifyVolumePercent = volumePercent;
    if (this.playbackSpotifyState) {
      this.playbackSpotifyState = {
        ...this.playbackSpotifyState,
        volumePercent
      };
    }
    if (this.playbackSpotifyBaseState) {
      this.playbackSpotifyBaseState = {
        ...this.playbackSpotifyBaseState,
        volumePercent
      };
    }
    void this.spotify.setVolumePercent(volumePercent, true);
  }

  setSoundCloudVolume(value: number | string) {
    const volumePercent = this.normalizeSoundCloudVolumePercent(value);
    this.soundCloudVolumePercent = volumePercent;
    void this.spotify.setVolumePercent(volumePercent);
  }

  adjustSoundCloudVolume(delta: number) {
    this.setSoundCloudVolume(this.soundCloudVolumePercent + delta);
  }

  getSoundCloudVolumeIcon(): string {
    if (this.soundCloudVolumePercent <= 0) return 'volume_off';
    if (this.soundCloudVolumePercent < 50) return 'volume_down';
    return 'volume_up';
  }

  private normalizeSoundCloudVolumePercent(value: number | string): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return this.soundCloudVolumePercent;
    }

    return Math.max(0, Math.min(100, Math.round(numericValue)));
  }

  private syncSpotifyPlayerToPlaybackState(state: RecordedSpotifyState) {
    if (!this.isCallPlaybackMode || this.isRestoringCallPlaybackEnvironment || !state.uri) {
      return;
    }

    const shouldPlay = state.playing && !this.callPlaybackPaused && !this.isCallPlaybackBuffering;
    const signature = [
      state.uri,
      shouldPlay ? 'playing' : 'paused',
      Math.round(state.position / 250),
      state.contextUri ?? '',
      state.volumePercent
    ].join('|');
    if (signature === this.lastAppliedPlaybackSpotifySignature) {
      return;
    }

    this.lastAppliedPlaybackSpotifySignature = signature;
    void this.spotify.setVolumePercent(state.volumePercent, true);
    const metadata = {
      name: state.name,
      artist: state.artist,
      image: state.image
    };
    if (shouldPlay) {
      void this.spotify.play(state.uri, state.position, true, state.contextUri ?? undefined, metadata);
      return;
    }

    void this.spotify.play(state.uri, state.position, true, state.contextUri ?? undefined, metadata)
      .then(() => this.spotify.pause(true))
      .catch(() => undefined);
  }

  private recordSpotifyRequestsSnapshot() {
    this.recordCallEnvironmentEvent('spotify-requests', cloneSpotifyRequests(this.spotifyRequests));
  }

  private recordMusicAction(
    command: string | null | undefined,
    data: any,
    source: string | null | undefined = 'manual',
    state: RecordedSpotifyState | null = null
  ) {
    if (!command) {
      return;
    }

    this.recordCallEnvironmentEvent('music-action', {
      command,
      source: source ?? 'manual',
      data,
      state
    });
  }

  private async recordCurrentSpotifyPlaybackState() {
    return;
  }

  private recordCurrentCallEnvironmentInitialState() {
    this.lastRecordedCallParticipantsSnapshot = '';
  }

  private recordCallEnvironmentEvent(action: RecordedCallEnvironmentAction, data: any) {
    void action;
    void data;
  }

  private recordCallParticipantsSnapshotIfChanged() {
    return;
  }

  private createCallEnvironmentState(): RecordedCallEnvironmentState {
    return {
      activeColors: this.activeColors,
      activeOverlayImage: this.activeOverlayImage,
      activeOverlayText: this.activeOverlayText,
      activeTemporaryAtmosphereBackground: this.activeTemporaryAtmosphereBackground,
      sceneMainCharacterIds: [...this.sceneMainCharacterIds],
      isDmMode: this.isDmMode,
      vttSession: this.createRecordedVttSessionState(this.vttSession, this.vttSession),
      spotify: this.createRecordedSpotifyStateFromCurrent(),
      spotifyRequests: cloneSpotifyRequests(this.spotifyRequests),
      participants: this.createCallParticipantSnapshots()
    };
  }

  private createCallParticipantSnapshots(): RecordedCallParticipantSnapshot[] {
    const localParticipant = this.getLocalContextMenuParticipant();
    const snapshots: RecordedCallParticipantSnapshot[] = [];
    if (localParticipant) {
      snapshots.push(this.createCallParticipantSnapshot(localParticipant));
    }

    this.remoteStreams.forEach(remote => snapshots.push(this.createCallParticipantSnapshot(remote)));
    return snapshots;
  }

  private createCallParticipantSnapshot(participant: ParticipantStream): RecordedCallParticipantSnapshot {
    return {
      id: participant.id,
      isLocal: !!participant.isLocal,
      userData: createCharacterSnapshot(participant.userData),
      participantMeta: participant.participantMeta ?? null,
      ping: participant.ping,
      volumePercent: participant.volumePercent,
      isSceneMainCharacter: participant.isSceneMainCharacter,
      hasAudio: !!participant.stream?.getAudioTracks().length,
      hasVideo: !!participant.stream?.getVideoTracks().length
    };
  }

  private getCallParticipantsSnapshotSignature(snapshot: RecordedCallParticipantSnapshot[]): string {
    return JSON.stringify(snapshot);
  }

  private setCallPlaybackParticipantSnapshots(snapshots: RecordedCallParticipantSnapshot[] | null | undefined) {
    if (!Array.isArray(snapshots)) {
      return;
    }

    snapshots.forEach(snapshot => {
      if (snapshot?.id) {
        this.callPlaybackParticipantSnapshots.set(snapshot.id, snapshot);
      }
    });
  }

  private getCallRecordingParticipantsForStreams(): CallRecordingParticipant[] {
    const localIdentity = this.videoService.getCurrentParticipantIdentity() ?? 'local';
    const participants: CallRecordingParticipant[] = [];
    const localRecordingStream = this.getLocalRecordingStream();

    if (localRecordingStream) {
      participants.push({
        id: localIdentity,
        stream: localRecordingStream,
        userData: this.isDmMode ? this.dmCharacter : this.character,
        participantMeta: this.videoService.getCurrentParticipantMetadata(),
        isLocal: true,
        volumePercent: 100
      });
    }

    this.remoteStreams.forEach(remote => {
      participants.push({
        id: remote.id,
        stream: remote.stream,
        userData: remote.userData,
        participantMeta: remote.participantMeta,
        isLocal: false,
        volumePercent: remote.volumePercent
      });
    });

    return participants;
  }

  private getLocalRecordingStream(): MediaStream | null {
    const displayStream = this.getCompanionLocalStream(this.videoService.remoteStreams$.value) || this.localStream;
    const audioStream = this.videoService.getSelectedCompanionAudioStream() || this.localStream;
    const tracks: MediaStreamTrack[] = [];
    displayStream?.getVideoTracks()
      .filter(track => track.readyState === 'live')
      .forEach(track => tracks.push(track));
    audioStream?.getAudioTracks()
      .filter(track => track.readyState === 'live')
      .forEach(track => tracks.push(track));

    return tracks.length ? new MediaStream(tracks) : null;
  }

  private prepareCallPlaybackSources(recording: SessionRecording) {
    if (this.callPlaybackSourcesRecordingId === recording.id) {
      return;
    }

    this.cleanupCallPlaybackSources();
    this.callPlaybackSourcesRecordingId = recording.id;
    const host = document.createElement('div');
    host.className = 'call-playback-media-host';
    Object.assign(host.style, {
      position: 'fixed',
      width: '320px',
      height: '180px',
      overflow: 'hidden',
      opacity: '0.01',
      pointerEvents: 'none',
      left: '0',
      top: '0',
      zIndex: '-1'
    });
    document.body.appendChild(host);
    this.callPlaybackMediaHost = host;

    (recording.participantMedia ?? []).forEach(participant => {
      const isStillFrame = this.isStillFrameMedia(participant.media);
      const video = document.createElement('video');
      video.playsInline = true;
      video.preload = 'none';
      video.volume = Math.min(1, Math.max(0, participant.volumePercent / 100));
      if (!isStillFrame) {
        host.appendChild(video);
        void this.applyAudioOutputToMediaElement(video);
      }

      const source: CallPlaybackSource = {
        participant,
        video,
        stream: null,
        streamCaptureBlocked: false,
        cleanup: [],
        active: false,
        ended: false,
        sourceAttached: isStillFrame,
        sourceAttachFailedAt: 0
      };
      if (!isStillFrame) {
        this.bindPlaybackSourceVideoReadiness(source);
      }
      this.callPlaybackSources.push(source);
    });

    this.refreshCallPlaybackParticipantStreams(0);
  }

  private capturePlaybackVideoStream(video: HTMLVideoElement): MediaStream | null {
    if (video.dataset['playbackCaptureBlocked'] === '1') {
      return null;
    }

    const captureVideo = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    if (!captureVideo.captureStream && !captureVideo.mozCaptureStream) {
      video.dataset['playbackCaptureBlocked'] = '1';
      return null;
    }

    try {
      return captureVideo.captureStream?.() ?? captureVideo.mozCaptureStream?.() ?? null;
    } catch (error) {
      video.dataset['playbackCaptureBlocked'] = '1';
      if ((error as Error | DOMException)?.name !== 'SecurityError') {
        console.warn('Could not capture playback media stream', error);
      }
      return null;
    }
  }

  private bindPlaybackSourceVideoReadiness(source: CallPlaybackSource) {
    const refreshSourceStream = () => {
      if (this.updatePlaybackSourceStream(source)) {
        this.refreshCallPlaybackParticipantStreams(this.callPlaybackCurrentTimeMs);
        setTimeout(() => this.bindVisibleRemoteVideos());
      }
    };

    ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'resize', 'seeked'].forEach(eventName => {
      source.video.addEventListener(eventName, refreshSourceStream);
      source.cleanup.push(() => source.video.removeEventListener(eventName, refreshSourceStream));
    });

    const markSourceEnded = () => {
      source.ended = true;
    };
    source.video.addEventListener('ended', markSourceEnded);
    source.cleanup.push(() => source.video.removeEventListener('ended', markSourceEnded));

    const markSourceLoadFailed = () => {
      if (!source.sourceAttached) {
        return;
      }

      source.sourceAttachFailedAt = Date.now();
      this.detachPlaybackSourceMedia(source);
    };
    source.video.addEventListener('error', markSourceLoadFailed);
    source.cleanup.push(() => source.video.removeEventListener('error', markSourceLoadFailed));

    const refreshInterval = window.setInterval(refreshSourceStream, 250);
    const refreshTimeout = window.setTimeout(() => window.clearInterval(refreshInterval), 4000);
    source.cleanup.push(() => {
      window.clearInterval(refreshInterval);
      window.clearTimeout(refreshTimeout);
    });
  }

  private updatePlaybackSourceStream(source: CallPlaybackSource): boolean {
    if (source.streamCaptureBlocked) {
      return false;
    }

    const nextStream = this.capturePlaybackVideoStream(source.video);
    if (source.video.dataset['playbackCaptureBlocked'] === '1') {
      source.streamCaptureBlocked = true;
    }
    if (!nextStream) {
      return false;
    }

    if (!source.stream) {
      source.stream = nextStream;
      return true;
    }

    if (source.stream === nextStream || !this.shouldReplacePlaybackSourceStream(source.stream, nextStream)) {
      return false;
    }

    source.stream = nextStream;
    return true;
  }

  private shouldReplacePlaybackSourceStream(currentStream: MediaStream, nextStream: MediaStream): boolean {
    const currentTracks = currentStream.getTracks();
    const nextTracks = nextStream.getTracks();
    if (hasSameTrackSet(currentTracks, nextTracks)) {
      return false;
    }

    const currentLiveTrackCount = currentTracks.filter(track => track.readyState === 'live').length;
    const nextLiveTrackCount = nextTracks.filter(track => track.readyState === 'live').length;
    if (currentLiveTrackCount === 0 && nextLiveTrackCount > 0) {
      return true;
    }

    return !this.hasVideoTrack(currentStream) && this.hasVideoTrack(nextStream);
  }

  private ensurePlaybackSourceMediaAttached(source: CallPlaybackSource): boolean {
    if (this.hasStillFrameMedia(source)) {
      return true;
    }

    if (source.sourceAttached && source.video.src) {
      return true;
    }

    if (Date.now() - source.sourceAttachFailedAt < this.callPlaybackAttachRetryMs) {
      return false;
    }

    const sourceUrl = source.participant.media.url;
    if (!sourceUrl) {
      return false;
    }

    source.video.playsInline = true;
    source.video.preload = 'metadata';
    source.video.src = sourceUrl;
    source.sourceAttached = true;
    source.sourceAttachFailedAt = 0;
    if (this.callPlaybackMediaHost && !source.video.parentElement) {
      this.callPlaybackMediaHost.appendChild(source.video);
    }
    void this.applyAudioOutputToMediaElement(source.video);
    source.video.load();

    if (!source.streamCaptureBlocked) {
      const nextStream = this.capturePlaybackVideoStream(source.video);
      if (source.video.dataset['playbackCaptureBlocked'] === '1') {
        source.streamCaptureBlocked = true;
      }
      if (nextStream) {
        source.stream = nextStream;
      }
    }
    return true;
  }

  private detachPlaybackSourceMedia(source: CallPlaybackSource) {
    if (this.hasStillFrameMedia(source) || !source.sourceAttached) {
      return;
    }

    source.video.pause();
    source.video.removeAttribute('src');
    source.video.load();
    source.stream = null;
    source.sourceAttached = false;
  }

  private shouldPreloadPlaybackSource(source: CallPlaybackSource, currentTimeMs: number): boolean {
    return currentTimeMs >= source.participant.startedAtMs - this.callPlaybackPreloadWindowMs &&
      currentTimeMs <= source.participant.endedAtMs + 1000;
  }

  private shouldReleasePlaybackSource(source: CallPlaybackSource, currentTimeMs: number): boolean {
    return currentTimeMs < source.participant.startedAtMs - this.callPlaybackPreloadWindowMs ||
      currentTimeMs > source.participant.endedAtMs + this.callPlaybackReleaseWindowMs;
  }

  private preloadUpcomingPlaybackSources(currentTimeMs: number) {
    this.callPlaybackSources
      .filter(source => !this.hasStillFrameMedia(source) && this.shouldPreloadPlaybackSource(source, currentTimeMs))
      .forEach(source => this.ensurePlaybackSourceMediaAttached(source));
  }

  private cleanupCallPlaybackSources() {
    this.stopCallPlaybackSyncTimer();
    Array.from(this.visiblePlaybackSourceTargets.values()).forEach(video => this.detachVisiblePlaybackSourceVideo(video));
    this.visiblePlaybackSourceTargets.clear();
    this.callPlaybackSources.forEach(source => {
      source.cleanup.forEach(cleanup => cleanup());
      source.video.pause();
      source.video.removeAttribute('src');
      source.video.load();
      source.video.remove();
    });
    this.callPlaybackSources = [];
    this.playbackLocalParticipantStream = null;
    this.playbackParticipantStreams = [];
    this.callPlaybackSourcesRecordingId = null;
    this.callPlaybackParticipantSnapshots.clear();
    this.callPlaybackPaused = true;
    this.isCallPlaybackBuffering = false;
    this.callPlaybackCurrentTimeMs = 0;
    this.callPlaybackDurationMs = 0;
    this.callPlaybackClockStartedAtMs = 0;
    this.callPlaybackClockStartTimeMs = 0;
    this.callPlaybackBufferTimeMs = 0;
    this.visiblePlaybackSyncToken = 0;
    this.activePlaybackVttRoomId = null;
    this.playbackSpotifyState = null;
    this.playbackSpotifyBaseState = null;
    this.playbackSpotifyRecordedAtMs = 0;
    this.playbackSpotifyVolumePercent = this.getCurrentSpotifyVolumePercent();
    this.lastAppliedPlaybackSpotifySignature = '';
    this.callPlaybackMediaHost?.remove();
    this.callPlaybackMediaHost = null;
  }

  private syncCallPlaybackSourcesToState(state: SessionPlaybackState) {
    if (!state.recording || !this.callPlaybackSources.length) {
      return;
    }

    this.refreshCallPlaybackParticipantStreams(state.currentTimeMs);
    if (state.paused) {
      this.pauseCallPlaybackSources();
    } else if (this.isCallPlaybackBuffering) {
      this.continueCallPlaybackBuffering();
    } else {
      this.playCallPlaybackSources();
    }
  }

  private seekCallPlaybackSources(currentTimeMs: number) {
    this.isSeekingCallPlaybackSources = true;
    this.isCallPlaybackBuffering = false;
    this.callPlaybackBufferTimeMs = 0;
    this.callPlaybackCurrentTimeMs = currentTimeMs;
    this.visiblePlaybackSyncToken += 1;
    this.callPlaybackSources.forEach(source => {
      source.ended = false;
      if (this.hasStillFrameMedia(source)) {
        return;
      }

      if (!this.shouldPreloadPlaybackSource(source, currentTimeMs)) {
        this.detachPlaybackSourceMedia(source);
        return;
      }

      if (!this.ensurePlaybackSourceMediaAttached(source)) {
        return;
      }

      const relativeTimeSeconds = Math.max(0, currentTimeMs - source.participant.startedAtMs) / 1000;
      this.setPlaybackMediaTime(source.video, relativeTimeSeconds);
    });
    this.isSeekingCallPlaybackSources = false;
    if (!this.callPlaybackPaused) {
      this.startCallPlaybackClock(currentTimeMs);
    }
    this.refreshCallPlaybackParticipantStreams(currentTimeMs);
    setTimeout(() => this.bindVisibleRemoteVideos());
  }

  private playCallPlaybackSources() {
    this.refreshCallPlaybackParticipantStreams(this.callPlaybackCurrentTimeMs);
    if (this.shouldBufferCallPlaybackAt(this.callPlaybackCurrentTimeMs, this.callPlaybackBufferStartDriftMs)) {
      this.startCallPlaybackBuffering(this.callPlaybackCurrentTimeMs);
      this.startCallPlaybackSyncTimer();
      return;
    }

    this.isCallPlaybackBuffering = false;
    this.callPlaybackBufferTimeMs = 0;
    this.startCallPlaybackClock(this.callPlaybackCurrentTimeMs);
    this.callPlaybackSources
      .filter(source => source.active && !source.ended)
      .forEach(source => this.playPlaybackMediaSource(source));
    this.startCallPlaybackSyncTimer();
  }

  private pauseCallPlaybackSources() {
    this.callPlaybackCurrentTimeMs = this.getCurrentCallPlaybackTimeMs();
    this.isCallPlaybackBuffering = false;
    this.callPlaybackBufferTimeMs = 0;
    this.callPlaybackClockStartedAtMs = 0;
    this.callPlaybackSources.forEach(source => source.video.pause());
    this.stopCallPlaybackSyncTimer();
  }

  private startCallPlaybackBuffering(currentTimeMs: number) {
    const bufferTimeMs = Math.max(0, Math.min(this.callPlaybackDurationMs || currentTimeMs, currentTimeMs));
    this.isCallPlaybackBuffering = true;
    this.callPlaybackBufferTimeMs = bufferTimeMs;
    this.callPlaybackCurrentTimeMs = bufferTimeMs;
    this.callPlaybackClockStartedAtMs = 0;
    this.callPlaybackSources.forEach(source => {
      if (this.hasStillFrameMedia(source)) {
        return;
      }

      source.video.pause();
      if (this.isCallPlaybackSourceActive(source, bufferTimeMs)) {
        this.preparePlaybackSourceForBuffering(source, bufferTimeMs);
      }
    });
    this.syncRecordedSpotifyPlaybackForTime(bufferTimeMs, true);
    this.cdr.detectChanges();
  }

  private continueCallPlaybackBuffering() {
    if (!this.isCallPlaybackBuffering || this.callPlaybackPaused) {
      return;
    }

    const bufferTimeMs = this.callPlaybackBufferTimeMs || this.callPlaybackCurrentTimeMs;
    this.callPlaybackCurrentTimeMs = bufferTimeMs;
    this.callPlaybackSources
      .filter(source => this.isCallPlaybackSourceActive(source, bufferTimeMs))
      .forEach(source => this.preparePlaybackSourceForBuffering(source, bufferTimeMs));

    if (this.shouldBufferCallPlaybackAt(bufferTimeMs, this.callPlaybackBufferResumeDriftMs)) {
      return;
    }

    this.resumeCallPlaybackAfterBuffering(bufferTimeMs);
  }

  private resumeCallPlaybackAfterBuffering(currentTimeMs: number) {
    this.isCallPlaybackBuffering = false;
    this.callPlaybackBufferTimeMs = 0;
    this.visiblePlaybackSyncToken += 1;
    this.callPlaybackCurrentTimeMs = currentTimeMs;
    this.refreshCallPlaybackParticipantStreams(currentTimeMs);
    this.callPlaybackSources
      .filter(source => source.active && !source.ended)
      .forEach(source => this.playPlaybackMediaSource(source));
    this.startCallPlaybackClock(currentTimeMs);
    this.syncRecordedSpotifyPlaybackForTime(currentTimeMs, true);
    this.cdr.detectChanges();
  }

  private preparePlaybackSourceForBuffering(source: CallPlaybackSource, currentTimeMs: number) {
    if (this.hasStillFrameMedia(source)) {
      return;
    }

    if (!this.ensurePlaybackSourceMediaAttached(source)) {
      return;
    }

    const expectedTimeSeconds = this.getPlaybackSourceExpectedTimeSeconds(source, currentTimeMs);
    if (
      source.video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      (!Number.isFinite(source.video.currentTime) || Math.abs(source.video.currentTime - expectedTimeSeconds) > 0.35)
    ) {
      this.setPlaybackMediaTime(source.video, expectedTimeSeconds);
    }
  }

  private shouldBufferCallPlaybackAt(currentTimeMs: number, driftThresholdMs: number): boolean {
    return this.callPlaybackSources
      .filter(source => this.isCallPlaybackSourceActive(source, currentTimeMs))
      .some(source => !this.isPlaybackSourceCaughtUp(source, currentTimeMs, driftThresholdMs));
  }

  private isPlaybackSourceCaughtUp(source: CallPlaybackSource, currentTimeMs: number, driftThresholdMs: number): boolean {
    if (this.hasStillFrameMedia(source) || source.ended) {
      return true;
    }

    if (!this.ensurePlaybackSourceMediaAttached(source)) {
      return false;
    }

    const video = source.video;
    if (video.ended) {
      return currentTimeMs >= source.participant.endedAtMs - 500;
    }

    if (video.error || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false;
    }

    const expectedTimeMs = this.getPlaybackSourceExpectedTimeSeconds(source, currentTimeMs) * 1000;
    const actualTimeMs = Number.isFinite(video.currentTime) ? video.currentTime * 1000 : 0;
    const lagMs = expectedTimeMs - actualTimeMs;
    if (lagMs > driftThresholdMs) {
      return false;
    }

    if (actualTimeMs - expectedTimeMs > this.callPlaybackBufferStartDriftMs) {
      this.setPlaybackMediaTime(video, expectedTimeMs / 1000);
      return false;
    }

    return true;
  }

  private getPlaybackSourceExpectedTimeSeconds(source: CallPlaybackSource, currentTimeMs: number): number {
    return Math.max(0, currentTimeMs - source.participant.startedAtMs) / 1000;
  }

  setCallPlaybackPaused(paused: boolean) {
    if (!this.isCallPlaybackMode) {
      return;
    }

    const wasPaused = this.callPlaybackPaused;
    if (paused) {
      this.pauseCallPlaybackSources();
      this.callPlaybackPaused = true;
    } else {
      this.callPlaybackPaused = false;
      this.playCallPlaybackSources();
    }

    if (wasPaused !== paused) {
      this.syncRecordedSpotifyPlaybackForTime(this.callPlaybackCurrentTimeMs, true);
    }

    if (paused) {
      this.sessionRecording.setPlaybackTime(this.callPlaybackCurrentTimeMs, true);
    } else {
      this.sessionRecording.setPlaybackPaused(false);
    }
  }

  seekCallPlayback(value: number | string) {
    const currentTimeMs = Math.max(0, Number(value) || 0);
    this.callPlaybackCurrentTimeMs = currentTimeMs;
    this.seekCallPlaybackSources(currentTimeMs);
    this.forceCallPlaybackEnvironmentReset = true;
    this.sessionRecording.setPlaybackTime(currentTimeMs, this.callPlaybackPaused);
  }

  private startCallPlaybackSyncTimer() {
    if (this.callPlaybackSyncInterval) {
      return;
    }

    this.callPlaybackSyncInterval = setInterval(() => {
      if (!this.isCallPlaybackMode || this.isSeekingCallPlaybackSources) {
        return;
      }

      const currentTimeMs = this.isCallPlaybackBuffering
        ? this.callPlaybackBufferTimeMs
        : this.getCurrentCallPlaybackTimeMs();
      this.callPlaybackCurrentTimeMs = currentTimeMs;
      this.sessionRecording.setPlaybackTime(currentTimeMs, this.callPlaybackPaused);
      this.refreshCallPlaybackParticipantStreams(currentTimeMs);
      if (!this.callPlaybackPaused && this.isCallPlaybackBuffering) {
        this.continueCallPlaybackBuffering();
      } else if (!this.callPlaybackPaused) {
        if (this.shouldBufferCallPlaybackAt(currentTimeMs, this.callPlaybackBufferStartDriftMs)) {
          this.startCallPlaybackBuffering(currentTimeMs);
          return;
        }

        this.callPlaybackSources
          .filter(source => source.active && source.video.paused && !source.ended && !this.hasStillFrameMedia(source))
          .forEach(source => this.playPlaybackMediaSource(source));
      }
      if (currentTimeMs >= this.callPlaybackDurationMs) {
        this.onCallPlaybackEnded();
      }
    }, 250);
  }

  private stopCallPlaybackSyncTimer() {
    if (this.callPlaybackSyncInterval) {
      clearInterval(this.callPlaybackSyncInterval);
      this.callPlaybackSyncInterval = null;
    }
  }

  private getCurrentCallPlaybackTimeMs(): number {
    if (this.callPlaybackPaused || !this.callPlaybackClockStartedAtMs) {
      return this.callPlaybackCurrentTimeMs;
    }

    return Math.min(
      this.callPlaybackDurationMs || Number.MAX_SAFE_INTEGER,
      this.callPlaybackClockStartTimeMs + (Date.now() - this.callPlaybackClockStartedAtMs)
    );
  }

  private startCallPlaybackClock(currentTimeMs: number) {
    this.callPlaybackClockStartTimeMs = Math.max(0, currentTimeMs);
    this.callPlaybackClockStartedAtMs = Date.now();
  }

  private playPlaybackMediaSource(source: CallPlaybackSource) {
    if (this.hasStillFrameMedia(source) || this.isCallPlaybackBuffering) {
      return;
    }

    if (!this.ensurePlaybackSourceMediaAttached(source)) {
      return;
    }

    if (source.ended || source.video.ended) {
      source.ended = true;
      return;
    }

    void source.video.play().catch(() => undefined);
  }

  private refreshCallPlaybackParticipantStreams(currentTimeMs: number) {
    this.preloadUpcomingPlaybackSources(currentTimeMs);
    this.callPlaybackSources.forEach(source => {
      const isActive = this.isCallPlaybackSourceActive(source, currentTimeMs);
      if (!isActive) {
        source.active = false;
        source.video.pause();
        if (this.shouldReleasePlaybackSource(source, currentTimeMs)) {
          this.detachPlaybackSourceMedia(source);
        }
        return;
      }

      if (!source.active) {
        source.active = true;
        source.ended = false;
        if (!this.hasStillFrameMedia(source) && this.ensurePlaybackSourceMediaAttached(source)) {
          this.setPlaybackMediaTime(source.video, Math.max(0, currentTimeMs - source.participant.startedAtMs) / 1000);
        }
      }
    });

    const activeSourceMap = new Map<string, CallPlaybackSource>();
    this.callPlaybackSources
      .filter(source => source.active && (source.stream || this.hasVideoMedia(source) || this.hasStillFrameMedia(source)))
      .sort((first, second) => first.participant.startedAtMs - second.participant.startedAtMs)
      .forEach(source => activeSourceMap.set(source.participant.participantId, source));

    const activeSources = Array.from(activeSourceMap.values())
      .sort((first, second) => first.participant.startedAtMs - second.participant.startedAtMs);

    const participantStreams = activeSources.map(source => {
      const snapshot = this.callPlaybackParticipantSnapshots.get(source.participant.participantId);
      const volumePercent = snapshot?.volumePercent ?? source.participant.volumePercent;
      source.video.volume = this.getPlaybackSourceVolume(volumePercent);
      return {
        id: source.participant.participantId,
        stream: source.stream ?? undefined,
        stillFrameUrl: this.hasStillFrameMedia(source) ? source.participant.media.url : undefined,
        userData: this.toPlaybackCharacter(snapshot?.userData ?? source.participant.userData, source.participant.participantId),
        participantMeta: snapshot?.participantMeta ?? source.participant.participantMeta,
        isLocal: snapshot?.isLocal ?? source.participant.isLocal,
        diagnostics: undefined,
        ping: snapshot?.ping,
        volumePercent,
        isSceneMainCharacter: snapshot?.isSceneMainCharacter ?? this.isSceneMainCharacter(source.participant.participantId)
      };
    });

    this.playbackLocalParticipantStream = participantStreams.find(participant => participant.isLocal) ?? null;
    this.playbackParticipantStreams = participantStreams.filter(participant => !participant.isLocal);
    this.cdr.detectChanges();
    setTimeout(() => this.bindVisibleRemoteVideos());
  }

  private getPlaybackSourceVolume(participantVolumePercent: number): number {
    return Math.min(1, Math.max(0, participantVolumePercent / 100));
  }

  private applyPlaybackParticipantVolume(participantId: string, volumePercent: number) {
    this.callPlaybackSources.forEach(source => {
      if (source.participant.participantId === participantId) {
        source.video.volume = this.getPlaybackSourceVolume(volumePercent);
      }
    });
  }

  private isCallPlaybackSourceActive(source: CallPlaybackSource, currentTimeMs: number): boolean {
    return currentTimeMs >= source.participant.startedAtMs &&
      currentTimeMs <= Math.max(source.participant.endedAtMs, source.participant.startedAtMs + 250);
  }

  private toPlaybackCharacter(character: any, participantId: string): ICharacter {
    const fallbackName = participantId || 'Recorded Participant';
    return {
      _id: character?._id ?? participantId,
      ownerId: character?.ownerId ?? '',
      servers: Array.isArray(character?.servers) ? character.servers : [],
      name: character?.name ?? fallbackName,
      race: character?.race ?? '',
      icon: character?.icon ?? null,
      baseStats: character?.baseStats ?? { strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
      classes: Array.isArray(character?.classes) ? character.classes : [],
      ac: character?.ac
    };
  }

  private bindVisibleRemoteVideos() {
    this.bindVisibleLocalVideo();
    const remotes = this.liveRemoteStreams;
    this.remoteVideos.forEach((videoRef, i) => {
      const video = videoRef.nativeElement;
      const remote = remotes[i];
      const stream = remote?.stream;
      if (video && remote && this.isCallPlaybackMode) {
        const source = this.getActivePlaybackSourceForParticipant(remote.id);
        if (source && this.hasVideoMedia(source)) {
          this.clearLiveRemoteVideoTrackAttachment(video);
          this.bindVisiblePlaybackSourceVideo(video, source);
          return;
        }

        if (source && this.hasStillFrameMedia(source)) {
          this.clearLiveRemoteVideoTrackAttachment(video);
          this.clearVisiblePlaybackMediaElement(video);
          video.srcObject = null;
          video.muted = true;
          return;
        }
      }
      if (video && stream) {
        this.clearLiveRemoteVideoTrackAttachment(video);
        if (video.srcObject !== stream) {
          this.clearVisiblePlaybackMediaElement(video);
          video.srcObject = stream;
        }
        if (stream.getTracks().length) {
          this.playMediaElement(video);
        }
      }
      if (video && !stream) {
        this.clearLiveRemoteVideoTrackAttachment(video);
        this.clearVisiblePlaybackMediaElement(video);
        if (video.srcObject) {
          video.srcObject = null;
        }
      }
      if (video && this.isCallPlaybackMode) {
        video.muted = true;
        return;
      }
      if (video && remote) {
        this.configureRemoteAudio(remote, video);
      }
    });
    if (this.isCallPlaybackMode) {
      this.teardownAllRemoteAudioOutputs();
    } else {
      this.teardownMissingRemoteAudioOutputs(new Set(remotes.map(remote => remote.id)));
    }
  }

  private shouldAttachLiveRemoteVideoTrack(
    remote: ParticipantStream,
    stream: MediaStream | undefined
  ): boolean {
    const remoteVideoTrack = remote.remoteVideoTrack;
    return !!remoteVideoTrack &&
      stream?.getVideoTracks()[0] === remoteVideoTrack.mediaStreamTrack;
  }

  private bindLiveRemoteVideoTrack(
    video: HTMLVideoElement,
    remoteVideoTrack: NonNullable<ParticipantStream['remoteVideoTrack']>
  ) {
    const currentTrack = this.visibleRemoteVideoTrackAttachments.get(video);
    if (currentTrack !== remoteVideoTrack) {
      this.clearLiveRemoteVideoTrackAttachment(video);
      this.clearVisiblePlaybackMediaElement(video);
      remoteVideoTrack.attach(video);
      this.visibleRemoteVideoTrackAttachments.set(video, remoteVideoTrack);
    }

    video.muted = true;
    this.playMediaElement(video);
  }

  private clearLiveRemoteVideoTrackAttachment(video: HTMLVideoElement) {
    const currentTrack = this.visibleRemoteVideoTrackAttachments.get(video);
    if (!currentTrack) {
      return;
    }

    currentTrack.detach(video);
    this.visibleRemoteVideoTrackAttachments.delete(video);
  }

  private bindVisibleLocalVideo() {
    if (!this.localVideo) {
      return;
    }

    const video = this.localVideo.nativeElement;
    if (this.isCallPlaybackMode) {
      const source = this.playbackLocalParticipantStream
        ? this.getActivePlaybackSourceForParticipant(this.playbackLocalParticipantStream.id)
        : null;
      if (source && this.shouldBindVisiblePlaybackMediaElement(source)) {
        this.bindVisiblePlaybackSourceVideo(video, source);
        return;
      }

      if (source && this.hasStillFrameMedia(source)) {
        this.clearVisiblePlaybackMediaElement(video);
        video.srcObject = null;
        video.muted = true;
        return;
      }

      const stream = this.playbackLocalParticipantStream?.stream ?? null;
      if (video.srcObject !== stream || video.dataset['playbackElementSourceKey']) {
        this.clearVisiblePlaybackMediaElement(video);
        video.srcObject = stream;
        this.playMediaElement(video);
      }
      video.muted = true;
      return;
    }

    this.updateLocalVideoDisplay();
  }

  private playMediaElement(element: HTMLMediaElement) {
    void element.play?.().catch(() => undefined);
  }

  private shouldBindVisiblePlaybackMediaElement(source: CallPlaybackSource): boolean {
    return this.hasVideoMedia(source);
  }

  private bindVisiblePlaybackSourceVideo(targetVideo: HTMLVideoElement, source: CallPlaybackSource) {
    if (!this.ensurePlaybackSourceMediaAttached(source)) {
      this.clearVisiblePlaybackMediaElement(targetVideo);
      targetVideo.muted = true;
      return;
    }

    const sourceKey = this.getPlaybackSourceKey(source);
    const previousTarget = this.visiblePlaybackSourceTargets.get(sourceKey);
    if (previousTarget && previousTarget !== targetVideo) {
      this.detachVisiblePlaybackSourceVideo(previousTarget);
    }

    if (targetVideo.dataset['playbackElementSourceKey'] !== sourceKey) {
      this.detachVisiblePlaybackSourceVideo(targetVideo);
      this.clearVisiblePlaybackMediaElement(targetVideo);
      targetVideo.dataset['playbackElementSourceKey'] = sourceKey;
      targetVideo.style.display = 'none';
      this.visiblePlaybackSourceTargets.set(sourceKey, targetVideo);
    }

    const parent = targetVideo.parentElement;
    if (parent && source.video.parentElement !== parent) {
      parent.insertBefore(source.video, targetVideo.nextSibling);
    }

    source.video.playsInline = true;
    source.video.preload = 'metadata';
    source.video.muted = false;
    source.video.style.display = 'block';
    source.video.style.visibility = '';
    source.video.style.position = 'absolute';
    source.video.style.inset = '0';
    source.video.style.width = '100%';
    source.video.style.height = '100%';
    source.video.style.objectFit = 'contain';
    source.video.style.background = '#000';
    source.video.style.transform = source.participant.isLocal ? 'rotateY(180deg)' : '';
    source.video.style.zIndex = '1';
    source.video.classList.add('call-playback-visible-video');
    void this.applyAudioOutputToMediaElement(source.video);

    if (this.callPlaybackPaused || this.isCallPlaybackBuffering || source.ended) {
      if (!source.video.paused) {
        source.video.pause();
      }
      return;
    }

    this.playPlaybackMediaSource(source);
  }

  private detachVisiblePlaybackSourceVideo(targetVideo: HTMLVideoElement) {
    const sourceKey = targetVideo.dataset['playbackElementSourceKey'];
    if (!sourceKey) {
      targetVideo.style.display = '';
      targetVideo.style.visibility = '';
      return;
    }

    const source = this.callPlaybackSources.find(candidate => this.getPlaybackSourceKey(candidate) === sourceKey);
    if (source) {
      source.video.classList.remove('call-playback-visible-video');
      source.video.style.display = '';
      source.video.style.visibility = '';
      source.video.style.position = '';
      source.video.style.inset = '';
      source.video.style.width = '';
      source.video.style.height = '';
      source.video.style.objectFit = '';
      source.video.style.background = '';
      source.video.style.transform = '';
      source.video.style.zIndex = '';
      if (this.callPlaybackMediaHost && source.video.parentElement !== this.callPlaybackMediaHost) {
        this.callPlaybackMediaHost.appendChild(source.video);
      }
    }

    this.visiblePlaybackSourceTargets.delete(sourceKey);
    delete targetVideo.dataset['playbackElementSourceKey'];
    targetVideo.style.display = '';
    targetVideo.style.visibility = '';
  }

  private getPlaybackSourceKey(source: CallPlaybackSource): string {
    return source.participant.media.url || `${source.participant.participantId}:${source.participant.startedAtMs}`;
  }

  private bindVisiblePlaybackMediaElement(video: HTMLVideoElement, source: CallPlaybackSource) {
    if (video.srcObject) {
      video.srcObject = null;
    }

    const sourceUrl = source.participant.media.url;
    const isNewSource = video.dataset['playbackSourceUrl'] !== sourceUrl;
    if (isNewSource) {
      video.dataset['playbackSourceUrl'] = sourceUrl;
      video.src = sourceUrl;
      video.playsInline = true;
      video.preload = 'metadata';
    }

    video.muted = true;
    const syncToken = String(this.visiblePlaybackSyncToken);
    if (isNewSource || video.dataset['playbackSyncToken'] !== syncToken || this.callPlaybackPaused || this.isCallPlaybackBuffering) {
      const sourceTime = Math.max(0, this.callPlaybackCurrentTimeMs - source.participant.startedAtMs) / 1000;
      this.setPlaybackMediaTime(video, sourceTime);
      video.dataset['playbackSyncToken'] = syncToken;
    } else {
      this.correctVisiblePlaybackMediaDrift(video, source);
    }

    if (this.callPlaybackPaused || this.isCallPlaybackBuffering || source.ended) {
      if (!video.paused) {
        video.pause();
      }
    } else {
      if (video.paused && !video.ended) {
        void video.play().catch(() => undefined);
      }
    }
  }

  private clearVisiblePlaybackMediaElement(video: HTMLVideoElement) {
    this.detachVisiblePlaybackSourceVideo(video);
    if (!video.src && !video.srcObject) {
      return;
    }

    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    delete video.dataset['playbackSourceUrl'];
    delete video.dataset['playbackSyncToken'];
    video.style.display = '';
    video.style.visibility = '';
    video.load();
  }

  private getActivePlaybackSourceForParticipant(participantId: string): CallPlaybackSource | null {
    return this.callPlaybackSources.find(source =>
      source.participant.participantId === participantId &&
      this.isCallPlaybackSourceActive(source, this.callPlaybackCurrentTimeMs)
    ) ?? null;
  }

  private hasVideoTrack(stream: MediaStream | null | undefined): boolean {
    return !!stream?.getVideoTracks().some(track => track.readyState === 'live');
  }

  private hasVideoMedia(source: CallPlaybackSource): boolean {
    return source.participant.media.mimeType.startsWith('video/');
  }

  private hasStillFrameMedia(source: CallPlaybackSource): boolean {
    return this.isStillFrameMedia(source.participant.media);
  }

  private isStillFrameMedia(media: SessionRecordingMedia | null | undefined): boolean {
    return !!media?.mimeType?.startsWith('image/');
  }

  private correctVisiblePlaybackMediaDrift(video: HTMLVideoElement, source: CallPlaybackSource) {
    if (this.callPlaybackPaused || this.isCallPlaybackBuffering || source.ended || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const expectedTimeSeconds = Math.max(0, this.callPlaybackCurrentTimeMs - source.participant.startedAtMs) / 1000;
    const actualTimeSeconds = Number.isFinite(video.currentTime) ? video.currentTime : expectedTimeSeconds;
    const driftSeconds = Math.abs(actualTimeSeconds - expectedTimeSeconds);
    const jumpedToStart = expectedTimeSeconds > 2 && actualTimeSeconds < 0.5;
    if (jumpedToStart || driftSeconds > 1.5) {
      this.setPlaybackMediaTime(video, expectedTimeSeconds);
    }
  }

  private setPlaybackMediaTime(video: HTMLVideoElement, targetTimeSeconds: number) {
    const applyTime = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      const nextTime = Math.max(0, Math.min(duration, targetTimeSeconds));
      try {
        video.currentTime = nextTime;
      } catch {
        // Media metadata can race source assignment in WebView. The next
        // explicit seek or activation will retry.
      }
    };

    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.addEventListener('loadedmetadata', applyTime, { once: true });
      return;
    }

    applyTime();
  }

  private syncMicInputMonitor() {
    const track = this.getActiveMicTrack();
    if (!track || track.readyState !== 'live') {
      this.stopMicInputMonitor();
      return;
    }

    if (this.monitoredMicTrack === track && this.micLevelAnalyser) {
      return;
    }

    this.stopMicInputMonitor();
    const AudioContextConstructor = this.getAudioContextConstructor();
    if (!AudioContextConstructor) {
      return;
    }

    this.monitoredMicTrack = track;
    this.micLevelStream = new MediaStream([track]);
    this.micLevelAudioContext = new AudioContextConstructor();
    this.micLevelSource = this.micLevelAudioContext.createMediaStreamSource(this.micLevelStream);
    this.micLevelAnalyser = this.micLevelAudioContext.createAnalyser();
    this.micLevelAnalyser.fftSize = 1024;
    this.micLevelAnalyser.smoothingTimeConstant = 0.8;
    this.micLevelData = new Uint8Array(this.micLevelAnalyser.fftSize);
    this.micLevelSource.connect(this.micLevelAnalyser);
    void this.micLevelAudioContext.resume().catch(() => undefined);
    this.micLevelInterval = setInterval(() => {
      this.updateMicInputLevel();
    }, 100);
  }

  private stopMicInputMonitor() {
    if (this.micLevelInterval) {
      clearInterval(this.micLevelInterval);
      this.micLevelInterval = null;
    }

    this.micLevelSource?.disconnect();
    this.micLevelSource = null;
    this.micLevelAnalyser = null;
    this.micLevelData = null;
    this.micLevelStream = null;
    this.monitoredMicTrack = null;
    this.micInputLevel = 0;

    if (this.micLevelAudioContext) {
      void this.micLevelAudioContext.close().catch(() => undefined);
      this.micLevelAudioContext = null;
    }
  }

  private updateMicInputLevel() {
    if (!this.micLevelAnalyser || !this.micLevelData || !this.monitoredMicTrack) {
      this.micInputLevel = 0;
      return;
    }

    if (this.monitoredMicTrack.readyState !== 'live' || !this.monitoredMicTrack.enabled) {
      this.micInputLevel = 0;
      this.cdr.detectChanges();
      return;
    }

    this.micLevelAnalyser.getByteTimeDomainData(this.micLevelData as Uint8Array<ArrayBuffer>);
    let totalSquare = 0;
    for (const value of this.micLevelData) {
      const normalized = (value - 128) / 128;
      totalSquare += normalized * normalized;
    }

    const rms = Math.sqrt(totalSquare / this.micLevelData.length);
    this.micInputLevel = Math.min(1, rms * 5);
    this.cdr.detectChanges();
  }

  private getAudioContextConstructor(): typeof AudioContext | null {
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
    return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
  }

  async toggleExperimentalMobile1080p() {
    if (!this.isMobileBrowser) {
      return;
    }

    this.experimentalMobile1080pEnabled = !this.experimentalMobile1080pEnabled;
    this.persistMediaPreferences();

    if (this.localStream) {
      await this.replaceActiveMediaStream();
      return;
    }

    if (this.previewStream || this.mobileMediaReady) {
      await this.startPreview();
    }
  }

  async changePcVideoSource(sourceId: CompanionSourceId) {
    await this.videoService.selectVideoSource(sourceId);
    this.updateLocalVideoDisplay();
    this.persistMediaPreferences();
  }

  async changePcAudioSource(sourceId: CompanionSourceId) {
    await this.videoService.selectAudioSource(sourceId);
    this.persistMediaPreferences();
  }

  async changeAudioOutput() {
    this.persistMediaPreferences();
    await this.applyAudioOutputToAllMedia();
  }

  changeParticipantVolume(participantId: string, value: number | string) {
    const volumePercent = this.normalizeParticipantVolume(value, this.isCallPlaybackMode ? 100 : 200);
    if (this.isCallPlaybackMode) {
      this.updatePlaybackParticipantVolume(participantId, volumePercent);
      return;
    }

    this.videoService.setParticipantVolume(participantId, volumePercent);
    this.remoteStreams = this.remoteStreams.map(remote => remote.id === participantId
      ? { ...remote, volumePercent }
      : remote
    );
    this.applyRemoteVolume(participantId, volumePercent);
  }

  canShowParticipantVolumeControl(participant: ParticipantStream): boolean {
    return this.isCallPlaybackMode || !participant.isLocal;
  }

  getParticipantVolumeMax(participant: ParticipantStream): number {
    return this.isCallPlaybackMode ? 100 : 200;
  }

  private updatePlaybackParticipantVolume(participantId: string, volumePercent: number) {
    const existingSnapshot = this.callPlaybackParticipantSnapshots.get(participantId);
    if (existingSnapshot) {
      this.callPlaybackParticipantSnapshots.set(participantId, {
        ...existingSnapshot,
        volumePercent
      });
    }

    if (this.playbackLocalParticipantStream?.id === participantId) {
      this.playbackLocalParticipantStream = {
        ...this.playbackLocalParticipantStream,
        volumePercent
      };
    }

    this.playbackParticipantStreams = this.playbackParticipantStreams.map(participant => participant.id === participantId
      ? { ...participant, volumePercent }
      : participant
    );
    this.applyPlaybackParticipantVolume(participantId, volumePercent);
    this.cdr.detectChanges();
  }

  getRemoteVolumeIcon(remote: ParticipantStream): string {
    if (remote.volumePercent <= 0) return 'volume_off';
    if (remote.volumePercent > 100) return 'volume_up';
    return 'volume_down';
  }

  get localDisplayCharacter(): ICharacter {
    return this.isCallPlaybackMode
      ? this.playbackLocalParticipantStream?.userData ?? this.character
      : this.isDmMode ? this.dmCharacter : this.character;
  }

  get localDisplayIsDm(): boolean {
    return this.isCallPlaybackMode
      ? this.localDisplayCharacter.name === 'DM'
      : this.isDmMode;
  }

  get localVideoHidden(): boolean {
    if (!this.isCallPlaybackMode) {
      return this.isVideoOff;
    }

    if (!this.playbackLocalParticipantStream) {
      return true;
    }

    const source = this.getActivePlaybackSourceForParticipant(this.playbackLocalParticipantStream.id);
    return !this.hasVideoTrack(this.playbackLocalParticipantStream.stream) &&
      !source?.participant.media.mimeType.startsWith('video/') &&
      !source?.participant.media.mimeType.startsWith('image/');
  }

  get localSceneMainCharacter(): boolean {
    return this.isSceneMainCharacter(this.getLocalDisplayParticipantId());
  }

  get localContextMenuOpen(): boolean {
    return this.remoteContextMenu?.remoteId === this.getLocalDisplayParticipantId();
  }

  get showLocalSelfView(): boolean {
    if (this.isCallPlaybackMode) {
      return !!this.playbackLocalParticipantStream && !this.hideSelfView;
    }

    return !!this.localStream && !this.hideSelfView;
  }

  get liveRemoteStreams(): ParticipantStream[] {
    return this.isCallPlaybackMode ? this.playbackParticipantStreams : this.remoteStreams;
  }

  get visibleSceneMainCharacterCount(): number {
    return this.getVisibleSceneMainParticipantIds().length;
  }

  get visibleParticipantCount(): number {
    return this.liveRemoteStreams.length + (this.showLocalSelfView ? 1 : 0);
  }

  get hasVisibleSceneMainCharacters(): boolean {
    return this.visibleSceneMainCharacterCount > 0;
  }

  get isSceneMainLayoutActive(): boolean {
    if (this.isMobileStandardCaller) {
      return false;
    }

    return this.hasVisibleSceneMainCharacters && this.hasSceneMainLayoutSpace;
  }

  get sceneSideRowCount(): number {
    return getSceneSideRowCount(
      this.isSceneMainLayoutActive,
      this.visibleParticipantCount,
      this.visibleSceneMainCharacterCount
    );
  }

  get sceneMainRowCount(): number {
    return getSceneMainGridRowCount(this.visibleSceneMainCharacterCount);
  }

  get sceneMainRowHeightCss(): string {
    return getSceneMainRowHeightCss(
      this.sceneGridContentHeightPx,
      this.sceneMainRowCount,
      this.sceneMainAreaHeightPercent,
      this.sceneMainRowHeightPx
    );
  }

  get sceneSideRowHeightCss(): string {
    return getSceneSideRowHeightCss(this.sceneGridContentHeightPx, this.sceneSideRowHeightPx);
  }

  get sceneSideTileMaxWidthCss(): string {
    return getSceneSideTileMaxWidthCss(this.sceneGridContentHeightPx, this.sceneSideRowHeightPx);
  }

  private get sceneMainRowHeightPx(): number {
    return getSceneMainRowHeightPx(this.sceneMainAreaHeightPx, this.sceneMainRowCount);
  }

  private get sceneSideRowHeightPx(): number {
    return getSceneSideRowHeightPx(
      this.sceneGridContentHeightPx,
      this.sceneMainAreaHeightPx,
      this.sceneSideRowCount
    );
  }

  private get sceneMainAreaHeightPx(): number {
    return getSceneMainAreaHeightPx(this.sceneGridContentHeightPx, this.sceneMainAreaHeightRatio);
  }

  private get sceneMainAreaHeightRatio(): number {
    return getSceneMainAreaHeightRatio(
      this.visibleParticipantCount,
      this.visibleSceneMainCharacterCount
    );
  }

  private get sceneMainAreaHeightPercent(): number {
    return this.sceneMainAreaHeightRatio * 100;
  }

  getLocalPriorityGridColumn(): string | null {
    return this.getPriorityGridColumn(this.getLocalDisplayParticipantId());
  }

  getLocalPriorityGridRow(): string | null {
    return this.getPriorityGridRow(this.getLocalDisplayParticipantId());
  }

  getLocalPriorityGridMaxHeight(): string | null {
    return this.getPriorityGridMaxHeight(this.getLocalDisplayParticipantId());
  }

  getPriorityGridColumn(participantId: string | null | undefined): string | null {
    const placement = this.getPriorityGridPlacement(participantId);
    return placement ? `${placement.column} / span ${placement.columnSpan}` : null;
  }

  getPriorityGridRow(participantId: string | null | undefined): string | null {
    const placement = this.getPriorityGridPlacement(participantId);
    return placement ? `${placement.row}` : null;
  }

  getPriorityGridMaxHeight(participantId: string | null | undefined): string | null {
    if (this.visibleParticipantCount <= 1) {
      return null;
    }

    if (!this.isSceneMainCharacter(participantId)) {
      return null;
    }

    const placement = this.getPriorityGridPlacement(participantId);
    if (!placement) {
      return null;
    }

    const maxHeightPx = getPriorityGridMaxHeightPx(
      this.sceneGridContentWidthPx,
      placement.columnSpan
    );
    return maxHeightPx ? `${maxHeightPx}px` : null;
  }

  private getPriorityGridPlacement(participantId: string | null | undefined): PriorityGridPlacement | null {
    const visibleIds = this.getVisibleParticipantIds();
    return getScenePriorityGridPlacement({
      participantId,
      isSceneMainLayoutActive: this.isSceneMainLayoutActive,
      visibleIds,
      sceneMainIds: this.getVisibleSceneMainParticipantIds(visibleIds),
      visibleParticipantCount: this.visibleParticipantCount
    });
  }

  private getVisibleParticipantIds(): string[] {
    const participantIds: string[] = [];
    const localParticipantId = this.getLocalDisplayParticipantId();

    if (this.showLocalSelfView && localParticipantId) {
      participantIds.push(localParticipantId);
    }

    this.liveRemoteStreams.forEach(remote => participantIds.push(remote.id));

    return participantIds;
  }

  private getVisibleSceneMainParticipantIds(visibleIds: string[] = this.getVisibleParticipantIds()): string[] {
    const visibleIdSet = new Set(visibleIds);
    return this.sceneMainCharacterIds.filter(id => visibleIdSet.has(id));
  }

  isSceneMainCharacter(participantId: string | null | undefined): boolean {
    return !!participantId && this.sceneMainCharacterIds.includes(participantId);
  }

  isSceneMainCharacterLimitReached(remote: ParticipantStream): boolean {
    return !this.isSceneMainCharacter(remote.id) &&
      this.sceneMainCharacterIds.length >= this.maxSceneMainCharacters;
  }

  getSceneMainCharacterMenuIcon(remote: ParticipantStream): string {
    return this.isSceneMainCharacter(remote.id) ? 'star' : 'star_border';
  }

  getSceneMainCharacterMenuLabel(remote: ParticipantStream): string {
    if (this.isSceneMainCharacter(remote.id)) {
      return 'Remove Scene Main Character';
    }

    if (this.isSceneMainCharacterLimitReached(remote)) {
      return 'Main Character Limit Reached';
    }

    return 'Set Scene Main Character';
  }

  async toggleSceneMainCharacter(remote: ParticipantStream) {
    if (!this.isServerOwner) {
      return;
    }

    if (this.isSceneMainCharacterLimitReached(remote)) {
      return;
    }

    await this.videoService.setSceneMainCharacter(remote.id, !this.isSceneMainCharacter(remote.id));
    this.closeRemoteContextMenu();
  }

  async clearSceneMainCharacters() {
    if (!this.isServerOwner) {
      return;
    }

    await this.videoService.clearSceneMainCharacters();
  }

  toggleSelfView() {
    this.hideSelfView = !this.hideSelfView;
    this.closeRemoteContextMenu();
    this.cdr.detectChanges();

    if (!this.hideSelfView) {
      this.updateLocalVideoDisplay();
    }
  }

  openRemoteContextMenu(event: MouseEvent, remote: ParticipantStream) {
    event.preventDefault();
    event.stopPropagation();

    const padding = 12;
    const menuWidth = 260;
    const menuHeight = this.getContextMenuHeight(remote);
    const viewportWidth = typeof window !== 'undefined'
      ? window.innerWidth
      : event.clientX + menuWidth + padding;
    const viewportHeight = typeof window !== 'undefined'
      ? window.innerHeight
      : event.clientY + menuHeight + padding;

    this.remoteContextMenu = {
      remoteId: remote.id,
      x: Math.max(padding, Math.min(event.clientX, viewportWidth - menuWidth - padding)),
      y: Math.max(padding, Math.min(event.clientY, viewportHeight - menuHeight - padding))
    };
  }

  openLocalContextMenu(event: MouseEvent) {
    const localParticipant = this.getLocalContextMenuParticipant();
    if (!localParticipant) {
      return;
    }

    this.openRemoteContextMenu(event, localParticipant);
  }

  closeRemoteContextMenu() {
    this.remoteContextMenu = null;
  }

  openRemoteCharacterFromMenu(remote: ParticipantStream) {
    this.closeRemoteContextMenu();
    this.openCharacter(remote.userData);
  }

  canShowTemporaryDmMenu(participant: ParticipantStream | undefined): boolean {
    if (!this.canManageTemporaryDms || !participant) return false;

    const participantUserId = this.getParticipantUserId(participant);
    const currentUserId = this.character?.ownerId;
    const server = this.serverService.getCurrentServer();
    const ownerId = server ? this.extractOwnerId(server) : '';

    return !!participantUserId &&
      participantUserId !== currentUserId &&
      participantUserId !== ownerId;
  }

  isParticipantTemporaryDm(participant: ParticipantStream | undefined): boolean {
    const participantUserId = this.getParticipantUserId(participant);
    return this.serverService.isUserTemporaryDm(this.serverService.getCurrentServer(), participantUserId);
  }

  async setTemporaryDmFromCall(participant: ParticipantStream, duration: TemporaryDmDuration) {
    const server = this.serverService.getCurrentServer();
    const participantUserId = this.getParticipantUserId(participant);
    if (!server || !participantUserId || !this.canShowTemporaryDmMenu(participant)) return;

    try {
      await this.serverService.updateTemporaryDm(server._id, participantUserId, duration);
      this.checkServerOwner();
      this.closeRemoteContextMenu();
    } catch (error) {
      console.error('Failed to update temporary DM', error);
    }
  }

  private getParticipantUserId(participant: ParticipantStream | undefined): string {
    return participant?.participantMeta?.userId || participant?.userData?.ownerId || '';
  }

  get activeRemoteContextMenuParticipant(): ParticipantStream | undefined {
    if (!this.remoteContextMenu) {
      return undefined;
    }

    const localParticipant = this.getLocalContextMenuParticipant();
    if (localParticipant?.id === this.remoteContextMenu.remoteId) {
      return localParticipant;
    }

    return this.liveRemoteStreams.find(remote => remote.id === this.remoteContextMenu?.remoteId);
  }

  private getLocalContextMenuParticipant(): ParticipantStream | undefined {
    const localParticipantId = this.getLocalDisplayParticipantId();
    if (!localParticipantId) {
      return undefined;
    }

    if (this.isCallPlaybackMode) {
      return this.playbackLocalParticipantStream ?? undefined;
    }

    return {
      id: localParticipantId,
      stream: this.localStream || undefined,
      userData: this.isDmMode ? this.dmCharacter : this.character,
      participantMeta: this.videoService.getCurrentParticipantMetadata(),
      ping: this.localParticipantPing,
      isLocal: true,
      diagnostics: this.localParticipantDiagnostics,
      volumePercent: 100,
      isSceneMainCharacter: this.isSceneMainCharacter(localParticipantId)
    };
  }

  private isContextMenuParticipantAvailable(participantId: string): boolean {
    return participantId === this.getLocalDisplayParticipantId() ||
      this.liveRemoteStreams.some(remote => remote.id === participantId);
  }

  private getLocalDisplayParticipantId(): string | null {
    return this.isCallPlaybackMode
      ? this.playbackLocalParticipantStream?.id ?? null
      : this.videoService.getCurrentParticipantIdentity();
  }

  private getContextMenuHeight(participant: ParticipantStream): number {
    return 96 +
      (this.isServerOwner ? 44 : 0) +
      (this.canShowTemporaryDmMenu(participant) ? 220 : 0) +
      (this.canShowParticipantVolumeControl(participant) ? 112 : 0);
  }

  private refreshVisibleRemoteStreams(streams: any[] = this.videoService.remoteStreams$.value) {
    const visibleRemoteParticipants = streams.filter(p => !p.isLocal && this.shouldDisplayRemoteParticipant(p));
    this.remoteStreams = visibleRemoteParticipants.map(r => ({
      id: r.id,
      stream: r.stream,
      userData: r.userData || { name: 'Unknown', _id: r.id } as ICharacter,
      participantMeta: r.participantMeta,
      remoteAudioTrack: r.remoteAudioTrack,
      remoteVideoTrack: r.remoteVideoTrack,
      ping: r.ping,
      diagnostics: r.diagnostics,
      volumePercent: this.videoService.getParticipantVolume(r.id),
      isSceneMainCharacter: this.isSceneMainCharacter(r.id)
    }));
  }

  onRemoteVideoQualityChange() {
    this.remoteVideoQualityLevel = normalizeRemoteVideoQualityLevel(this.remoteVideoQualityLevel);
    this.videoService.setRemoteVideoQualityPreference(
      getRemoteVideoQualityPreference(this.remoteVideoQualityLevel)
    );
    this.persistMediaPreferences();
  }

  get remoteVideoQualityLabel(): string {
    return this.remoteVideoQualityOptions[this.remoteVideoQualityLevel]?.label ?? 'Balanced';
  }

  get isMobileStandardCaller(): boolean {
    return this.isMobileBrowser && this.mobileJoinMode === 'caller';
  }

  get isMobileCompanionMode(): boolean {
    return this.isMobileBrowser && this.mobileJoinMode === 'companion';
  }

  get mobileJoinModeDescription(): string {
    return this.mobileJoinMode === 'companion'
      ? 'Webcam mode sends this phone camera and mic to your desktop call. It will not show the room grid.'
      : 'Standard caller mode joins the room on this phone with everyone visible in a mobile-friendly grid.';
  }

  get mobileMediaPromptText(): string {
    return this.mobileJoinMode === 'companion'
      ? 'Enable camera and microphone first to use this phone as a webcam.'
      : 'Enable camera and microphone first to preview and join as a caller.';
  }

  get primaryJoinButtonLabel(): string {
    if (!this.isMobileBrowser) {
      return 'Enter Call';
    }

    return this.mobileJoinMode === 'companion' ? 'Use as Webcam' : 'Join as Caller';
  }

  setMobileJoinMode(mode: MobileCallJoinMode) {
    if (!this.isMobileBrowser || this.mobileJoinMode === mode) {
      return;
    }

    this.mobileJoinMode = mode;
    this.joinError = '';
    this.persistMediaPreferences();
    this.cdr.detectChanges();
  }

  async joinCall() {
    if (!this.channelId || !this.character || this.isJoining) return;
    this.isJoining = true;
    this.joinError = '';

    try {
      const currentUserId = this.requireCurrentUserId();
      const characterToBroadcast = this.isDmMode ? this.dmCharacter : this.character;

      await this.videoService.initVideoCall(this.channelId, currentUserId, characterToBroadcast, {
        mobileJoinMode: this.isMobileBrowser ? this.mobileJoinMode : undefined
      });

      this.localStream = await this.getStreamForJoin();
      this.assertActiveLocalStream();
      this.syncMicInputMonitor();
      this.syncLiveStateFromPreview();
      this.applyLocalTrackStates();

      await this.videoService.startPlayback();
      await this.videoService.updateUserData(this.channelId, characterToBroadcast);
      await this.videoService.startProducing(this.localStream);
      await this.publishInitialCallTrackState();

      setTimeout(() => {
        this.updateLocalVideoDisplay();
      }, 100);

      this.syncSoundCloudHostSyncTimer();
      if (this.isServerOwner) {
        this.scheduleSoundCloudParticipantSync();
      } else {
        this.requestSoundCloudStateWithRetries();
      }
    } catch (err) {
      await this.handleJoinFailure(err);
    } finally {
      this.isJoining = false;
      this.cdr.detectChanges();
    }
  }

  private requireCurrentUserId(): string {
    const currentUserId = this.authService.getCurrentUserId();
    if (!currentUserId) {
      throw new Error('Missing authenticated userId');
    }

    return currentUserId;
  }

  private async getStreamForJoin(): Promise<MediaStream> {
    if (this.previewStream && this.previewStream.active) {
      const stream = this.previewStream;
      this.previewStream = null;
      return stream;
    }

    if (this.isMobileBrowser) {
      await this.prepareMobileMedia();
    }

    const stream = await navigator.mediaDevices.getUserMedia(this.buildMediaConstraints());
    await this.applySelectedSourceBandwidthOptimizations(stream);
    return stream;
  }

  private assertActiveLocalStream() {
    if (!this.localStream || !this.localStream.active) {
      throw new Error('Acquired stream is not active');
    }
  }

  private syncLiveStateFromPreview() {
    this.isAudioMuted = this.isPreviewMuted;
    this.isVideoOff = this.isPreviewVideoOff;
    this.persistMediaPreferences();
  }

  private applyLocalTrackStates() {
    this.localStream?.getAudioTracks().forEach(track => track.enabled = !this.isAudioMuted);
    this.localStream?.getVideoTracks().forEach(track => track.enabled = !this.isVideoOff);
  }

  private async publishInitialCallTrackState() {
    await this.videoService.setCameraEnabled(!this.isVideoOff);
    await this.videoService.setMicrophoneEnabled(!this.isAudioMuted);
  }

  private async handleJoinFailure(error: unknown) {
    console.error('[CRITICAL] Join call failed:', error);
    this.joinError = this.getJoinErrorMessage(error);
    const shouldRestartPreview = !this.isBackendJoinAuthorizationError(error);
    this.stopSoundCloudCallSyncTimers();
    await this.videoService.leaveCall(this.channelId).catch(cleanupError => {
      console.warn('LiveKit cleanup after join failure failed', cleanupError);
    });
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (shouldRestartPreview) {
      await this.startPreview();
    }
  }

  private getJoinErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.toLowerCase().includes('permission')) {
      return message;
    }

    return 'Could not join this call. Check your device access and channel permissions.';
  }

  private isBackendJoinAuthorizationError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
    return message.includes('authentication')
      || message.includes('permission')
      || message.includes('invalid call identity')
      || message.includes('call channel not found');
  }

  async leaveCall() {
    this.stopSessionRecording();
    this.resetMicTestForCaptureChange();
    this.stopSoundCloudCallSyncTimers();
    await this.videoService.leaveCall(this.channelId);
    this.themeService.revertToSaved();
    this.localStream = null;
    this.remoteStreams = [];
    this.sceneMainCharacterIds = [];
    this.closeRemoteContextMenu();
    this.teardownAllRemoteAudioOutputs();
    this.showSpotify = false;
    this.stopVtt.emit({ roomId: this.getVttRoomId(), endSession: false });
    this.isDmMode = false;
    this.syncPreviewSetupFromLive();
    if (!this.isComponentDestroying) {
      await this.startPreview();
    }
  }

  toggleAudio() {
    if (this.localStream) {
      this.isAudioMuted = !this.isAudioMuted;
      this.localStream.getAudioTracks().forEach(track => (track.enabled = !this.isAudioMuted));
      this.videoService.setMicrophoneEnabled(!this.isAudioMuted);
      this.isPreviewMuted = this.isAudioMuted;
    } else {
      this.isPreviewMuted = !this.isPreviewMuted;
      if (this.previewStream) {
        this.previewStream.getAudioTracks().forEach(t => t.enabled = !this.isPreviewMuted);
      }
    }
    this.persistMediaPreferences();
  }

  toggleVideo() {
    if (this.localStream) {
      this.isVideoOff = !this.isVideoOff;
      this.localStream.getVideoTracks().forEach(track => (track.enabled = !this.isVideoOff));
      this.videoService.setCameraEnabled(!this.isVideoOff);
      this.isPreviewVideoOff = this.isVideoOff;
    } else {
      this.isPreviewVideoOff = !this.isPreviewVideoOff;
      if (this.previewStream) {
        this.previewStream.getVideoTracks().forEach(t => t.enabled = !this.isPreviewVideoOff);
      }
    }
    this.persistMediaPreferences();
  }

  triggerVttNotification() {
    this.showVttNotification = true;
    if (this.vttNotificationTimeout) clearTimeout(this.vttNotificationTimeout);
    this.vttNotificationTimeout = setTimeout(() => this.showVttNotification = false, 10000);
  }

  async ngOnChanges(changes: SimpleChanges) {
    const characterChange = changes['character'];
    const channelIdChange = changes['channelId'];

    if (characterChange && characterChange.currentValue) {
      const newCharacter: ICharacter = characterChange.currentValue;

      if (newCharacter.ownerId && this.dmCharacter.ownerId !== newCharacter.ownerId) {
        this.dmCharacter.ownerId = newCharacter.ownerId;
        this.checkServerOwner();
      }

      if (!this.isDmMode && this.channelId) {
        this.videoService.updateUserData(this.channelId, newCharacter);
        this.recordCallParticipantsSnapshotIfChanged();
      }
    }

    if (channelIdChange && channelIdChange.currentValue) {
      this.registerCallLivestreamSource();
      this.checkServerOwner();
    }
  }

  openCharacter(character: ICharacter | undefined) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  toggleSpotifyOverlay() {
    const shouldShow = !this.showSpotify;
    this.closeClickOffOverlays();
    this.showSpotify = shouldShow;
  }

  toggleDeviceRoutingOverlay() {
    const shouldShow = !this.showDeviceRouting;
    this.closeClickOffOverlays();
    this.showDeviceRouting = shouldShow;
  }

  toggleSpotifyRequests() {
    const shouldShow = !this.showSpotifyRequests;
    this.closeClickOffOverlays();
    this.showSpotifyRequests = shouldShow;
  }

  // --- THEME PICKER LOGIC ---

  get hasThemeBackgroundImage(): boolean {
    return !!this.activeColors.backgroundImage;
  }

  get themeBackgroundImagePreviewStyle(): string {
    return toCssImageValue(this.activeColors.backgroundImage ?? null);
  }

  get isThemeBackgroundBlurred(): boolean {
    return this.hasThemeBackgroundImage && this.activeColors.backgroundImageBlur === true;
  }

  toggleThemePicker() {
    if (this.showThemePicker) {
      this.cancelTheme();
      return;
    }

    this.closeClickOffOverlays();
    this.themePickerBaselineColors = this.isServerOwner ? cloneThemeColors(this.activeColors) : null;
    this.showThemePicker = true;
  }

  updateThemeLocally(key: keyof ThemeColors, value: string | boolean | null) {
    this.applyThemeCandidate({ ...this.activeColors, [key]: value }, key === 'backgroundImage');
  }

  onThemeBackgroundImageSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = e => {
      const image = typeof e.target?.result === 'string' ? e.target.result : null;
      if (image) {
        const accepted = this.applyThemeCandidate({
          ...this.activeColors,
          backgroundImage: image
        });

        if (!accepted) {
          this.promptThemeImageCompression(file);
          this.cdr.detectChanges();
        }
      }
    };
    reader.readAsDataURL(file);
  }

  clearThemeBackgroundImage(input?: HTMLInputElement) {
    if (input) {
      input.value = '';
    }

    this.applyThemeCandidate({
      ...this.activeColors,
      backgroundImage: null,
      backgroundImageBlur: false
    });
  }

  getPinnedThemePreview(theme: PinnedTheme): string {
    if (theme.colors.backgroundImage) {
      return `${theme.colors.background} ${toCssImageValue(theme.colors.backgroundImage)} center / cover no-repeat`;
    }

    return theme.colors.primary;
  }

  confirmTheme() {
    this.themeService.applyTheme(this.activeColors, false);
    if (!this.safeSendThemeUpdate(this.activeColors)) {
      return;
    }
    this.recordCallEnvironmentEvent('theme-sync', this.activeColors);
    this.activateCallLivestreamBroadcastOverlay({
      type: 'theme',
      title: 'Atmosphere Broadcast',
      text: 'Atmosphere updated',
      image: this.activeColors.backgroundImage ?? null
    });
    this.themePickerBaselineColors = null;
    this.showThemePicker = false;
  }

  cancelTheme() {
    if (this.isServerOwner && this.themePickerBaselineColors) {
      this.activeColors = cloneThemeColors(this.themePickerBaselineColors);
      this.themeService.applyTheme(this.activeColors, false);
      this.rememberValidThemeBackground(this.activeColors);
    } else if (this.isServerOwner) {
      this.themeService.revertToSaved();
      this.activeColors = this.themeService.getColors();
      this.rememberValidThemeBackground(this.activeColors);
    }

    this.themePickerBaselineColors = null;
    this.showThemePicker = false;
    this.showPinNaming = false;
  }

  resetToServerDefault() {
    this.activeColors = this.themeService.getServerDefaultColors();
    this.themeService.applyTheme(this.activeColors, false);
    this.rememberValidThemeBackground(this.activeColors);
    if (this.safeSendThemeUpdate(this.activeColors)) {
      this.recordCallEnvironmentEvent('theme-sync', this.activeColors);
      this.activateCallLivestreamBroadcastOverlay({
        type: 'theme',
        title: 'Atmosphere Broadcast',
        text: 'Atmosphere reset',
        image: this.activeColors.backgroundImage ?? null
      });
      this.themePickerBaselineColors = cloneThemeColors(this.activeColors);
    }
  }

  selectPinnedTheme(theme: PinnedTheme) {
    this.applyThemeCandidate({ ...theme.colors }, true);
  }

  pinCurrentTheme() {
    if (!this.newThemeName.trim()) return;
    this.themeService.pinTheme(this.newThemeName, this.activeColors);
    this.newThemeName = '';
    this.showPinNaming = false;
  }

  toggleDmMode() {
    if (!this.isServerOwner) return;

    this.isDmMode = !this.isDmMode;
    const characterToBroadcast = this.isDmMode ? this.dmCharacter : this.character;
    this.videoService.updateUserData(this.channelId, characterToBroadcast);
    this.recordCallEnvironmentEvent('dm-mode', {
      enabled: this.isDmMode,
      character: createCharacterSnapshot(characterToBroadcast)
    });
    this.recordCallParticipantsSnapshotIfChanged();
    this.cdr.detectChanges();
  }

  @HostListener('window:beforeunload')
  async handleBeforeUnload() {
    this.isComponentDestroying = true;
    await this.leaveCall();
  }

  @HostListener('document:click', ['$event'])
  handleDocumentClick(event: MouseEvent) {
    if (!this.isTabActive) {
      return;
    }

    if (this.isClickInsideOverlayFeature(event)) {
      return;
    }

    this.closeClickOffOverlays();
  }

  @HostListener('document:contextmenu', ['$event'])
  handleDocumentContextMenu(event: MouseEvent) {
    if (!this.isTabActive) {
      return;
    }

    if (this.isClickInsideOverlayFeature(event)) {
      return;
    }

    this.closeClickOffOverlays();
  }

  @HostListener('document:keydown.escape')
  handleDocumentEscape() {
    if (!this.isTabActive) {
      return;
    }

    this.closeClickOffOverlays();
  }

  @HostListener('window:call-session-note-updated', ['$event'])
  handleExternalSessionNoteUpdate(event: Event) {
    const detail = (event as CustomEvent<CallSessionNoteUpdatedEventDetail>).detail;
    if (!detail?.path) {
      return;
    }

    if (detail.serverId && detail.serverId !== this.getSessionNotesServerId()) {
      return;
    }

    if (detail.channelId && detail.channelId !== this.channelId) {
      return;
    }

    void this.applyExternalSessionNoteUpdate(detail);
  }

  @HostListener('window:resize')
  handleWindowResize() {
    this.updateSceneMainLayoutSpaceFromElement();
    this.closeRemoteContextMenu();
  }

  private isClickInsideOverlayFeature(event: MouseEvent): boolean {
    const target = event.target;
    return target instanceof Element && !!target.closest(this.clickOffSafeSelector);
  }

  private closeClickOffOverlays(dismissBroadcastOverlay: boolean = true) {
    this.closeRemoteContextMenu();

    if (this.showThemePicker) {
      this.cancelTheme();
    }

    this.showDeviceRouting = false;
    this.showDiagnosticsPanel = false;
    this.showSpotify = false;
    this.showSpotifyRequests = false;

    if (this.showVttNotification) {
      this.showVttNotification = false;
      if (this.vttNotificationTimeout) {
        clearTimeout(this.vttNotificationTimeout);
        this.vttNotificationTimeout = null;
      }
    }

    if (this.pendingAstralPlaybackRequest) {
      this.cancelAstralPlaybackPrompt();
    }

    if (this.showLocalRecordingsLibrary) {
      this.closeLocalRecordingsLibrary();
    }

    this.closeSessionNotePicker();

    if (!dismissBroadcastOverlay) {
      return;
    }

    if (this.isBroadcastOverlayInDismissGracePeriod()) {
      return;
    }

    this.dismissOverlay();
  }

  private isBroadcastOverlayInDismissGracePeriod(): boolean {
    return !!(this.activeOverlayImage || this.activeOverlayText) &&
      Date.now() - this.lastBroadcastOverlayActivatedAt < this.broadcastOverlayDismissGraceMs;
  }

  private activateCallLivestreamBroadcastOverlay(
    overlay: Omit<CallLivestreamBroadcastOverlay, 'startedAtMs' | 'durationMs'>
  ) {
    if (!this.recordingAndStreamingEnabled) {
      void overlay;
      return;
    }

    const text = overlay.text?.trim() || null;
    if (!text && !overlay.image) {
      return;
    }

    this.callLivestreamBroadcastOverlay = {
      ...overlay,
      text,
      startedAtMs: Date.now(),
      durationMs: this.callLivestreamBroadcastOverlayDurationMs
    };
  }

  private clearCallLivestreamBroadcastOverlay(type?: CallLivestreamBroadcastOverlayType) {
    if (!this.recordingAndStreamingEnabled) {
      void type;
      return;
    }

    if (!this.callLivestreamBroadcastOverlay) {
      return;
    }

    if (type && this.callLivestreamBroadcastOverlay.type !== type) {
      return;
    }

    this.callLivestreamBroadcastOverlay = null;
  }

  private getActiveCallLivestreamBroadcastOverlay(): CallLivestreamBroadcastOverlay | null {
    const overlay = this.callLivestreamBroadcastOverlay;
    if (!overlay) {
      return null;
    }

    if (Date.now() - overlay.startedAtMs < overlay.durationMs) {
      return overlay;
    }

    this.callLivestreamBroadcastOverlay = null;
    return null;
  }

  ngOnDestroy() {
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;
    this.stopSessionRecording();
    this.cleanupCallPlaybackSources();
    this.resetMicTestForCaptureChange();
    this.stopMicInputMonitor();
    this.stopSoundCloudCallSyncTimers();
    this.subscriptions.unsubscribe();
    this.teardownAllRemoteAudioOutputs();
    if (this.deviceReloadTimer) {
      clearTimeout(this.deviceReloadTimer);
      this.deviceReloadTimer = null;
    }
    if (this.sessionNotesSaveTimer) {
      clearTimeout(this.sessionNotesSaveTimer);
      this.sessionNotesSaveTimer = null;
      void this.saveSessionNote();
    }

    // Just clean up local hardware previews.
    // The actual call room disconnection is now handled by TabService.closeTab()
    if (this.previewStream) {
      this.previewStream.getTracks().forEach(t => t.stop());
    }
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChangeBound);
  }

  startVttHosting() {
    const roomId = this.getVttRoomId();
    this.hostVtt.emit(roomId);
  }

  private applyThemeCandidate(candidate: ThemeColors, showSizeError = false): boolean {
    if (this.isThemeSyncPayloadTooLarge(candidate)) {
      this.revertThemeBackground(candidate, showSizeError);
      return false;
    }

    this.activeColors = candidate;
    this.rememberValidThemeBackground(candidate);
    this.themeService.applyTheme(candidate, false);
    return true;
  }

  private safeSendThemeUpdate(theme: ThemeColors): boolean {
    if (this.isThemeSyncPayloadTooLarge(theme)) {
      const oversizedImage = theme.backgroundImage ?? null;
      this.revertThemeBackground(theme, false);
      this.promptThemeImageCompression(oversizedImage);
      return false;
    }

    try {
      this.videoService.sendThemeUpdate(theme);
      this.rememberValidThemeBackground(theme);
      return true;
    } catch (error) {
      if (isThemePayloadSizeError(error)) {
        const oversizedImage = theme.backgroundImage ?? null;
        this.revertThemeBackground(theme, false);
        this.promptThemeImageCompression(oversizedImage);
        return false;
      }

      throw error;
    }
  }

  private isThemeSyncPayloadTooLarge(theme: ThemeColors): boolean {
    return isThemeSyncPayloadTooLarge(theme, CALL_MAX_THEME_SYNC_PAYLOAD_BYTES);
  }

  private revertThemeBackground(theme: ThemeColors, showToast: boolean) {
    const revertedTheme = getRevertedThemeBackground(
      theme,
      this.lastValidThemeBackgroundImage,
      this.lastValidThemeBackgroundImageBlur
    );
    this.activeColors = revertedTheme;
    this.themeService.applyTheme(revertedTheme, false);

    if (showToast) {
      this.snackBar.open('Background image is too large to broadcast. Choose a smaller image.', 'Close', {
        duration: 2600
      });
    }
  }

  private rememberValidThemeBackground(theme: ThemeColors) {
    this.lastValidThemeBackgroundImage = theme.backgroundImage ?? null;
    this.lastValidThemeBackgroundImageBlur = !!theme.backgroundImage && theme.backgroundImageBlur === true;
  }

  private applyTemporaryAtmosphereBackground(url: string | null) {
    if (!url) {
      this.themeService.applyTheme(this.activeColors, false, false);
      return;
    }

    this.themeService.applyTheme(getTemporaryAtmosphereTheme(this.activeColors, url), false, false);
  }

  private promptThemeImageCompression(source: File | string | null) {
    if (!source) {
      this.snackBar.open('Background image is too large to broadcast. Choose a smaller image.', 'Close', {
        duration: 2600
      });
      return;
    }

    const snackRef = this.snackBar.open('Background image is too large to broadcast.', 'Compress', {
      duration: 7000
    });

    snackRef.onAction().subscribe(() => {
      void this.compressAndApplyThemeBackgroundImage(source);
    });
  }

  private async compressAndApplyThemeBackgroundImage(source: File | string) {
    try {
      const compressedImage = await compressThemeBackgroundImage(
        source,
        this.activeColors,
        CALL_MAX_THEME_SYNC_PAYLOAD_BYTES
      );
      const accepted = this.applyThemeCandidate({
        ...this.activeColors,
        backgroundImage: compressedImage
      });

      if (!accepted) {
        this.snackBar.open('Compressed image is still too large. Choose a smaller image.', 'Close', {
          duration: 2800
        });
        return;
      }

      this.snackBar.open('Compressed background image applied.', 'Close', {
        duration: 1800
      });
    } catch {
      this.snackBar.open('Could not compress image enough. Choose a smaller image.', 'Close', {
        duration: 2800
      });
    }
  }

  startVttJoining() {
    this.joinVtt.emit(this.vttSession.roomId || this.getVttRoomId());
    this.showVttNotification = false;
  }

  stopVttSession() {
    const roomId = this.vttSession.roomId || this.getVttRoomId();
    void this.vttSync.endSessionForRoom(roomId);
    this.stopVtt.emit({ roomId, endSession: true });
  }

  dismissOverlay() {
    this.activeOverlayImage = null;
    this.activeOverlayText = null;
    this.broadcastOverlayNoteStatus = '';
  }

  get hasCurrentSessionNoteForBroadcast(): boolean {
    return !!this.getCurrentSessionNotePath();
  }

  async addActiveBroadcastToCurrentNote() {
    const path = this.getCurrentSessionNotePath();
    if (!path) {
      this.broadcastOverlayNoteStatus = 'Select or create a session note first.';
      return;
    }

    await this.writeActiveBroadcastOverlayToNote(path, 'current');
  }

  async createNoteFromActiveBroadcast() {
    const path = this.getDefaultBroadcastOverlayNoteName();
    await this.writeActiveBroadcastOverlayToNote(path, 'new');
  }

  async toggleSessionNotes() {
    const nextState = !this.showSessionNotes;
    this.closeClickOffOverlays(false);
    this.showSessionNotes = nextState;

    if (nextState) {
      await this.ensureSessionNotesReady();
    }
  }

  closeSessionNotes() {
    this.closeSessionNotePicker();
    this.showSessionNotes = false;
  }

  async attachSessionNotesVault() {
    await this.ensureSessionNotesReady(true);
  }

  async refreshSessionNotes() {
    if (!this.sessionNotesPermissionGranted) {
      await this.ensureSessionNotesReady();
      return;
    }

    await this.loadSessionNoteEntries(false);
  }

  async selectSessionNoteByPath(path: string) {
    if (!path || path === this.selectedSessionNotePath) {
      return;
    }

    await this.flushPendingSessionNoteSave();
    const entry = this.sessionNoteEntries.find(note => note.relativePath === path);
    if (!entry) {
      return;
    }

    try {
      this.sessionNotesError = '';
      this.selectedSessionNotePath = entry.relativePath;
      this.selectedSessionNoteName = this.getSessionNoteDisplayName(entry.relativePath);
      this.selectedSessionNoteContent = await this.obsidianVaultService.readFile(
        this.getSessionNotesServerId(),
        entry.relativePath
      );
      this.sessionNotesSaveState = 'saved';
      this.rememberSelectedSessionNote(entry.relativePath);
    } catch (error) {
      this.sessionNotesError = 'Unable to open that note.';
      this.sessionNotesSaveState = 'error';
      console.error('Failed to open session note', error);
    }
  }

  private async applyExternalSessionNoteUpdate(detail: CallSessionNoteUpdatedEventDetail) {
    const path = detail.path;
    if (!path) {
      return;
    }

    const hadPendingSave = !!this.sessionNotesSaveTimer;
    if (this.sessionNotesSaveTimer) {
      clearTimeout(this.sessionNotesSaveTimer);
      this.sessionNotesSaveTimer = null;
    }

    this.rememberSelectedSessionNote(path);

    if (detail.select || path === this.selectedSessionNotePath) {
      this.selectedSessionNotePath = path;
      this.selectedSessionNoteName = this.getSessionNoteDisplayName(path);

      if (typeof detail.content === 'string') {
        this.selectedSessionNoteContent = detail.content;
      } else if (detail.appendedContent && hadPendingSave) {
        this.selectedSessionNoteContent = this.appendSessionNoteContent(
          this.selectedSessionNoteContent,
          detail.appendedContent
        );
        await this.saveSessionNote();
      } else if (detail.appendedContent) {
        this.selectedSessionNoteContent = this.appendSessionNoteContent(
          this.selectedSessionNoteContent,
          detail.appendedContent
        );
      } else if (this.sessionNotesPermissionGranted) {
        this.selectedSessionNoteContent = await this.obsidianVaultService.readFile(
          this.getSessionNotesServerId(),
          path
        );
      }

      this.sessionNotesSaveState = 'saved';
    }

    if (this.showSessionNotes && this.sessionNotesPermissionGranted) {
      await this.loadSessionNoteEntries(false);
    }

    this.cdr.detectChanges();
  }

  toggleSessionNotePicker() {
    if (this.sessionNotesLoading || this.sessionNoteEntries.length === 0) {
      return;
    }

    if (this.showSessionNotePicker) {
      this.closeSessionNotePicker();
      return;
    }

    this.openSessionNotePicker();
  }

  openSessionNotePicker() {
    if (this.sessionNotesLoading || this.sessionNoteEntries.length === 0) {
      return;
    }

    this.showSessionNotePicker = true;
    this.sessionNotesSearchQuery = '';
    const selectedIndex = this.sessionNoteEntries.findIndex(note => note.relativePath === this.selectedSessionNotePath);
    this.sessionNotesActiveOptionIndex = Math.max(0, selectedIndex);
    this.focusSessionNoteSearch();
  }

  closeSessionNotePicker() {
    this.showSessionNotePicker = false;
    this.sessionNotesSearchQuery = '';
    this.sessionNotesActiveOptionIndex = 0;
  }

  onSessionNoteSearchChange(value: string) {
    this.sessionNotesSearchQuery = value;
    this.sessionNotesActiveOptionIndex = 0;
  }

  async selectSessionNoteFromPicker(note: VaultEntry) {
    await this.selectSessionNoteByPath(note.relativePath);
    this.closeSessionNotePicker();
  }

  handleSessionNotePickerKeydown(event: KeyboardEvent) {
    if (!this.showSessionNotePicker) {
      return;
    }

    const options = this.filteredSessionNoteEntries;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeSessionNotePicker();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.sessionNotesActiveOptionIndex = options.length
        ? (this.sessionNotesActiveOptionIndex + 1) % options.length
        : 0;
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.sessionNotesActiveOptionIndex = options.length
        ? (this.sessionNotesActiveOptionIndex - 1 + options.length) % options.length
        : 0;
      return;
    }

    if (event.key === 'Enter' && options[this.sessionNotesActiveOptionIndex]) {
      event.preventDefault();
      void this.selectSessionNoteFromPicker(options[this.sessionNotesActiveOptionIndex]);
    }
  }

  startCreatingSessionNote() {
    if (!this.sessionNotesPermissionGranted) {
      return;
    }

    this.isCreatingSessionNote = true;
    this.newSessionNoteName = this.getDefaultSessionNoteName();
    this.selectedSessionNoteTemplate = 'session';
    this.sessionNotesError = '';
  }

  cancelCreatingSessionNote() {
    this.isCreatingSessionNote = false;
    this.newSessionNoteName = '';
    this.selectedSessionNoteTemplate = 'session';
  }

  async createSessionNote() {
    const path = this.buildSessionNotePath(this.newSessionNoteName);
    if (!path) {
      this.sessionNotesError = 'Enter a note name.';
      return;
    }

    try {
      this.sessionNotesError = '';
      const content = this.getSessionNoteTemplateContent(path, this.selectedSessionNoteTemplate);
      await this.obsidianVaultService.writeFile(this.getSessionNotesServerId(), path, content);
      this.cancelCreatingSessionNote();
      await this.loadSessionNoteEntries(false);
      await this.selectSessionNoteByPath(path);
    } catch (error) {
      this.sessionNotesError = await this.tryRecoverSessionNotesVault(error)
        ? 'Vault folder reconnected. Create the note again.'
        : 'Unable to create note.';
      console.error('Failed to create session note', error);
    }
  }

  onSessionNoteContentChange(content: string) {
    this.selectedSessionNoteContent = content;
    this.scheduleSessionNoteSave();
  }

  private async writeActiveBroadcastOverlayToNote(path: string, mode: 'current' | 'new') {
    const broadcastContent = this.getActiveBroadcastOverlayMarkdown();
    if (!broadcastContent) {
      this.broadcastOverlayNoteStatus = 'No broadcast content to add.';
      return;
    }

    this.broadcastOverlayNoteSaving = mode;
    this.broadcastOverlayNoteStatus = '';

    try {
      await this.ensureSessionNotesReady();
      if (!this.sessionNotesPermissionGranted) {
        this.broadcastOverlayNoteStatus = this.sessionNotesError || 'Vault access is required for session notes.';
        return;
      }

      await this.flushPendingSessionNoteSave();
      const serverId = this.getSessionNotesServerId();
      const section = this.getBroadcastOverlayNoteSection(broadcastContent);
      let nextContent = '';

      if (mode === 'new') {
        nextContent = this.getBroadcastOverlayNoteFileContent(path, section);
      } else if (path === this.selectedSessionNotePath) {
        nextContent = this.appendSessionNoteContent(this.selectedSessionNoteContent, section);
      } else {
        const currentContent = await this.obsidianVaultService.readFile(serverId, path);
        nextContent = this.appendSessionNoteContent(currentContent, section);
      }

      await this.obsidianVaultService.writeFile(serverId, path, nextContent);
      this.rememberSelectedSessionNote(path);
      this.selectedSessionNotePath = path;
      this.selectedSessionNoteName = this.getSessionNoteDisplayName(path);
      this.selectedSessionNoteContent = nextContent;
      this.sessionNotesSaveState = 'saved';
      this.broadcastOverlayNoteStatus = mode === 'new'
        ? `Created ${path}`
        : `Added to ${this.getSessionNoteDisplayName(path)}`;

      if (this.showSessionNotes) {
        await this.loadSessionNoteEntries(false);
      }
    } catch (error) {
      this.sessionNotesSaveState = 'error';
      this.broadcastOverlayNoteStatus = await this.tryRecoverSessionNotesVault(error)
        ? 'Vault folder reconnected. Try again.'
        : 'Unable to add broadcast to notes.';
      console.error('Failed to save broadcast overlay to session notes', error);
    } finally {
      this.broadcastOverlayNoteSaving = null;
      this.cdr.detectChanges();
    }
  }

  private appendSessionNoteContent(current: string, section: string): string {
    return `${current.trimEnd()}\n\n${section.trim()}\n`;
  }

  private getActiveBroadcastOverlayMarkdown(): string {
    if (this.activeOverlayText?.trim()) {
      return this.activeOverlayText.trim();
    }

    if (this.activeOverlayImage) {
      return this.formatMarkdownImage('Broadcast Image', this.activeOverlayImage);
    }

    return '';
  }

  private formatMarkdownImage(alt: string, url: string): string {
    const safeAlt = alt.replace(/[\[\]\r\n]/g, ' ').trim() || 'Image';
    return `![${safeAlt}](${this.encodeMarkdownUrl(url)})`;
  }

  private encodeMarkdownUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) {
      return trimmed;
    }

    try {
      return this.escapeMarkdownUrlDelimiters(new URL(trimmed, window.location.origin).toString());
    } catch {
      return this.escapeMarkdownUrlDelimiters(encodeURI(trimmed));
    }
  }

  private escapeMarkdownUrlDelimiters(url: string): string {
    return url.replace(/[()]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  private getBroadcastOverlayNoteSection(content: string): string {
    return [
      `## Broadcast - ${this.getSessionNoteDateTime()}`,
      '',
      content,
      ''
    ].join('\n');
  }

  private getBroadcastOverlayNoteFileContent(path: string, section: string): string {
    const title = this.getSessionNoteDisplayName(path);
    return [
      '---',
      `title: ${title}`,
      'tags:',
      '  - broadcast',
      '  - call',
      `date: ${this.getSessionNoteDate()}`,
      '---',
      '',
      `# ${title}`,
      '',
      section.trim(),
      ''
    ].join('\n');
  }

  private async ensureSessionNotesReady(forceAttach: boolean = false) {
    const serverId = this.getSessionNotesServerId();
    if (!serverId) {
      this.sessionNotesError = 'Open a server before using session notes.';
      return;
    }

    this.sessionNotesLoading = true;
    this.sessionNotesError = '';

    try {
      let handle = await this.obsidianVaultService.getVaultHandle(serverId);
      if (!handle || forceAttach) {
        if (!this.obsidianVaultService.isFileSystemApiSupported()) {
          this.sessionNotesError = 'Local vault access needs a Chromium browser.';
          return;
        }

        this.sessionNotesVaultName = await this.obsidianVaultService.attachVaultToServer(serverId);
        handle = await this.obsidianVaultService.getVaultHandle(serverId);
      }

      if (!handle) {
        this.sessionNotesError = 'Attach a vault folder to use session notes.';
        return;
      }

      this.sessionNotesVaultName = handle.name;
      this.sessionNotesPermissionGranted = await this.obsidianVaultService.hasPermission(serverId);
      if (!this.sessionNotesPermissionGranted) {
        this.sessionNotesPermissionGranted = await this.obsidianVaultService.requestPermission(handle);
      }

      if (!this.sessionNotesPermissionGranted) {
        this.sessionNotesError = 'Vault access is required for session notes.';
        return;
      }

      await this.loadSessionNoteEntries();
    } catch (error) {
      this.sessionNotesError = 'Unable to set vault folder.';
      console.error('Failed to prepare session notes vault', error);
    } finally {
      this.sessionNotesLoading = false;
      this.cdr.detectChanges();
    }
  }

  private async loadSessionNoteEntries(useCache: boolean = true) {
    const serverId = this.getSessionNotesServerId();
    if (!serverId || !this.sessionNotesPermissionGranted) {
      return;
    }

    this.sessionNotesLoading = true;
    try {
      const entries = await this.obsidianVaultService.listVaultFiles(serverId, useCache);
      this.sessionNoteEntries = this.flattenSessionNoteEntries(entries);
      this.closeSessionNotePicker();
      const rememberedPath = this.getRememberedSessionNotePath();
      const nextPath = this.selectedSessionNotePath || rememberedPath || '';
      if (nextPath && this.sessionNoteEntries.some(entry => entry.relativePath === nextPath)) {
        await this.selectSessionNoteByPath(nextPath);
      }
    } catch (error) {
      this.sessionNotesError = await this.tryRecoverSessionNotesVault(error)
        ? 'Vault folder reconnected. Refresh notes.'
        : 'Unable to load session notes.';
      console.error('Failed to load session notes', error);
    } finally {
      this.sessionNotesLoading = false;
    }
  }

  private flattenSessionNoteEntries(entries: VaultEntry[]): VaultEntry[] {
    return entries
      .flatMap(entry => entry.kind === 'directory'
        ? this.flattenSessionNoteEntries(entry.children || [])
        : [entry])
      .filter(entry => this.isMarkdownNote(entry.name))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private isMarkdownNote(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith('.md') || lowerName.endsWith('.markdown');
  }

  private scheduleSessionNoteSave() {
    if (!this.selectedSessionNotePath) {
      return;
    }

    if (this.sessionNotesSaveTimer) {
      clearTimeout(this.sessionNotesSaveTimer);
    }

    this.sessionNotesSaveState = 'saving';
    this.sessionNotesSaveTimer = setTimeout(() => {
      void this.saveSessionNote();
    }, 900);
  }

  private async flushPendingSessionNoteSave() {
    if (!this.sessionNotesSaveTimer) {
      return;
    }

    clearTimeout(this.sessionNotesSaveTimer);
    this.sessionNotesSaveTimer = null;
    await this.saveSessionNote();
  }

  private async saveSessionNote() {
    if (!this.selectedSessionNotePath) {
      return;
    }

    this.sessionNotesSaveTimer = null;
    try {
      this.sessionNotesSaveState = 'saving';
      await this.obsidianVaultService.writeFile(
        this.getSessionNotesServerId(),
        this.selectedSessionNotePath,
        this.selectedSessionNoteContent
      );
      this.sessionNotesSaveState = 'saved';
    } catch (error) {
      this.sessionNotesSaveState = 'error';
      this.sessionNotesError = await this.tryRecoverSessionNotesVault(error)
        ? 'Vault folder reconnected. Save again.'
        : 'Unable to save note.';
      console.error('Failed to save session note', error);
    }
  }

  private async tryRecoverSessionNotesVault(error: unknown): Promise<boolean> {
    if (!String((error as Error)?.message || error).toLowerCase().includes('vault')) {
      return false;
    }

    await this.ensureSessionNotesReady(true);
    return this.sessionNotesPermissionGranted;
  }

  getSessionNotesServerId(): string {
    return this.serverService.getCurrentServer()?._id || '';
  }

  private getSessionNotesStorageKey(): string {
    return `call-session-note:${this.getSessionNotesServerId()}:${this.channelId}`;
  }

  private rememberSelectedSessionNote(path: string) {
    try {
      localStorage.setItem(this.getSessionNotesStorageKey(), path);
    } catch {
      // Non-critical preference.
    }
  }

  private getRememberedSessionNotePath(): string {
    try {
      return localStorage.getItem(this.getSessionNotesStorageKey()) || '';
    } catch {
      return '';
    }
  }

  private getCurrentSessionNotePath(): string {
    return this.selectedSessionNotePath || this.getRememberedSessionNotePath();
  }

  private getDefaultSessionNoteName(): string {
    const date = this.getSessionNoteDate();
    return `Session Notes/Session ${date}.md`;
  }

  private getDefaultBroadcastOverlayNoteName(): string {
    return `Broadcasts/Broadcast ${this.getSessionNoteDateTimeForPath()}.md`;
  }

  private buildSessionNotePath(value: string): string | null {
    const normalized = value
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/[<>:"|?*\x00-\x1F]/g, '-');

    if (!normalized) {
      return null;
    }

    return /\.(md|markdown)$/i.test(normalized) ? normalized : `${normalized}.md`;
  }

  private getSessionNoteTemplateContent(path: string, template: string): string {
    if (template === 'blank') {
      return '';
    }

    const title = this.getSessionNoteDisplayName(path);
    const date = this.getSessionNoteDate();
    return [
      '---',
      `title: ${title}`,
      'tags:',
      '  - session',
      '  - call',
      `date: ${date}`,
      '---',
      '',
      `# ${title}`,
      '',
      '## Recap',
      '',
      '## Scenes',
      '',
      '## NPCs',
      '',
      '## Decisions',
      '',
      '## Items and Rewards',
      '',
      '## Follow Ups',
      ''
    ].join('\n');
  }

  getSessionNoteDisplayName(path: string): string {
    const fileName = path.split('/').pop() || path;
    return fileName.replace(/\.(md|markdown)$/i, '');
  }

  get filteredSessionNoteEntries(): VaultEntry[] {
    const query = this.sessionNotesSearchQuery.trim().toLowerCase();
    if (!query) {
      return this.sessionNoteEntries;
    }

    const terms = query.split(/\s+/).filter(Boolean);
    return this.sessionNoteEntries.filter(note => {
      const text = `${note.relativePath} ${this.getSessionNoteDisplayName(note.relativePath)}`.toLowerCase();
      return terms.every(term => text.includes(term));
    });
  }

  private focusSessionNoteSearch() {
    setTimeout(() => this.sessionNoteSearchInputRef?.nativeElement.focus(), 0);
  }

  getSessionNotesSaveLabel(): string {
    if (this.sessionNotesSaveState === 'saving') return 'Saving';
    if (this.sessionNotesSaveState === 'error') return 'Save failed';
    if (this.selectedSessionNotePath) return 'Saved';
    return 'No note';
  }

  private getSessionNoteDate(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getSessionNoteDateTime(): string {
    const date = new Date();
    const hours = `${date.getHours()}`.padStart(2, '0');
    const minutes = `${date.getMinutes()}`.padStart(2, '0');
    return `${this.getSessionNoteDate()} ${hours}:${minutes}`;
  }

  private getSessionNoteDateTimeForPath(): string {
    return this.getSessionNoteDateTime().replace(':', '-');
  }

  async handleSongRequest(request: any) {
    try {
      await this.spotify.play(request.uri, 0, false, undefined, {
        name: request.name,
        artist: request.artist,
        image: request.image,
        fileName: request.fileName,
        moods: request.moods,
        atmosphere: request.atmosphere
      });
      this.removeRequest(request);
    } catch {
      this.snackBar.open('Could not play that music request.', 'Close', {
        duration: 3000
      });
    }
  }

  removeRequest(request: any) {
      this.spotifyRequests = this.spotifyRequests.filter(r => r !== request);
      this.recordSpotifyRequestsSnapshot();
  }

  canJoinVttSession(): boolean {
    return this.vttSession.active && this.vttSession.hostId !== this.videoService.getCurrentParticipantIdentity();
  }

  canHostVttSession(): boolean {
    return this.isServerOwner && !this.vttSession.active;
  }

  canStopVttSession(): boolean {
    return this.vttSession.active && this.vttSession.hostId === this.videoService.getCurrentParticipantIdentity();
  }

  private getVttRoomId(): string {
    return this.serverService.getCurrentServer()?._id || this.channelId;
  }

  private isHiddenCompanionParticipant(participant: any): boolean {
    const currentUserId = this.authService.getCurrentUserId();
    const metadata = participant?.participantMeta as CallParticipantMetadata | null;
    return metadata?.deviceRole === 'phone-camera' && metadata?.userId === currentUserId;
  }

  private shouldDisplayRemoteParticipant(participant: any): boolean {
    if (this.isMobileCompanionMode) {
      return false;
    }

    const metadata = participant?.participantMeta as CallParticipantMetadata | null;
    if (metadata?.deviceRole === 'phone-camera') {
      return false;
    }

    // Hide trackless placeholders before metadata arrives, but keep subscribed media visible.
    const hasTracks = !!participant?.stream?.getTracks?.().length;
    const hasCharacterName = !!participant?.userData?.name;
    if (!metadata && !hasCharacterName && !hasTracks) {
      return false;
    }

    return !this.isHiddenCompanionParticipant(participant);
  }

  private getCompanionLocalStream(participants: any[]): MediaStream | null {
    const currentUserId = this.authService.getCurrentUserId();
    const currentDeviceType = this.videoService.getCurrentDeviceInfo().deviceType;
    if (!currentUserId || currentDeviceType === 'mobile') return null;

    return this.videoService.getSelectedCompanionVideoStream();
  }

  private observeSceneMainLayoutSize() {
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;

    const element = this.gridContainerRef?.nativeElement;
    if (!element) {
      this.hasSceneMainLayoutSpace = true;
      return;
    }

    const measureLayoutSpace = () => this.updateSceneMainLayoutSpaceFromElement();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(measureLayoutSpace);
    } else {
      setTimeout(measureLayoutSpace);
    }

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    this.gridResizeObserver = new ResizeObserver(() => {
      this.updateSceneMainLayoutSpaceFromElement();
    });
    this.gridResizeObserver.observe(element);
  }

  private updateSceneMainLayoutSpaceFromElement() {
    const element = this.gridContainerRef?.nativeElement;
    if (!element) {
      return;
    }

    const { contentWidthPx, contentHeightPx, hasLayoutSpace: nextHasSpace } =
      measureSceneGridContent(element);
    if (
      this.hasSceneMainLayoutSpace === nextHasSpace &&
      this.sceneGridContentWidthPx === contentWidthPx &&
      this.sceneGridContentHeightPx === contentHeightPx
    ) {
      return;
    }

    this.hasSceneMainLayoutSpace = nextHasSpace;
    this.sceneGridContentWidthPx = contentWidthPx;
    this.sceneGridContentHeightPx = contentHeightPx;
    if (!nextHasSpace) {
      this.closeRemoteContextMenu();
    }
    this.cdr.detectChanges();
  }

  private updateLocalVideoDisplay(participants: any[] = this.videoService.remoteStreams$.value) {
    const displayStream = this.getCompanionLocalStream(participants) || this.localStream;
    if (this.localVideo && displayStream && this.localVideo.nativeElement.srcObject !== displayStream) {
      this.localVideo.nativeElement.srcObject = displayStream;
      void this.applyAudioOutputToAllMedia();
    }
  }

  private async handleCallKickout(reason: string) {
    this.themeService.revertToSaved();
    this.stopSoundCloudCallSyncTimers();
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
    }
    this.localStream = null;
    this.remoteStreams = [];
    this.closeRemoteContextMenu();
    this.teardownAllRemoteAudioOutputs();
    this.showSpotify = false;
    this.stopVtt.emit({ roomId: this.getVttRoomId(), endSession: false });
    this.isDmMode = false;
    this.vttSession = { active: false, roomId: null, hostId: null };
    this.lastAutoSelectedCompanionVideoId = null;
    this.syncPreviewSetupFromLive();

    if (!this.isComponentDestroying) {
      await this.startPreview();
    }

    if (reason === 'phone_requires_desktop') {
      window.alert('Phone companion mode requires an active desktop call for this account.');
    } else if (reason === 'desktop_missing') {
      window.alert('The desktop call ended, so the phone companion session was closed.');
    } else if (reason === 'connection_lost') {
      window.alert('The call connection was lost. Rejoin the call to reconnect audio and video.');
    } else {
      window.alert('This call was disconnected because another device joined with the same account.');
    }
    this.cdr.detectChanges();
  }

  private async ensureMobileMediaAccess() {
    if (this.hasRequestedMobileMedia) return;

    try {
      this.hasRequestedMobileMedia = true;
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      permissionStream.getTracks().forEach(track => track.stop());
      await this.loadDevices();
    } catch (error) {
      this.hasRequestedMobileMedia = false;
      console.error('Mobile browser camera/microphone permission request failed', error);
      window.alert('Camera and microphone access are required to join from a mobile browser. Please allow access and try again.');
      throw error;
    }
  }

  async prepareMobileMedia() {
    if (this.isPreparingMobileMedia) return;

    try {
      this.isPreparingMobileMedia = true;
      this.mobileMediaMessage = 'Requesting camera and microphone access...';
      await this.ensureMobileMediaAccess();
      await this.startPreview();
      this.mobileMediaReady = true;
      this.mobileMediaMessage = '';
    } catch {
      this.mobileMediaReady = false;
      this.mobileMediaMessage = 'Camera and microphone are not ready yet.';
    } finally {
      this.isPreparingMobileMedia = false;
      this.cdr.detectChanges();
    }
  }

  private async restoreStoredMediaPreferences() {
    const preferences = readStoredCallMediaPreferences();
    if (!preferences) {
      return;
    }

    if (typeof preferences.selectedVideoId === 'string') {
      this.selectedVideoId = preferences.selectedVideoId;
    }
    if (typeof preferences.selectedAudioId === 'string') {
      this.selectedAudioId = preferences.selectedAudioId;
    }
    if (typeof preferences.selectedOutputId === 'string') {
      this.selectedOutputId = preferences.selectedOutputId;
    }
    if (isMicrophoneProcessingMode(preferences.microphoneProcessingMode)) {
      this.microphoneProcessingMode = preferences.microphoneProcessingMode;
    }
    if (isRemoteVideoQualityPreference(preferences.remoteVideoQualityPreference)) {
      this.videoService.setRemoteVideoQualityPreference(preferences.remoteVideoQualityPreference);
    }
    if (typeof preferences.isPreviewMuted === 'boolean') {
      this.isPreviewMuted = preferences.isPreviewMuted;
      this.isAudioMuted = preferences.isPreviewMuted;
    }
    if (typeof preferences.isPreviewVideoOff === 'boolean') {
      this.isPreviewVideoOff = preferences.isPreviewVideoOff;
      this.isVideoOff = preferences.isPreviewVideoOff;
    }
    if (typeof preferences.experimentalMobile1080pEnabled === 'boolean') {
      this.experimentalMobile1080pEnabled = preferences.experimentalMobile1080pEnabled;
    }
    if (isMobileCallJoinMode(preferences.mobileJoinMode)) {
      this.mobileJoinMode = preferences.mobileJoinMode;
    }
    if (typeof preferences.selectedPcVideoSource === 'string' && preferences.selectedPcVideoSource) {
      this.selectedPcVideoSource = preferences.selectedPcVideoSource;
      await this.videoService.selectVideoSource(preferences.selectedPcVideoSource);
    }
    if (typeof preferences.selectedPcAudioSource === 'string' && preferences.selectedPcAudioSource) {
      this.selectedPcAudioSource = preferences.selectedPcAudioSource;
      await this.videoService.selectAudioSource(preferences.selectedPcAudioSource);
    }
  }

  private persistMediaPreferences() {
    const preferences: StoredCallMediaPreferences = {
      selectedVideoId: this.selectedVideoId,
      selectedAudioId: this.selectedAudioId,
      selectedOutputId: this.selectedOutputId,
      microphoneProcessingMode: this.microphoneProcessingMode,
      remoteVideoQualityPreference: getRemoteVideoQualityPreference(this.remoteVideoQualityLevel),
      selectedPcVideoSource: this.selectedPcVideoSource,
      selectedPcAudioSource: this.selectedPcAudioSource,
      isPreviewMuted: this.localStream ? this.isAudioMuted : this.isPreviewMuted,
      isPreviewVideoOff: this.localStream ? this.isVideoOff : this.isPreviewVideoOff,
      experimentalMobile1080pEnabled: this.experimentalMobile1080pEnabled,
      mobileJoinMode: this.mobileJoinMode
    };

    writeStoredCallMediaPreferences(preferences);
  }

  private persistCurrentMediaSetupState() {
    const preferences = readStoredCallMediaPreferences() ?? {};
    preferences.isPreviewMuted = this.localStream ? this.isAudioMuted : this.isPreviewMuted;
    preferences.isPreviewVideoOff = this.localStream ? this.isVideoOff : this.isPreviewVideoOff;
    preferences.experimentalMobile1080pEnabled = this.experimentalMobile1080pEnabled;
    preferences.mobileJoinMode = this.mobileJoinMode;
    writeStoredCallMediaPreferences(preferences);
  }

  private applyPreviewSetupToStream() {
    if (!this.previewStream) {
      return;
    }

    this.previewStream.getAudioTracks().forEach(track => (track.enabled = !this.isPreviewMuted));
    this.previewStream.getVideoTracks().forEach(track => (track.enabled = !this.isPreviewVideoOff));
  }

  private syncPreviewSetupFromLive() {
    this.isPreviewMuted = this.isAudioMuted;
    this.isPreviewVideoOff = this.isVideoOff;
    this.persistCurrentMediaSetupState();
  }

  private async replaceActiveMediaStream() {
    this.resetMicTestForCaptureChange();
    const nextStream = await navigator.mediaDevices.getUserMedia(this.buildMediaConstraints());
    await this.applySelectedSourceBandwidthOptimizations(nextStream);

    nextStream.getAudioTracks().forEach(track => (track.enabled = !this.isAudioMuted));
    nextStream.getVideoTracks().forEach(track => (track.enabled = !this.isVideoOff));

    if (this.localStream) {
      const previousLocalStream = this.localStream;
      this.localStream = nextStream;
      try {
        await this.videoService.startProducing(nextStream);
        this.updateLocalVideoDisplay();
        previousLocalStream.getTracks().forEach(track => track.stop());
      } catch (error) {
        this.localStream = previousLocalStream;
        nextStream.getTracks().forEach(track => track.stop());
        throw error;
      }
    } else {
      if (this.previewStream) {
        this.previewStream.getTracks().forEach(track => track.stop());
      }
      this.previewStream = nextStream;
      if (this.previewVideo) {
        this.previewVideo.nativeElement.srcObject = this.previewStream;
      }
    }

    this.syncMicInputMonitor();
    await this.applyAudioOutputToAllMedia();
    this.cdr.detectChanges();
  }

  private async autoSelectCompanionCamera(
    devices: CompanionDeviceOption[],
    previousCompanionIds: Set<string>
  ) {
    if (this.isMobileBrowser || !this.localStream) {
      return;
    }

    const newestVideoCompanion = devices.find(device => device.hasVideo && !previousCompanionIds.has(device.identity));
    if (!newestVideoCompanion) {
      return;
    }

    if (this.selectedPcVideoSource === newestVideoCompanion.identity) {
      this.lastAutoSelectedCompanionVideoId = newestVideoCompanion.identity;
      return;
    }

    if (this.selectedPcVideoSource !== 'desktop-local' && this.selectedPcVideoSource !== this.lastAutoSelectedCompanionVideoId) {
      return;
    }

    this.lastAutoSelectedCompanionVideoId = newestVideoCompanion.identity;
    await this.changePcVideoSource(newestVideoCompanion.identity);
  }

  private configureRemoteAudio(remote: ParticipantStream, video: HTMLVideoElement) {
    const volumePercent = this.getLiveParticipantVolumePercent(remote);
    this.remoteAudioRouter.configureRemoteAudio(remote.id, remote.stream, volumePercent, video, remote.remoteAudioTrack);
  }

  private applyRemoteVolumes() {
    this.remoteStreams.forEach(remote => this.applyRemoteVolume(remote.id, this.getLiveParticipantVolumePercent(remote)));
  }

  private applyRemoteVolume(participantId: string, volumePercent: number) {
    const remoteIndex = this.remoteStreams.findIndex(remote => remote.id === participantId);
    const video = remoteIndex >= 0 ? this.remoteVideos?.get(remoteIndex)?.nativeElement ?? null : null;
    this.remoteAudioRouter.applyRemoteVolume(participantId, volumePercent, video);
  }

  private normalizeRemoteVolume(value: number | string): number {
    return this.normalizeParticipantVolume(value, 200);
  }

  private normalizeParticipantVolume(value: number | string, max: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return 100;
    }

    return Math.min(max, Math.max(0, Math.round(numericValue)));
  }

  private refreshSceneMainCharacterFlags() {
    this.remoteStreams = this.remoteStreams.map(remote => ({
      ...remote,
      isSceneMainCharacter: this.isSceneMainCharacter(remote.id)
    }));
    this.playbackParticipantStreams = this.playbackParticipantStreams.map(remote => ({
      ...remote,
      isSceneMainCharacter: this.isSceneMainCharacter(remote.id)
    }));
  }

  private teardownMissingRemoteAudioOutputs(activeParticipantIds: Set<string>) {
    this.remoteAudioRouter.teardownMissingRemoteAudioOutputs(activeParticipantIds);
  }

  private teardownAllRemoteAudioOutputs() {
    this.remoteAudioRouter.teardownAllRemoteAudioOutputs();
  }

  private async applyAudioOutputToAllMedia() {
    const mediaElements: HTMLMediaElement[] = [];
    if (this.previewVideo?.nativeElement) {
      mediaElements.push(this.previewVideo.nativeElement);
    }
    if (this.localVideo?.nativeElement) {
      mediaElements.push(this.localVideo.nativeElement);
    }
    if (this.micTestAudio?.nativeElement) {
      mediaElements.push(this.micTestAudio.nativeElement);
    }
    this.remoteVideos?.forEach(videoRef => {
      mediaElements.push(videoRef.nativeElement);
    });
    await this.remoteAudioRouter.applyAudioOutputToAllMedia(mediaElements);
  }

  private async applyAudioOutputToMediaElement(element: HTMLMediaElement) {
    await this.remoteAudioRouter.applyAudioOutputToMediaElement(element);
  }

  trackRemoteStream(_: number, remote: ParticipantStream): string {
    return remote.id;
  }

  getConnectionQualityLabel(diagnostics?: ParticipantMediaDiagnostics): string {
    return callDiagnostics.getConnectionQualityLabel(diagnostics);
  }

  getConnectionQualityClass(diagnostics?: ParticipantMediaDiagnostics): string {
    return callDiagnostics.getConnectionQualityClass(diagnostics);
  }

  formatBitrateKbps(value: number | null | undefined): string {
    return callDiagnostics.formatBitrateKbps(value);
  }

  formatPacketLoss(value: number | null | undefined): string {
    return callDiagnostics.formatPacketLoss(value);
  }

  formatJitter(value: number | null | undefined): string {
    return callDiagnostics.formatJitter(value);
  }

  formatResolution(diagnostics?: ParticipantMediaDiagnostics): string {
    return callDiagnostics.formatResolution(diagnostics);
  }

  formatFrameRate(diagnostics?: ParticipantMediaDiagnostics): string {
    return callDiagnostics.formatFrameRate(diagnostics);
  }
}

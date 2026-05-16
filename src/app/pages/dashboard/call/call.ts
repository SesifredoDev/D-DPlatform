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
import { CallParticipantMetadata, CallRecordingParticipant, CompanionDeviceOption, CompanionSourceId, ParticipantMediaDiagnostics, RemoteVideoQualityPreference, Video } from '../../../shared/services/video/video';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { NgForOf, NgIf, AsyncPipe } from '@angular/common';
import { ICharacter } from '../../../shared/models/user/character.model';
import { TabService } from '../../../shared/services/tab/tab-service';
import { SpotifyService } from '../../../shared/services/playlist/spotify.service';
import { ActivatedRoute } from '@angular/router';
import { SpotifyPlayer } from './spotify-player/spotify-player';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PinnedTheme, ThemeColors, ThemeService } from '../../../shared/services/theme/theme.service';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ServerService } from '../../../shared/services/server/server';
import { IServer, TemporaryDmDuration } from '../../../shared/models/server/server.model';
import { MarkdownComponent } from 'ngx-markdown';
import { AuthService } from '../../../shared/services/auth/auth';
import { DeviceService, DeviceType } from '../../../shared/services/device/device';
import { RecordedCallEnvironmentAction, SessionPlaybackState, SessionRecording, SessionRecordingMedia, SessionRecordingParticipantMedia, SessionRecordingService } from '../../../shared/services/session-recording/session-recording';
import { AstralRecordingImportResponse, AstralRecordingService } from '../../../shared/services/astral-recording/astral-recording';
import { AstralPlaybackDropRequest, AstralPlaybackDropService } from '../../../shared/services/astral-recording/astral-playback-drop';
import { AstralOptimizerService } from '../../../shared/services/astral-recording/astral-optimizer';

interface ParticipantStream {
  id: string;
  stream?: MediaStream;
  stillFrameUrl?: string;
  userData?: ICharacter;
  participantMeta?: CallParticipantMetadata | null;
  ping?: number;
  isLocal?: boolean;
  diagnostics?: ParticipantMediaDiagnostics;
  volumePercent: number;
  isSceneMainCharacter: boolean;
}

export interface VttStopEvent {
  roomId: string;
  endSession: boolean;
}

export interface VttPlaybackEvent {
  roomId: string;
  active: boolean;
}

interface VttSessionState {
  active: boolean;
  roomId: string | null;
  hostId: string | null;
}

type MicrophoneProcessingMode = 'studio' | 'processed';
type RemoteVideoQualityLevel = 0 | 1 | 2;

interface StoredCallMediaPreferences {
  selectedVideoId?: string;
  selectedAudioId?: string;
  selectedOutputId?: string;
  microphoneProcessingMode?: MicrophoneProcessingMode;
  remoteVideoQualityPreference?: RemoteVideoQualityPreference;
  selectedPcVideoSource?: CompanionSourceId;
  selectedPcAudioSource?: CompanionSourceId;
  isPreviewMuted?: boolean;
  isPreviewVideoOff?: boolean;
  experimentalMobile1080pEnabled?: boolean;
}

interface RemoteAudioOutput {
  stream: MediaStream;
  audioTrackId: string;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  audioElement: HTMLAudioElement;
}

interface RemoteContextMenuState {
  remoteId: string;
  x: number;
  y: number;
}

interface PriorityGridPlacement {
  row: number;
  column: number;
  columnSpan: number;
}

type CallParticipantRecorderStopReason = 'final' | 'idle' | 'tracks-changed' | 'removed';

interface CallParticipantActivitySample {
  audioLevel: number;
  videoMotion: number;
  active: boolean;
}

interface CallParticipantActivityMonitor {
  getSample: () => CallParticipantActivitySample;
  cleanup: () => void;
}

interface CallParticipantRecorder {
  participantId: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  volumePercent: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAtMs: number;
  stopping: boolean;
  astralSegmentIndex: number | null;
  astralFilePath: string | null;
  astralFileUrl: string | null;
  astralSize: number;
  astralWriteChain: Promise<void>;
  astralWriteFailed: boolean;
  stopReason: CallParticipantRecorderStopReason;
  idleMonitor: CallParticipantActivityMonitor | null;
  idleMonitorInterval: any;
  idleLastActivityAt: number;
  idleTransitionInProgress: boolean;
  pendingIdleStillFrame: Blob | null;
  pendingIdleStillMimeType: string | null;
}

interface CallParticipantIdleState {
  participantId: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  volumePercent: number;
  stream: MediaStream;
  tracksSignature: string;
  startedAtMs: number;
  blob: Blob | null;
  mimeType: string;
  mediaUrl: string | null;
  mediaPath: string | null;
  size: number;
  activityMonitor: CallParticipantActivityMonitor | null;
  activityMonitorInterval: any;
  resuming: boolean;
}

interface CallPlaybackSource {
  participant: SessionRecordingParticipantMedia;
  video: HTMLVideoElement;
  stream: MediaStream | null;
  cleanup: Array<() => void>;
  active: boolean;
  ended: boolean;
}

interface RecordedCallParticipantSnapshot {
  id: string;
  isLocal: boolean;
  userData: Partial<ICharacter> | null;
  participantMeta: CallParticipantMetadata | null;
  ping?: number;
  volumePercent: number;
  isSceneMainCharacter: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
}

interface RecordedSpotifyState {
  uri: string | null;
  name: string;
  artist: string;
  image: string;
  position: number;
  playing: boolean;
  paused: boolean;
  contextUri: string | null;
  shuffle: boolean;
  volumePercent: number;
}

interface RecordedCallEnvironmentState {
  activeColors: ThemeColors;
  activeOverlayImage: string | null;
  activeOverlayText: string | null;
  activeTemporaryAtmosphereBackground: string | null;
  sceneMainCharacterIds: string[];
  isDmMode: boolean;
  vttSession: VttSessionState;
  spotify: RecordedSpotifyState | null;
  spotifyRequests: any[];
  participants: RecordedCallParticipantSnapshot[];
}

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer, MatIconModule, MatTooltipModule, MatMenuModule, MatSnackBarModule, MarkdownComponent]
})
export class Call implements OnInit, OnDestroy, OnChanges {
  private static readonly mediaPreferencesStorageKey = 'd-d-platform.call.media-preferences';
  private static readonly micTestMaxDurationMs = 8000;
  private static readonly minSceneMainLayoutWidthPx = 720;
  private static readonly minSceneMainLayoutHeightPx = 420;
  private static readonly scenePriorityGridColumns = 12;
  private static readonly sceneMainColumnsPerRow = 2;
  private static readonly sceneSideColumnsPerRow = 4;
  private static readonly sceneGridGapPx = 12;
  private static readonly sceneMainMinAspectRatio = 1 / 1;
  private static readonly sceneDefaultMainAreaRatio = 0.5;
  private static readonly sceneExpandedMainAreaRatio = 0.8;
  private static readonly maxThemeSyncPayloadBytes = 60_000;
  private static readonly desktopVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  };
  private static readonly studioAudioConstraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 }
  };
  private static readonly processedAudioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 }
  };
  private static readonly standardMobileVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  };
  private static readonly experimentalMobileVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
  };

  @Input() channelId!: string;
  @Input() character!: ICharacter;

  @Output() hostVtt = new EventEmitter<string>();
  @Output() joinVtt = new EventEmitter<string>();
  @Output() stopVtt = new EventEmitter<string | VttStopEvent>();
  @Output() playbackVtt = new EventEmitter<string | VttPlaybackEvent>();

  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('previewVideo') previewVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('micTestAudio') micTestAudio?: ElementRef<HTMLAudioElement>;
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
  selectedPcVideoSource: CompanionSourceId = 'desktop-local';
  selectedPcAudioSource: CompanionSourceId = 'desktop-local';
  companionDevices: CompanionDeviceOption[] = [];
  readonly microphoneProcessingOptions: ReadonlyArray<{ value: MicrophoneProcessingMode; label: string }> = [
    { value: 'studio', label: 'Studio mic' },
    { value: 'processed', label: 'Voice processed' }
  ];
  readonly remoteVideoQualityOptions: ReadonlyArray<{
    level: RemoteVideoQualityLevel;
    value: RemoteVideoQualityPreference;
    label: string;
  }> = [
    { level: 0, value: 'low', label: 'Data saver' },
    { level: 1, value: 'medium', label: 'Balanced' },
    { level: 2, value: 'high', label: 'Max detail' }
  ];
  readonly supportsMicTestRecording = typeof MediaRecorder !== 'undefined';
  readonly supportsSessionRecording = typeof MediaRecorder !== 'undefined';

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
  isMicTestRecording = false;
  micTestDurationSeconds = 0;
  micTestPlaybackUrl: string | null = null;
  micTestError = '';
  isSessionRecording = false;
  sessionRecordingDurationSeconds = 0;
  sessionRecordingError = '';
  recordedSession: SessionRecording | null = null;
  isCallPlaybackMode = false;
  isSavingAstralRecording = false;
  isTauriDesktop = false;
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

  // Spotify Requests
  spotifyRequests: any[] = [];
  showSpotifyRequests: boolean = false;
  playbackSpotifyState: RecordedSpotifyState | null = null;
  playbackSpotifyVolumePercent = 100;

  // DM Mode State
  isServerOwner: boolean = false;
  canManageTemporaryDms: boolean = false;
  isDmMode: boolean = false;
  temporaryDmDurations: Array<{ duration: TemporaryDmDuration; label: string }> = [
    { duration: 'day', label: 'DM for 1 day' },
    { duration: 'week', label: 'DM for 1 week' },
    { duration: 'month', label: 'DM for 1 month' },
    { duration: 'permanent', label: 'DM permanently' }
  ];
  dmCharacter: ICharacter = {
    _id: 'dm-character-id',
    ownerId: '',
    servers: [],
    name: 'DM',
    race: 'Dungeon Master',
    icon: null,
    baseStats: { strength: 0, dexterity: 0, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
    classes: [{ className: 'Dungeon Master', level: 20 }]
  };

  private streamSub!: Subscription;
  private spotifySyncSub!: Subscription;
  private spotifyActionSub!: Subscription;
  private spotifyStateRequestSub!: Subscription;
  private spotifyRequestSub!: Subscription;
  private syncDebounceTimer: any = null;
  private isSyncing: boolean = false;


  private themeSyncSub!: Subscription;
  private pinnedThemesSub!: Subscription;
  private vttSub!: Subscription;
  private overlaySub!: Subscription;
  private overlayTextSub!: Subscription;
  private temporaryAtmosphereBackgroundSub!: Subscription;
  private serverDetailsSub!: Subscription;
  private callKickedSub!: Subscription;
  private companionDevicesSub!: Subscription;
  private selectedVideoSourceSub!: Subscription;
  private selectedAudioSourceSub!: Subscription;
  private remoteVideoQualitySub!: Subscription;
  private participantVolumesSub!: Subscription;
  private sceneMainCharactersSub!: Subscription;
  private sessionRecordingStateSub!: Subscription;
  private sessionRecordingLastSub!: Subscription;
  private sessionPlaybackSub!: Subscription;
  private astralPlaybackDropSub!: Subscription;
  readonly supportsAudioOutputSelection = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  readonly supportsRemoteAudioGain = typeof window !== 'undefined' && !!this.getAudioContextConstructor();

  private isComponentDestroying = false;
  private lastAutoSelectedCompanionVideoId: string | null = null;
  private micTestRecorder: MediaRecorder | null = null;
  private micTestRecorderStream: MediaStream | null = null;
  private micTestChunks: Blob[] = [];
  private micTestDurationInterval: any;
  private micTestAutoStopTimeout: any;
  private micTestDiscardOnStop = false;
  private micLevelAudioContext: AudioContext | null = null;
  private micLevelAnalyser: AnalyserNode | null = null;
  private micLevelSource: MediaStreamAudioSourceNode | null = null;
  private micLevelStream: MediaStream | null = null;
  private micLevelData: Uint8Array | null = null;
  private micLevelInterval: any;
  private monitoredMicTrack: MediaStreamTrack | null = null;
  private remoteAudioContext: AudioContext | null = null;
  private remoteAudioOutputs = new Map<string, RemoteAudioOutput>();
  private callRecordingStartedAt = 0;
  private callRecordingDurationInterval: any;
  private callRecordingDiscardOnStop = false;
  private callParticipantRecorders = new Map<string, CallParticipantRecorder>();
  private callParticipantIdleStates = new Map<string, CallParticipantIdleState>();
  private stoppingCallParticipantRecorders = 0;
  private finalizingSessionRecording = false;
  private astralRecordingSessionId: string | null = null;
  private astralParticipantSegmentCounters = new Map<string, number>();
  astralRecordingPath: string | null = null;
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
  callPlaybackCurrentTimeMs = 0;
  callPlaybackDurationMs = 0;
  private callPlaybackSources: CallPlaybackSource[] = [];
  private callPlaybackSourcesRecordingId: string | null = null;
  private callPlaybackMediaHost: HTMLDivElement | null = null;
  private visiblePlaybackSourceTargets = new Map<string, HTMLVideoElement>();
  private callPlaybackSyncInterval: any;
  private isSeekingCallPlaybackSources = false;
  private callPlaybackClockStartedAtMs = 0;
  private callPlaybackClockStartTimeMs = 0;
  private visiblePlaybackSyncToken = 0;
  private lastAppliedPlaybackSpotifySignature = '';
  private isImportingAstralPlayback = false;
  private readonly participantIdleThresholdMs = 60000;
  private readonly participantIdleCheckIntervalMs = 250;
  private readonly participantIdleAudioRmsThreshold = 0.012;
  private readonly participantIdleVideoMotionThreshold = 7;
  private readonly participantStillFrameMimeType = 'image/webp';
  private gridContainerRef?: ElementRef<HTMLElement>;
  private gridResizeObserver: ResizeObserver | null = null;
  private readonly handleDeviceChangeBound = () => {
    void this.loadDevices();
  };

  constructor(
    private videoService: Video,
    private tabService: TabService,
    public spotify: SpotifyService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    public themeService: ThemeService,
    private serverService: ServerService,
    private authService: AuthService,
    private deviceService: DeviceService,
    private snackBar: MatSnackBar,
    private sessionRecording: SessionRecordingService,
    private astralRecording: AstralRecordingService,
    private astralOptimizer: AstralOptimizerService,
    private astralPlaybackDrop: AstralPlaybackDropService
  ) {
    this.activeColors = this.themeService.getColors();
    this.rememberValidThemeBackground(this.activeColors);
  }

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['access_token']) {
        this.spotify.setTokens(params['access_token'], params['refresh_token']);
      }

      const forcedDeviceType = this.parseDeviceTypeParam(params['deviceType']);
      if (forcedDeviceType) {
        this.deviceService.setDeviceTypeOverride(forcedDeviceType);
      } else if (params['clearDeviceTypeOverride'] === 'true') {
        this.deviceService.clearDeviceTypeOverride();
      }

      this.isMobileBrowser = this.deviceService.getDeviceType() === 'mobile';
    });
    this.serverDetailsSub = this.serverService.getServerDetailsObservable().subscribe(() => {
      this.checkServerOwner();
      this.cdr.detectChanges();
    });

    this.isMobileBrowser = this.deviceService.getDeviceType() === 'mobile';
    this.isTauriDesktop = await this.astralRecording.isAvailable().catch(() => false);
    this.microphoneProcessingMode = this.isMobileBrowser ? 'processed' : 'studio';
    await this.restoreStoredMediaPreferences();
    this.remoteVideoQualityLevel = this.preferenceToRemoteVideoQualityLevel(
      this.videoService.getRemoteVideoQualityPreference()
    );
    this.maxSceneMainCharacters = this.videoService.getMaxSceneMainCharacters();

    if (!this.isMobileBrowser) {
      await this.loadDevices();
      this.mobileMediaReady = true;
      navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChangeBound);
    }

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

    this.streamSub = this.videoService.remoteStreams$.subscribe(streams => {
      const localParticipantData = streams.find(p => p.isLocal);
      if (localParticipantData) {
        this.localParticipantPing = localParticipantData.ping;
        this.localParticipantDiagnostics = localParticipantData.diagnostics;
      }

      this.refreshVisibleRemoteStreams(streams);
      this.recordCallParticipantsSnapshotIfChanged();
      this.syncCallParticipantRecorders();
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
    });

    // ---------------------------------------------------------
// 1. LISTENER SYNC LOGIC (Strict DJ Mode & Anti-Bounce)
// ---------------------------------------------------------
    this.spotifySyncSub = this.videoService.spotifySync$.subscribe(async (state) => {
      if (!state.uri || !this.localStream) return;

      if (this.isServerOwner) {
        // HOST: Ignore your own auto-polls if you recently clicked something (prevents looping)
        if (state.source === 'auto' && (Date.now() - this.spotify.lastActionTime < 5000)) return;

        // HOST: Completely ignore manual playback commands from standard users
        if (state.source === 'manual' && state.hostId && !this.isAuthorizedDmUserId(state.hostId)) return;
      } else {
        // CLIENT: Only obey the Host
        // Drop the command if it was not stamped by the server owner or active temporary DM.
        if (state.hostId && !this.isAuthorizedDmUserId(state.hostId)) return;

        // Anti-bounce lock: Prevent rapid shuffling while Spotify API is loading the last track
        if (this.isSyncing) return;
        this.isSyncing = true;
      }

      const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload(state);
      if (recordedSpotifyState) {
        this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
      }

      try {
        const currentState = await this.spotify.getPlaybackState();
        const isDifferentTrack = currentState?.track_window?.current_track?.uri !== state.uri;
        const drift = state.timestamp ? (Date.now() - state.timestamp) : 0;
        const adjustedPosition = state.position + (state.paused ? 0 : drift);

        // Tightened sync threshold from 5s to 2s
        const isDifferentPosition = !currentState || Math.abs(currentState.position - adjustedPosition) > 2000;

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
          if (!state.paused) {
            if (isDifferentTrack || isDifferentPosition) {
              await this.spotify.play(state.uri, adjustedPosition, true, state.contextUri);
            } else {
              await this.spotify.togglePlay(true);
            }
          } else {
            if (isDifferentTrack) {
              await this.spotify.play(state.uri, state.position, true, state.contextUri);
              setTimeout(() => this.spotify.pause(true), 1000);
            } else {
              await this.spotify.pause(true);
            }
          }

          if (!isDifferentTrack && isDifferentPosition && !state.paused) {
            await this.spotify.seek(adjustedPosition, true);
          }
        }
      } finally {
        // Release the lock after allowing the Spotify API time to settle
        if (!this.isServerOwner) {
          setTimeout(() => this.isSyncing = false, 1500);
        }
      }
    });


// ---------------------------------------------------------
// 2. ACTION INTERCEPTOR (Debounce Host / Send Requests)
// ---------------------------------------------------------
    this.spotifyActionSub = this.spotify.syncAction$.subscribe((action: any) => {
      if (!this.localStream) return;

      if (this.isServerOwner) {
        // HOST: Debounce outbound network commands to prevent rapid-click API fighting
        if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);

        this.syncDebounceTimer = setTimeout(() => {
          // Stamp the payload with the Host ID so clients know it is authoritative
          const payload = { ...action.data, hostId: this.character.ownerId };
          const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload(payload);
          if (recordedSpotifyState) {
            this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
          }
          this.videoService.sendSpotifyCommand(action.command, payload, action.source);
        }, 400); // 400ms debounce

      } else {
        // CLIENT: Intercept play commands and submit them as Requests instead
        if (action.command === 'play' && action.data?.uri) {
            this.videoService.sendSpotifyRequest({
              uri: action.data.uri,
              name: action.data.name || 'Requested Song',
              artist: action.data.artist || 'Unknown Artist',
              image: action.data.image || '',
            }, this.character.name);
        }
      }
    });


// ---------------------------------------------------------
// 3. STATE REQUEST (Stamp Manual Broadcasts)
// ---------------------------------------------------------
    this.spotifyStateRequestSub = this.videoService.spotifyStateRequest$.subscribe(async (req) => {
      if (this.localStream && this.isServerOwner) {
        const state = await this.spotify.getPlaybackState();
        if (state && state.track_window?.current_track) {
          this.videoService.sendSpotifyCommand('sync', {
            uri: state.track_window.current_track.uri,
            position: state.position,
            paused: state.paused,
            playing: !state.paused,
            contextUri: state.context?.uri,
            shuffle: state.shuffle_state,
            hostId: this.character.ownerId // Embed host ID for validation
          }, 'manual');
          const recordedSpotifyState = this.createRecordedSpotifyStateFromSyncPayload({
            uri: state.track_window.current_track.uri,
            position: state.position,
            paused: state.paused,
            playing: !state.paused,
            contextUri: state.context?.uri,
            shuffle: state.shuffle_state
          });
          if (recordedSpotifyState) {
            this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
          }
        }

        if (this.activeColors) {
          this.safeSendThemeUpdate(this.activeColors);
        }
      }
    });

    this.spotifyRequestSub = this.videoService.spotifyRequest$.subscribe(req => {
      if (this.isServerOwner) {
        // Prevent duplicates
        if (!this.spotifyRequests.some(r => r.uri === req.uri && r.fromName === req.fromName)) {
           this.spotifyRequests.push(req);
           this.recordSpotifyRequestsSnapshot();
           this.cdr.detectChanges();
        }
      }
    });

    this.themeSyncSub = this.videoService.themeSync$.subscribe(colors => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.activeColors = colors;
      this.rememberValidThemeBackground(colors);
      this.themeService.applyTheme(colors, false); // DO NOT save call atmosphere to local player preference
      this.recordCallEnvironmentEvent('theme-sync', colors);
    });

    this.pinnedThemesSub = this.themeService.pinnedThemes$.subscribe(themes => {
      this.pinnedThemes = themes;
      this.cdr.detectChanges();
    });

    this.vttSub = this.videoService.vttSession$.subscribe(session => {
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
    });

    this.overlaySub = this.videoService.overlayImage$.subscribe(url => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.activeOverlayImage = url;
      this.recordCallEnvironmentEvent('overlay-image', { url });
      this.cdr.detectChanges();
    });

    this.overlayTextSub = this.videoService.overlayText$.subscribe(text => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.activeOverlayText = text;
      this.recordCallEnvironmentEvent('overlay-text', { text });
      this.cdr.detectChanges();
    });

    this.temporaryAtmosphereBackgroundSub = this.videoService.temporaryAtmosphereBackground$.subscribe(url => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.activeTemporaryAtmosphereBackground = url;
      this.recordCallEnvironmentEvent('temporary-atmosphere-background', { url });
      this.applyTemporaryAtmosphereBackground(url);
    });

    this.callKickedSub = this.videoService.callKicked$.subscribe(async reason => {
      await this.handleCallKickout(reason);
    });
    this.companionDevicesSub = this.videoService.companionDevices$.subscribe(devices => {
      const previousCompanionIds = new Set(this.companionDevices.map(device => device.identity));
      this.companionDevices = devices;
      void this.autoSelectCompanionCamera(devices, previousCompanionIds);
      this.cdr.detectChanges();
    });
    this.selectedVideoSourceSub = this.videoService.selectedVideoSource$.subscribe(sourceId => {
      this.selectedPcVideoSource = sourceId;
      if (sourceId === 'desktop-local') {
        this.lastAutoSelectedCompanionVideoId = null;
      }
      this.updateLocalVideoDisplay();
      this.cdr.detectChanges();
    });
    this.selectedAudioSourceSub = this.videoService.selectedAudioSource$.subscribe(sourceId => {
      this.selectedPcAudioSource = sourceId;
      this.cdr.detectChanges();
    });
    this.remoteVideoQualitySub = this.videoService.remoteVideoQualityPreference$.subscribe(preference => {
      this.remoteVideoQualityLevel = this.preferenceToRemoteVideoQualityLevel(preference);
      this.cdr.detectChanges();
    });
    this.participantVolumesSub = this.videoService.participantVolumes$.subscribe(() => {
      this.remoteStreams = this.remoteStreams.map(remote => ({
        ...remote,
        volumePercent: this.videoService.getParticipantVolume(remote.id)
      }));
      this.applyRemoteVolumes();
      this.cdr.detectChanges();
    });
    this.sceneMainCharactersSub = this.videoService.sceneMainCharacters$.subscribe(state => {
      if (this.isCallPlaybackMode && !this.isApplyingCallPlaybackEnvironment) {
        return;
      }
      this.sceneMainCharacterIds = state.participantIds;
      this.refreshSceneMainCharacterFlags();
      this.recordCallEnvironmentEvent('scene-main-characters', state);
      this.cdr.detectChanges();
    });
    this.sessionRecordingStateSub = this.sessionRecording.recordingState$.subscribe(state => {
      this.isSessionRecording = state.active;
      this.sessionRecordingDurationSeconds = Math.floor(state.elapsedMs / 1000);
      this.cdr.detectChanges();
    });
    this.sessionRecordingLastSub = this.sessionRecording.lastRecording$.subscribe(recording => {
      this.recordedSession = recording;
      this.cdr.detectChanges();
    });
    this.sessionPlaybackSub = this.sessionRecording.playbackState$.subscribe(state => {
      this.applyCallPlaybackState(state);
    });
    this.astralPlaybackDropSub = this.astralPlaybackDrop.requests$.subscribe(request => {
      if (request.channelId !== this.channelId) {
        return;
      }

      this.promptAstralPlaybackRequest(request);
    });

    this.checkServerOwner();
    this.cdr.detectChanges();



  }

  checkServerOwner(){
    const server = this.serverService.getCurrentServer();
    const serverOwnerId = server ? this.extractOwnerId(server) : '';
    const currentUserId = this.character?.ownerId || '';
    const dmControllerUserIds = server ? this.getActiveDmUserIds(server) : [];

    this.videoService.setSceneMainCharacterControllerUserIds(dmControllerUserIds);
    this.canManageTemporaryDms = !!serverOwnerId && serverOwnerId === currentUserId;
    this.isServerOwner = this.serverService.canUserDm(server, currentUserId);

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

  private buildVideoConstraints(): MediaTrackConstraints {
    const baseConstraints = this.getPreferredVideoConstraints();

    if (this.selectedVideoId) {
      return {
        ...baseConstraints,
        deviceId: { exact: this.selectedVideoId }
      };
    }

    return baseConstraints;
  }

  private getPreferredVideoConstraints(): MediaTrackConstraints {
    if (this.isMobileBrowser) {
      return this.experimentalMobile1080pEnabled
        ? Call.experimentalMobileVideoConstraints
        : Call.standardMobileVideoConstraints;
    }

    return Call.desktopVideoConstraints;
  }

  private buildAudioConstraints(): MediaTrackConstraints {
    const baseConstraints = this.microphoneProcessingMode === 'studio'
      ? Call.studioAudioConstraints
      : Call.processedAudioConstraints;

    if (this.selectedAudioId) {
      return {
        ...baseConstraints,
        deviceId: { exact: this.selectedAudioId }
      };
    }

    return baseConstraints;
  }

  private buildMediaConstraints(): MediaStreamConstraints {
    return {
      video: this.buildVideoConstraints(),
      audio: this.buildAudioConstraints()
    };
  }

  async loadDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');
      this.audioOutputDevices = devices.filter(d => d.kind === 'audiooutput');

      this.selectedVideoId = this.resolveAvailableDeviceId(this.videoDevices, this.selectedVideoId);
      this.selectedAudioId = this.resolveAvailableDeviceId(this.audioDevices, this.selectedAudioId);
      this.selectedOutputId = this.resolveAvailableDeviceId(this.audioOutputDevices, this.selectedOutputId);
      this.mobileMediaReady = true;
      this.mobileMediaMessage = '';
      await this.applyAudioOutputToAllMedia();
    } catch (err) {
      console.warn('Media device access partially or fully denied', err);
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
    if (this.localStream) {
      await this.replaceActiveMediaStream();
      return;
    }

    await this.startPreview();
  }

  async onMicrophoneProcessingChange() {
    this.persistMediaPreferences();
    if (!this.localStream && !this.previewStream && this.isMobileBrowser && !this.mobileMediaReady) {
      return;
    }

    await this.onDeviceChange();
  }

  get hasMicTestSource(): boolean {
    const track = this.getActiveMicTrack();
    return !!track && track.readyState === 'live';
  }

  get canRunMicTest(): boolean {
    const track = this.getActiveMicTrack();
    return this.supportsMicTestRecording && !!track && track.readyState === 'live' && track.enabled;
  }

  get micInputLevelPercent(): number {
    return Math.round(this.micInputLevel * 100);
  }

  get micTestStatusText(): string {
    if (this.micTestError) {
      return this.micTestError;
    }

    if (!this.hasMicTestSource) {
      return 'Microphone unavailable';
    }

    if (this.isMicTestRecording) {
      return `Recording ${this.micTestDurationSeconds}s`;
    }

    if (!this.canRunMicTest) {
      return 'Unmute microphone to test';
    }

    if (this.micTestPlaybackUrl) {
      return 'Sample ready';
    }

    return 'Ready';
  }

  startMicTestRecording() {
    if (this.isMicTestRecording) {
      return;
    }

    this.micTestError = '';
    if (!this.supportsMicTestRecording) {
      this.micTestError = 'Mic test unsupported here';
      return;
    }

    const track = this.getActiveMicTrack();
    if (!track || track.readyState !== 'live') {
      this.micTestError = 'Microphone unavailable';
      return;
    }

    if (!track.enabled) {
      this.micTestError = 'Unmute microphone to test';
      return;
    }

    this.clearMicTestSample();
    this.stopMicTestRecording(true);
    this.micTestDiscardOnStop = false;
    this.micTestChunks = [];
    this.micTestRecorderStream = new MediaStream([track]);

    try {
      const mimeType = this.getSupportedMicTestMimeType();
      this.micTestRecorder = mimeType
        ? new MediaRecorder(this.micTestRecorderStream, { mimeType })
        : new MediaRecorder(this.micTestRecorderStream);
    } catch (error) {
      console.error('Failed to start mic test recorder', error);
      this.micTestError = 'Mic test unavailable';
      this.cleanupMicTestRecorder();
      return;
    }

    this.micTestRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        this.micTestChunks.push(event.data);
      }
    };

    this.micTestRecorder.onerror = event => {
      console.error('Mic test recorder error', event);
      this.micTestError = 'Mic test failed';
      this.cleanupMicTestRecorder();
      this.cdr.detectChanges();
    };

    this.micTestRecorder.onstop = () => {
      const discardSample = this.micTestDiscardOnStop;
      const chunks = [...this.micTestChunks];
      const mimeType = this.micTestRecorder?.mimeType || this.getSupportedMicTestMimeType() || 'audio/webm';

      this.cleanupMicTestRecorder();

      if (!discardSample) {
        if (chunks.length > 0) {
          this.micTestPlaybackUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
          setTimeout(() => {
            void this.applyAudioOutputToAllMedia();
            const audioElement = this.micTestAudio?.nativeElement;
            if (audioElement) {
              audioElement.load();
              void audioElement.play().catch(() => undefined);
            }
          });
        } else {
          this.micTestError = 'No audio captured';
        }
      }

      this.cdr.detectChanges();
    };

    try {
      this.micTestRecorder.start(250);
    } catch (error) {
      console.error('Failed to run mic test recorder', error);
      this.micTestError = 'Mic test failed';
      this.cleanupMicTestRecorder();
      return;
    }

    this.isMicTestRecording = true;
    this.micTestDurationSeconds = 0;
    const startedAt = Date.now();
    this.micTestDurationInterval = setInterval(() => {
      this.micTestDurationSeconds = Math.min(
        Math.ceil((Date.now() - startedAt) / 1000),
        Math.ceil(Call.micTestMaxDurationMs / 1000)
      );
      this.cdr.detectChanges();
    }, 200);
    this.micTestAutoStopTimeout = setTimeout(() => {
      this.stopMicTestRecording();
    }, Call.micTestMaxDurationMs);
  }

  stopMicTestRecording(discardSample: boolean = false) {
    if (!this.micTestRecorder) {
      return;
    }

    this.micTestDiscardOnStop = this.micTestDiscardOnStop || discardSample;
    this.clearMicTestTimers();
    if (this.micTestRecorder.state !== 'inactive') {
      this.micTestRecorder.stop();
    } else {
      this.cleanupMicTestRecorder();
    }
  }

  clearMicTestSample() {
    const audioElement = this.micTestAudio?.nativeElement;
    if (audioElement) {
      audioElement.pause();
      audioElement.removeAttribute('src');
      audioElement.load();
    }

    if (this.micTestPlaybackUrl) {
      URL.revokeObjectURL(this.micTestPlaybackUrl);
      this.micTestPlaybackUrl = null;
    }
  }

  private getActiveMicTrack(): MediaStreamTrack | null {
    return this.localStream?.getAudioTracks()[0]
      || this.previewStream?.getAudioTracks()[0]
      || null;
  }

  private getSupportedMicTestMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return null;
    }

    const supportedMimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ].find(type => MediaRecorder.isTypeSupported(type));

    return supportedMimeType || null;
  }

  private resetMicTestForCaptureChange() {
    this.micTestError = '';
    this.stopMicTestRecording(true);
    this.clearMicTestSample();
    this.stopMicInputMonitor();
  }

  private clearMicTestTimers() {
    if (this.micTestDurationInterval) {
      clearInterval(this.micTestDurationInterval);
      this.micTestDurationInterval = null;
    }

    if (this.micTestAutoStopTimeout) {
      clearTimeout(this.micTestAutoStopTimeout);
      this.micTestAutoStopTimeout = null;
    }
  }

  private cleanupMicTestRecorder() {
    this.clearMicTestTimers();
    this.isMicTestRecording = false;
    this.micTestDurationSeconds = 0;
    this.micTestChunks = [];
    this.micTestRecorder = null;
    this.micTestRecorderStream = null;
    this.micTestDiscardOnStop = false;
  }

  get sessionRecordingStatusText(): string {
    if (this.sessionRecordingError) {
      return this.sessionRecordingError;
    }

    if (!this.canUseSessionRecording) {
      return 'Recording only available in the desktop app';
    }

    if (this.isSessionRecording) {
      const storageLabel = this.astralRecordingSessionId ? ' locally' : '';
      return `Recording${storageLabel} ${this.formatSessionRecordingDuration(this.sessionRecordingDurationSeconds * 1000)}`;
    }

    if (this.hasRecordedSessionPlayback) {
      const packageLabel = this.recordedSession?.package ? ' saved as .astral' : '';
      return `Last recording ${this.formatSessionRecordingDuration(this.recordedSessionDurationMs)}${packageLabel}`;
    }

    return 'Record call and VTT';
  }

  get hasRecordedSessionPlayback(): boolean {
    return !!this.recordedSession && this.hasPlayableCallRecording(this.recordedSession);
  }

  get canUseSessionRecording(): boolean {
    return this.supportsSessionRecording && this.isTauriDesktop;
  }

  get showDmRecordingToolbar(): boolean {
    return this.isServerOwner && this.isTauriDesktop && (!!this.localStream || this.isCallPlaybackMode);
  }

  get canSaveAstralRecording(): boolean {
    return !!this.recordedSession?.package?.path && !this.isSavingAstralRecording;
  }

  get isAstralPlaybackImporting(): boolean {
    return this.isImportingAstralPlayback;
  }

  get isPlaybackVttLive(): boolean {
    return !!this.activePlaybackVttRoomId;
  }

  get recordedSessionDurationMs(): number {
    return this.getRecordingPlaybackDurationMs(this.recordedSession);
  }

  async startSessionRecording() {
    if (this.isSessionRecording || this.callParticipantRecorders.size) {
      return;
    }

    if (this.isCallPlaybackMode) {
      this.stopSessionPlayback();
    }

    this.sessionRecordingError = '';
    if (!this.canUseSessionRecording) {
      this.sessionRecordingError = 'Recording is only available in the Tauri desktop app';
      return;
    }

    if (!this.localStream) {
      this.sessionRecordingError = 'Join the call first';
      return;
    }

    if (!this.sessionRecording.startRecording(this.getVttRoomId())) {
      this.sessionRecordingError = 'Recording already active';
      return;
    }

    this.astralRecordingPath = null;
    this.astralRecordingSessionId = null;
    this.astralParticipantSegmentCounters.clear();
    this.lastRecordedCallParticipantsSnapshot = '';
    this.callRecordingStartedAt = Date.now();
    this.recordCurrentCallEnvironmentInitialState();
    void this.recordCurrentSpotifyPlaybackState();
    this.callParticipantRecorders.clear();
    this.callParticipantIdleStates.clear();
    this.stoppingCallParticipantRecorders = 0;
    this.finalizingSessionRecording = false;
    this.callRecordingDiscardOnStop = false;

    await this.startAstralRecordingSession();
    if (!this.sessionRecording.isRecording() || this.finalizingSessionRecording) {
      await this.abortAstralRecordingSession();
      return;
    }

    this.syncCallParticipantRecorders();
    if (!this.callParticipantRecorders.size) {
      this.sessionRecordingError = 'No participant streams to record';
      await this.abortAstralRecordingSession();
      this.sessionRecording.abortRecording();
      this.cleanupCallParticipantRecorders();
      return;
    }

    this.callRecordingDurationInterval = setInterval(() => {
      this.sessionRecordingDurationSeconds = Math.floor((Date.now() - this.callRecordingStartedAt) / 1000);
      this.cdr.detectChanges();
    }, 500);
  }

  stopSessionRecording(discardRecording: boolean = false) {
    if (!this.sessionRecording.isRecording() && !this.callParticipantRecorders.size && !this.callParticipantIdleStates.size) {
      return;
    }

    this.callRecordingDiscardOnStop = this.callRecordingDiscardOnStop || discardRecording;
    this.finalizingSessionRecording = true;
    this.clearCallRecordingTimer();
    this.endAllCallParticipantIdleStates(!this.callRecordingDiscardOnStop);
    if (!this.callParticipantRecorders.size) {
      void this.finishSessionRecordingIfReady();
      return;
    }

    this.stopAllCallParticipantRecorders();
    void this.finishSessionRecordingIfReady();
  }

  async saveAstralRecording(recording: SessionRecording | null = this.recordedSession) {
    if (this.isSavingAstralRecording) {
      return;
    }

    const packagePath = recording?.package?.path;
    if (!packagePath) {
      this.snackBar.open('This recording does not have a saved .astral package. Record in the Tauri desktop app to create one.', 'Close', { duration: 5000 });
      return;
    }

    this.isSavingAstralRecording = true;
    try {
      const result = await this.astralRecording.exportPackage(packagePath);
      this.snackBar.open(`Saved .astral recording to ${result.savedPath}`, 'Close', { duration: 6000 });
    } catch (error) {
      console.error('Failed to save Astral recording package', error);
      this.snackBar.open('Could not save the .astral recording.', 'Close', { duration: 4000 });
    } finally {
      this.isSavingAstralRecording = false;
      this.cdr.detectChanges();
    }
  }

  private promptAstralPlaybackRequest(request: AstralPlaybackDropRequest) {
    if (this.isSessionRecording) {
      this.snackBar.open('Stop recording before playing an .astral file.', 'Close', {
        duration: 4000
      });
      return;
    }

    if (this.isImportingAstralPlayback) {
      this.snackBar.open('An .astral recording is already loading.', 'Close', {
        duration: 3000
      });
      return;
    }

    const filename = request.filename || request.file?.name || 'dropped .astral recording';
    this.pendingAstralPlaybackRequest = request;
    this.pendingAstralPlaybackFilename = filename;
    this.pendingAstralPlaybackRequiresDisconnect = this.hasActiveLiveCallConnection();
    this.cdr.detectChanges();
  }

  cancelAstralPlaybackPrompt() {
    this.clearAstralPlaybackPrompt();
  }

  confirmAstralPlaybackPrompt() {
    const request = this.pendingAstralPlaybackRequest;
    if (!request || this.isImportingAstralPlayback) {
      return;
    }

    const shouldDisconnect = this.pendingAstralPlaybackRequiresDisconnect || this.hasActiveLiveCallConnection();
    this.clearAstralPlaybackPrompt();
    if (shouldDisconnect) {
      void this.disconnectAndPlayAstralRequest(request);
      return;
    }

    void this.importAndPlayAstralRequest(request);
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
    if (this.hasActiveLiveCallConnection()) {
      await this.leaveCall();
    }

    await this.importAndPlayAstralRequest(request);
  }

  private async importAndPlayAstralRequest(request: AstralPlaybackDropRequest) {
    if (this.isImportingAstralPlayback) {
      return;
    }

    this.isImportingAstralPlayback = true;
    this.sessionRecordingError = '';
    const loadingRef = this.snackBar.open('Loading .astral recording...', 'Close');

    try {
      if (this.isCallPlaybackMode) {
        this.stopSessionPlayback();
      }

      const imported = request.file
        ? await this.astralRecording.importPackageFile(request.file)
        : request.url
          ? await this.astralRecording.importPackageFromUrl(request.url, request.filename)
          : null;
      if (!imported) {
        this.sessionRecordingError = 'No .astral recording source found';
        this.snackBar.open(this.sessionRecordingError, 'Close', { duration: 4000 });
        return;
      }

      const recording = await this.createSessionRecordingFromAstralImport(imported);
      if (!this.hasPlayableCallRecording(recording)) {
        this.sessionRecordingError = 'Imported .astral file has no playable media';
        this.snackBar.open(this.sessionRecordingError, 'Close', { duration: 5000 });
        return;
      }

      const loadedRecording = this.sessionRecording.loadRecording(recording);
      this.recordedSession = loadedRecording;
      this.startSessionPlayback(loadedRecording);
    } catch (error) {
      console.error('Failed to import Astral recording', error);
      this.sessionRecordingError = 'Could not load the .astral recording';
      this.snackBar.open(this.sessionRecordingError, 'Close', {
        duration: 5000
      });
    } finally {
      loadingRef.dismiss();
      this.isImportingAstralPlayback = false;
      this.cdr.detectChanges();
    }
  }

  private async createSessionRecordingFromAstralImport(imported: AstralRecordingImportResponse): Promise<SessionRecording> {
    const manifest = imported.manifest ?? {};
    const sourceRecording = manifest.recording ?? manifest;
    const participantMedia = await this.createImportedAstralParticipantMedia(imported, sourceRecording.participantMedia);
    const durationMs = this.getImportedRecordingDurationMs(sourceRecording, participantMedia);

    return {
      id: `${sourceRecording.id || 'astral-recording'}:${imported.sessionId}`,
      callRoomId: sourceRecording.callRoomId ?? null,
      startedAt: sourceRecording.startedAt ?? manifest.packagedAt ?? new Date().toISOString(),
      endedAt: sourceRecording.endedAt ?? null,
      durationMs,
      media: await this.createImportedAstralMedia(imported, sourceRecording.media),
      participantMedia,
      package: {
        storage: 'astral',
        path: imported.packagePath,
        size: imported.packageSize,
        formatVersion: Number(manifest.formatVersion) || 1,
        createdAt: manifest.packagedAt ?? new Date().toISOString()
      },
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

      const startedAtMs = this.toFiniteRecordingNumber(participant.startedAtMs, 0);
      const endedAtMs = this.toFiniteRecordingNumber(participant.endedAtMs, startedAtMs + media.durationMs);
      return {
        participantId: String(participant.participantId),
        isLocal: !!participant.isLocal,
        userData: participant.userData ?? null,
        participantMeta: participant.participantMeta ?? null,
        volumePercent: this.normalizeParticipantPlaybackVolume(participant.volumePercent),
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
      durationMs: this.toFiniteRecordingNumber(mediaManifest.durationMs, 0),
      size: this.toFiniteRecordingNumber(mediaManifest.size, 0),
      path: mediaPath
    };
  }

  private getImportedRecordingDurationMs(sourceRecording: any, participantMedia: SessionRecordingParticipantMedia[]): number {
    const participantDurationMs = participantMedia.reduce(
      (durationMs, participant) => Math.max(durationMs, participant.endedAtMs),
      0
    );

    return Math.max(this.toFiniteRecordingNumber(sourceRecording?.durationMs, 0), participantDurationMs);
  }

  private toFiniteRecordingNumber(value: unknown, fallback: number): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, numericValue) : fallback;
  }

  private normalizeParticipantPlaybackVolume(volumePercent: unknown): number {
    const numericValue = Number(volumePercent);
    if (!Number.isFinite(numericValue)) {
      return 100;
    }

    return Math.min(200, Math.max(0, Math.round(numericValue)));
  }

  private async startAstralRecordingSession() {
    try {
      if (!(await this.astralRecording.isAvailable())) {
        return;
      }

      const session = await this.astralRecording.begin(this.getVttRoomId());
      this.astralRecordingSessionId = session.sessionId;
    } catch (error) {
      console.warn('Astral local recording storage unavailable; falling back to in-memory recording.', error);
      this.astralRecordingSessionId = null;
      this.astralParticipantSegmentCounters.clear();
    }
  }

  private async abortAstralRecordingSession() {
    const sessionId = this.astralRecordingSessionId;
    this.cleanupAstralRecordingState();
    if (!sessionId) {
      return;
    }

    await this.astralRecording.abort(sessionId).catch(error => {
      console.warn('Failed to abort Astral recording session', error);
    });
  }

  private async finalizeAstralRecordingSession(recording: SessionRecording): Promise<boolean> {
    const sessionId = this.astralRecordingSessionId;
    this.cleanupAstralRecordingState();
    if (!sessionId) {
      return false;
    }

    try {
      const packageResult = await this.astralRecording.finalize(sessionId, this.createAstralRecordingManifest(recording));
      this.astralRecordingPath = packageResult.astralPath;
      this.sessionRecording.attachRecordingPackage(recording.id, {
        storage: 'astral',
        path: packageResult.astralPath,
        size: packageResult.astralSize,
        formatVersion: 1,
        createdAt: new Date().toISOString()
      });
      void this.astralOptimizer.optimizeRecordingPackage(recording.id, packageResult.astralPath);
      return true;
    } catch (error) {
      console.error('Failed to finalize Astral recording package', error);
      this.sessionRecordingError = 'Recording playable, but .astral packaging failed';
      return false;
    }
  }

  private cleanupAstralRecordingState() {
    this.astralRecordingSessionId = null;
    this.astralParticipantSegmentCounters.clear();
  }

  startSessionPlayback(recording: SessionRecording | null = this.recordedSession) {
    this.sessionRecordingError = '';
    if (this.isSessionRecording) {
      this.sessionRecordingError = 'Stop recording before playback';
      return;
    }

    if (!recording || !this.hasPlayableCallRecording(recording)) {
      this.sessionRecordingError = 'No recording ready';
      return;
    }

    this.clearSpotifyPlaybackForSessionStart();
    if (!this.sessionRecording.startPlayback(recording)) {
      this.sessionRecordingError = 'No recording ready';
      return;
    }

    this.setCallPlaybackPaused(false);
  }

  private clearSpotifyPlaybackForSessionStart() {
    this.playbackSpotifyState = null;
    this.lastAppliedPlaybackSpotifySignature = '';
    void this.spotify.clearCurrentPlayback(true);
  }

  stopSessionPlayback() {
    this.pauseCallPlaybackSources();
    this.sessionRecording.stopPlayback();
  }

  onCallPlaybackEnded() {
    this.pauseCallPlaybackSources();
    this.sessionRecording.setPlaybackTime(this.callPlaybackDurationMs, true);
  }

  openSessionPlaybackVtt(recording: SessionRecording | null = this.recordedSession) {
    const roomId = this.activePlaybackVttRoomId || recording?.vtt.roomId || this.getVttRoomId();
    if (!this.activePlaybackVttRoomId && this.isCallPlaybackMode) {
      this.sessionRecordingError = 'VTT replay is not live at this point';
      return;
    }

    this.playbackVtt.emit(roomId);
  }

  formatSessionRecordingDuration(durationMs: number | null | undefined): string {
    const totalSeconds = Math.max(0, Math.floor((durationMs ?? 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private applyCallPlaybackState(state: SessionPlaybackState) {
    const nextPlaybackMode = state.active && this.hasPlayableCallRecording(state.recording);

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

    if (nextPlaybackMode) {
      this.prepareCallPlaybackSources(state.recording!);
      this.syncCallPlaybackSourcesToState(state);
      this.applyCallPlaybackEnvironment(state);
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
      this.resetCallPlaybackEnvironment(recording);
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
    return this.callPlaybackRecordingId !== recording.id || currentTimeMs < this.callPlaybackLastTimeMs;
  }

  private resetCallPlaybackEnvironment(recording: SessionRecording) {
    this.callPlaybackRecordingId = recording.id;
    this.callPlaybackEnvironmentEventIndex = 0;
    this.callPlaybackLastTimeMs = 0;
    this.callPlaybackParticipantSnapshots.clear();

    const initialState = recording.callEnvironment?.initialState as RecordedCallEnvironmentState | null;
    if (initialState) {
      this.applyCallEnvironmentState(initialState);
    }
  }

  private resetCallPlaybackEnvironmentTimeline() {
    this.callPlaybackRecordingId = null;
    this.callPlaybackEnvironmentEventIndex = 0;
    this.callPlaybackLastTimeMs = 0;
  }

  private restoreCallEnvironmentAfterPlayback() {
    if (!this.callEnvironmentBeforePlayback) {
      return;
    }

    this.applyCallEnvironmentState(this.callEnvironmentBeforePlayback);
    this.callEnvironmentBeforePlayback = null;
  }

  private applyCallEnvironmentEvent(event: { action: RecordedCallEnvironmentAction; data: any }) {
    const data = event.data;
    this.isApplyingCallPlaybackEnvironment = true;
    try {
      switch (event.action) {
        case 'theme-sync':
          this.applyRecordedTheme(data);
          break;
        case 'overlay-image':
          this.activeOverlayImage = data?.url ?? data ?? null;
          break;
        case 'overlay-text':
          this.activeOverlayText = data?.text ?? data ?? null;
          break;
        case 'temporary-atmosphere-background':
          this.activeTemporaryAtmosphereBackground = data?.url ?? data ?? null;
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
        case 'spotify-state':
          this.applyRecordedSpotifyState(data);
          break;
        case 'spotify-requests':
          this.spotifyRequests = this.cloneSpotifyRequests(data);
          break;
      }
    } finally {
      this.isApplyingCallPlaybackEnvironment = false;
    }
  }

  private applyCallEnvironmentState(state: RecordedCallEnvironmentState) {
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
      this.applyRecordedSpotifyState(state.spotify);
      this.spotifyRequests = this.cloneSpotifyRequests(state.spotifyRequests);
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
    const track = this.spotify.currentTrack$.value;
    if (!track?.uri) {
      return null;
    }

    return this.createRecordedSpotifyState({
      uri: track.uri,
      name: track.name,
      artist: this.getSpotifyTrackArtist(track),
      image: this.getSpotifyTrackImage(track),
      position: 0,
      playing: !this.spotify.isPaused$.value,
      paused: this.spotify.isPaused$.value,
      contextUri: null,
      shuffle: this.spotify.shuffleState$.value,
      volumePercent: this.getCurrentSpotifyVolumePercent()
    });
  }

  private createRecordedSpotifyStateFromSyncPayload(payload: any): RecordedSpotifyState | null {
    const currentTrack = this.spotify.currentTrack$.value;
    const uri = payload?.uri ?? currentTrack?.uri ?? null;
    if (!uri) {
      return null;
    }

    const payloadTrack = {
      uri,
      name: payload?.name,
      artist: payload?.artist,
      image: payload?.image,
      album: payload?.album,
      artists: payload?.artists
    };

    return this.createRecordedSpotifyState({
      uri,
      name: payloadTrack.name ?? currentTrack?.name,
      artist: this.getSpotifyTrackArtist(payloadTrack) || this.getSpotifyTrackArtist(currentTrack),
      image: this.getSpotifyTrackImage(payloadTrack) || this.getSpotifyTrackImage(currentTrack),
      position: payload?.position,
      playing: this.getSpotifyPlayingFromPayload(payload),
      paused: this.getSpotifyPausedFromPayload(payload),
      contextUri: payload?.contextUri ?? null,
      shuffle: payload?.shuffle,
      volumePercent: payload?.volumePercent ?? this.getCurrentSpotifyVolumePercent()
    });
  }

  private createRecordedSpotifyState(state: Partial<RecordedSpotifyState>): RecordedSpotifyState {
    const paused = state.paused === undefined
      ? state.playing === undefined ? true : !state.playing
      : !!state.paused;

    return {
      uri: state.uri ?? null,
      name: state.name ?? 'Spotify',
      artist: state.artist ?? '',
      image: state.image ?? '',
      position: Math.max(0, Number(state.position) || 0),
      playing: !paused,
      paused,
      contextUri: state.contextUri ?? null,
      shuffle: !!state.shuffle,
      volumePercent: this.normalizeSpotifyVolume(state.volumePercent ?? this.getCurrentSpotifyVolumePercent())
    };
  }

  private applyRecordedSpotifyState(state: Partial<RecordedSpotifyState> | null | undefined) {
    if (!state?.uri) {
      this.playbackSpotifyState = null;
      this.lastAppliedPlaybackSpotifySignature = '';
      return;
    }

    this.playbackSpotifyState = this.createRecordedSpotifyState(state);
    this.playbackSpotifyVolumePercent = this.playbackSpotifyState.volumePercent;
    this.syncSpotifyPlayerToPlaybackState(this.playbackSpotifyState);
  }

  private getSpotifyTrackArtist(track: any): string {
    if (!track) {
      return '';
    }

    if (track.artist) {
      return track.artist;
    }

    if (Array.isArray(track.artists)) {
      return track.artists.map((artist: any) => artist?.name).filter(Boolean).join(', ');
    }

    return '';
  }

  private getSpotifyTrackImage(track: any): string {
    return track?.image
      ?? track?.album?.images?.[0]?.url
      ?? track?.images?.[0]?.url
      ?? '';
  }

  private getSpotifyPausedFromPayload(payload: any): boolean {
    if (payload?.paused !== undefined) {
      return !!payload.paused;
    }

    if (payload?.playing !== undefined) {
      return !payload.playing;
    }

    if (payload?.isPlaying !== undefined) {
      return !payload.isPlaying;
    }

    return this.spotify.isPaused$.value;
  }

  private getSpotifyPlayingFromPayload(payload: any): boolean {
    return !this.getSpotifyPausedFromPayload(payload);
  }

  private getCurrentSpotifyVolumePercent(): number {
    const devices = this.spotify.devices$.value ?? [];
    const activeDeviceId = this.spotify.activeDeviceId$.value;
    const activeDevice = devices.find(device => device.id === activeDeviceId) ?? devices.find(device => device.is_active);
    return this.normalizeSpotifyVolume(activeDevice?.volume_percent ?? this.playbackSpotifyVolumePercent ?? 100);
  }

  private normalizeSpotifyVolume(value: number | string | null | undefined): number {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  setPlaybackSpotifyVolume(value: number | string) {
    const volumePercent = this.normalizeSpotifyVolume(value);
    this.playbackSpotifyVolumePercent = volumePercent;
    if (this.playbackSpotifyState) {
      this.playbackSpotifyState = {
        ...this.playbackSpotifyState,
        volumePercent
      };
    }
    void this.spotify.setVolume(volumePercent / 100);
  }

  private syncSpotifyPlayerToPlaybackState(state: RecordedSpotifyState) {
    if (!this.isCallPlaybackMode || this.isRestoringCallPlaybackEnvironment || !state.uri) {
      return;
    }

    const signature = [
      state.uri,
      state.playing ? 'playing' : 'paused',
      Math.floor(state.position / 1000),
      state.contextUri ?? '',
      state.volumePercent
    ].join('|');
    if (signature === this.lastAppliedPlaybackSpotifySignature) {
      return;
    }

    this.lastAppliedPlaybackSpotifySignature = signature;
    void this.spotify.setVolume(state.volumePercent / 100);
    if (state.playing) {
      void this.spotify.play(state.uri, state.position, true, state.contextUri ?? undefined);
      return;
    }

    void this.spotify.play(state.uri, state.position, true, state.contextUri ?? undefined)
      .then(() => this.spotify.pause(true))
      .catch(() => undefined);
  }

  private cloneSpotifyRequests(requests: any[] | null | undefined): any[] {
    return Array.isArray(requests)
      ? requests.map(request => ({ ...request }))
      : [];
  }

  private recordSpotifyRequestsSnapshot() {
    this.recordCallEnvironmentEvent('spotify-requests', this.cloneSpotifyRequests(this.spotifyRequests));
  }

  private async recordCurrentSpotifyPlaybackState() {
    if (!this.sessionRecording.isRecording()) {
      return;
    }

    const state = await this.spotify.getPlaybackState().catch(() => null);
    if (!state) {
      return;
    }

    const track = state?.track_window?.current_track;
    if (!track?.uri) {
      return;
    }

    const recordedSpotifyState = this.createRecordedSpotifyState({
      uri: track.uri,
      name: track.name,
      artist: this.getSpotifyTrackArtist(track),
      image: this.getSpotifyTrackImage(track),
      position: state.position,
      playing: !state.paused,
      paused: state.paused,
      contextUri: state.context?.uri ?? null,
      shuffle: state.shuffle_state,
      volumePercent: this.getCurrentSpotifyVolumePercent()
    });
    this.recordCallEnvironmentEvent('spotify-state', recordedSpotifyState);
  }

  private recordCurrentCallEnvironmentInitialState() {
    this.sessionRecording.recordCallEnvironmentInitialState(this.createCallEnvironmentState());
    this.lastRecordedCallParticipantsSnapshot = this.getCallParticipantsSnapshotSignature(
      this.createCallParticipantSnapshots()
    );
  }

  private recordCallEnvironmentEvent(action: RecordedCallEnvironmentAction, data: any) {
    if (!this.sessionRecording.isRecording() || this.isCallPlaybackMode || this.isApplyingCallPlaybackEnvironment) {
      return;
    }

    this.sessionRecording.recordCallEnvironmentEvent(action, data);
  }

  private recordCallParticipantsSnapshotIfChanged() {
    if (!this.sessionRecording.isRecording() || this.isCallPlaybackMode) {
      return;
    }

    const snapshot = this.createCallParticipantSnapshots();
    const signature = this.getCallParticipantsSnapshotSignature(snapshot);
    if (signature === this.lastRecordedCallParticipantsSnapshot) {
      return;
    }

    this.lastRecordedCallParticipantsSnapshot = signature;
    this.recordCallEnvironmentEvent('participants', snapshot);
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
      spotifyRequests: this.cloneSpotifyRequests(this.spotifyRequests),
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
      userData: this.createCharacterSnapshot(participant.userData),
      participantMeta: participant.participantMeta ?? null,
      ping: participant.ping,
      volumePercent: participant.volumePercent,
      isSceneMainCharacter: participant.isSceneMainCharacter,
      hasAudio: !!participant.stream?.getAudioTracks().length,
      hasVideo: !!participant.stream?.getVideoTracks().length
    };
  }

  private createCharacterSnapshot(character: ICharacter | undefined | null): Partial<ICharacter> | null {
    if (!character) {
      return null;
    }

    return {
      _id: character._id,
      ownerId: character.ownerId,
      name: character.name,
      race: character.race,
      icon: character.icon,
      baseStats: character.baseStats ? { ...character.baseStats } : undefined,
      classes: Array.isArray(character.classes) ? character.classes.map(characterClass => ({ ...characterClass })) : [],
      ac: character.ac
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

  private hasPlayableCallRecording(recording: SessionRecording | null | undefined): boolean {
    return !!recording && (!!recording.media || !!recording.participantMedia?.length);
  }

  private getRecordingPlaybackDurationMs(recording: SessionRecording | null | undefined): number {
    if (!recording) {
      return 0;
    }

    const participantDurationMs = (recording.participantMedia ?? []).reduce(
      (durationMs, participant) => Math.max(durationMs, participant.endedAtMs),
      0
    );

    return Math.max(recording.media?.durationMs ?? 0, recording.durationMs, participantDurationMs);
  }

  private createAstralRecordingManifest(recording: SessionRecording) {
    return {
      format: 'astral-session-recording',
      formatVersion: 1,
      packagedAt: new Date().toISOString(),
      recording: {
        id: recording.id,
        callRoomId: recording.callRoomId,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt,
        durationMs: recording.durationMs,
        media: this.createAstralMediaManifest(recording.media),
        participantMedia: (recording.participantMedia ?? []).map(participant => ({
          participantId: participant.participantId,
          isLocal: participant.isLocal,
          userData: participant.userData,
          participantMeta: participant.participantMeta,
          volumePercent: participant.volumePercent,
          startedAtMs: participant.startedAtMs,
          endedAtMs: participant.endedAtMs,
          media: this.createAstralMediaManifest(participant.media)
        })),
        vtt: recording.vtt,
        callEnvironment: recording.callEnvironment
      }
    };
  }

  private createAstralMediaManifest(media: SessionRecordingMedia | null | undefined) {
    if (!media) {
      return null;
    }

    return {
      storage: media.storage,
      mimeType: media.mimeType,
      durationMs: media.durationMs,
      size: media.size,
      path: media.path ?? null
    };
  }

  private syncCallParticipantRecorders() {
    if (!this.sessionRecording.isRecording() || this.finalizingSessionRecording || this.isCallPlaybackMode) {
      return;
    }

    const activeParticipantIds = new Set<string>();
    this.getCallRecordingParticipantsForStreams().forEach(participant => {
      const tracks = this.getRecordableParticipantTracks(participant);
      if (!tracks.length) {
        return;
      }

      activeParticipantIds.add(participant.id);
      const idleState = this.callParticipantIdleStates.get(participant.id);
      if (idleState) {
        idleState.userData = this.createCharacterSnapshot(participant.userData);
        idleState.participantMeta = participant.participantMeta ?? null;
        idleState.volumePercent = participant.volumePercent;

        const tracksSignature = this.getTrackSignature(tracks);
        if (idleState.tracksSignature === tracksSignature) {
          return;
        }

        this.endCallParticipantIdleState(idleState, true);
      }

      const existingRecorder = this.callParticipantRecorders.get(participant.id);
      if (existingRecorder && this.hasSameTrackSet(existingRecorder.stream.getTracks(), tracks)) {
        existingRecorder.userData = this.createCharacterSnapshot(participant.userData);
        existingRecorder.participantMeta = participant.participantMeta ?? null;
        existingRecorder.volumePercent = participant.volumePercent;
        return;
      }

      if (existingRecorder) {
        this.stopCallParticipantRecorder(existingRecorder, 'tracks-changed');
      }

      this.startCallParticipantRecorder(participant, tracks);
    });

    Array.from(this.callParticipantRecorders.values()).forEach(recorder => {
      if (!activeParticipantIds.has(recorder.participantId)) {
        this.stopCallParticipantRecorder(recorder, 'removed');
      }
    });

    Array.from(this.callParticipantIdleStates.values()).forEach(idleState => {
      if (!activeParticipantIds.has(idleState.participantId)) {
        this.endCallParticipantIdleState(idleState, true);
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

  private getRecordableParticipantTracks(participant: CallRecordingParticipant): MediaStreamTrack[] {
    return participant.stream?.getTracks().filter(track => track.readyState === 'live') ?? [];
  }

  private hasSameTrackSet(firstTracks: MediaStreamTrack[], secondTracks: MediaStreamTrack[]): boolean {
    const firstTrackIds = firstTracks.map(track => track.id).sort();
    const secondTrackIds = secondTracks.map(track => track.id).sort();
    return firstTrackIds.length === secondTrackIds.length &&
      firstTrackIds.every((trackId, index) => trackId === secondTrackIds[index]);
  }

  private getTrackSignature(tracks: MediaStreamTrack[]): string {
    return tracks.map(track => track.id).sort().join('|');
  }

  private startCallParticipantRecorder(participant: CallRecordingParticipant, tracks: MediaStreamTrack[]) {
    const stream = new MediaStream(tracks);
    const startedAtMs = Math.max(0, Date.now() - this.callRecordingStartedAt);
    let recorder: MediaRecorder;
    let mimeType = this.getSupportedSessionRecordingMimeType(stream) || '';

    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mimeType = recorder.mimeType || mimeType || 'video/webm';
    } catch (error) {
      console.error('Failed to create participant recorder', error);
      this.sessionRecordingError = 'Recording unavailable';
      this.stopSessionRecording(true);
      return;
    }

    const participantRecorder: CallParticipantRecorder = {
      participantId: participant.id,
      isLocal: !!participant.isLocal,
      userData: this.createCharacterSnapshot(participant.userData),
      participantMeta: participant.participantMeta ?? null,
      volumePercent: participant.volumePercent,
      stream,
      recorder,
      chunks: [],
      mimeType,
      startedAtMs,
      stopping: false,
      astralSegmentIndex: this.astralRecordingSessionId
        ? this.getNextAstralParticipantSegmentIndex(participant.id)
        : null,
      astralFilePath: null,
      astralFileUrl: null,
      astralSize: 0,
      astralWriteChain: Promise.resolve(),
      astralWriteFailed: false,
      stopReason: 'final',
      idleMonitor: null,
      idleMonitorInterval: null,
      idleLastActivityAt: Date.now(),
      idleTransitionInProgress: false,
      pendingIdleStillFrame: null,
      pendingIdleStillMimeType: null
    };

    recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        if (this.astralRecordingSessionId && participantRecorder.astralSegmentIndex !== null) {
          this.queueAstralParticipantChunk(participantRecorder, event.data);
        } else {
          participantRecorder.chunks.push(event.data);
        }
      }
    };
    recorder.onerror = event => {
      console.error('Participant session recorder error', event);
      this.sessionRecordingError = 'Recording failed';
      this.stopSessionRecording(true);
      this.cdr.detectChanges();
    };
    recorder.onstop = () => void this.handleCallParticipantRecorderStopped(participantRecorder);

    try {
      recorder.start(1000);
      this.callParticipantRecorders.set(participant.id, participantRecorder);
      this.startCallParticipantRecorderIdleMonitor(participantRecorder);
    } catch (error) {
      console.error('Failed to start participant recorder', error);
      this.sessionRecordingError = 'Recording failed';
      this.stopSessionRecording(true);
    }
  }

  private getNextAstralParticipantSegmentIndex(participantId: string): number {
    const nextIndex = this.astralParticipantSegmentCounters.get(participantId) ?? 0;
    this.astralParticipantSegmentCounters.set(participantId, nextIndex + 1);
    return nextIndex;
  }

  private queueAstralParticipantChunk(participantRecorder: CallParticipantRecorder, chunk: Blob) {
    const sessionId = this.astralRecordingSessionId;
    const segmentIndex = participantRecorder.astralSegmentIndex;
    if (!sessionId || segmentIndex === null || participantRecorder.astralWriteFailed) {
      return;
    }

    const chunkStartedAtMs = Math.max(0, Date.now() - this.callRecordingStartedAt - participantRecorder.startedAtMs);
    participantRecorder.astralWriteChain = participantRecorder.astralWriteChain
      .catch(() => undefined)
      .then(async () => {
        if (participantRecorder.astralWriteFailed) {
          return;
        }

        try {
          const result = await this.astralRecording.writeChunk({
            sessionId,
            participantId: participantRecorder.participantId,
            segmentIndex,
            mimeType: participantRecorder.mimeType,
            startedAtMs: participantRecorder.startedAtMs,
            chunkStartedAtMs,
            blob: chunk
          });
          participantRecorder.astralFilePath = result.filePath;
          participantRecorder.astralFileUrl = result.fileUrl;
          participantRecorder.astralSize = result.size;
        } catch (error) {
          console.error('Failed to persist Astral recording chunk', error);
          participantRecorder.astralWriteFailed = true;
          this.sessionRecordingError = 'Recording failed';
          this.stopSessionRecording(true);
        }
      });
  }

  private startCallParticipantRecorderIdleMonitor(participantRecorder: CallParticipantRecorder) {
    if (!participantRecorder.stream.getVideoTracks().some(track => track.readyState === 'live')) {
      return;
    }

    const monitor = this.createParticipantActivityMonitor(participantRecorder.stream);
    if (!monitor) {
      return;
    }

    participantRecorder.idleMonitor = monitor;
    participantRecorder.idleLastActivityAt = Date.now();
    participantRecorder.idleMonitorInterval = setInterval(() => {
      if (
        participantRecorder.stopping ||
        participantRecorder.idleTransitionInProgress ||
        this.finalizingSessionRecording ||
        !this.sessionRecording.isRecording()
      ) {
        return;
      }

      const sample = monitor.getSample();
      if (sample.active) {
        participantRecorder.idleLastActivityAt = Date.now();
        return;
      }

      if (Date.now() - participantRecorder.idleLastActivityAt >= this.participantIdleThresholdMs) {
        void this.transitionCallParticipantRecorderToIdle(participantRecorder);
      }
    }, this.participantIdleCheckIntervalMs);
  }

  private stopCallParticipantRecorderIdleMonitor(participantRecorder: CallParticipantRecorder) {
    if (participantRecorder.idleMonitorInterval) {
      clearInterval(participantRecorder.idleMonitorInterval);
      participantRecorder.idleMonitorInterval = null;
    }

    participantRecorder.idleMonitor?.cleanup();
    participantRecorder.idleMonitor = null;
  }

  private async transitionCallParticipantRecorderToIdle(participantRecorder: CallParticipantRecorder) {
    if (
      participantRecorder.stopping ||
      participantRecorder.idleTransitionInProgress ||
      this.finalizingSessionRecording ||
      this.callRecordingDiscardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    participantRecorder.idleTransitionInProgress = true;
    const stillFrame = await this.captureStillFrameFromStream(participantRecorder.stream);
    if (
      !stillFrame ||
      this.callParticipantRecorders.get(participantRecorder.participantId) !== participantRecorder ||
      participantRecorder.stopping ||
      this.finalizingSessionRecording ||
      this.callRecordingDiscardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      participantRecorder.idleTransitionInProgress = false;
      participantRecorder.idleLastActivityAt = Date.now();
      return;
    }

    participantRecorder.pendingIdleStillFrame = stillFrame;
    participantRecorder.pendingIdleStillMimeType = stillFrame.type || this.participantStillFrameMimeType;
    this.stopCallParticipantRecorder(participantRecorder, 'idle');
  }

  private async startCallParticipantIdleState(participantRecorder: CallParticipantRecorder) {
    const stillFrame = participantRecorder.pendingIdleStillFrame;
    if (
      !stillFrame ||
      this.finalizingSessionRecording ||
      this.callRecordingDiscardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const startedAtMs = Math.max(0, Date.now() - this.callRecordingStartedAt);
    const mimeType = participantRecorder.pendingIdleStillMimeType || stillFrame.type || this.participantStillFrameMimeType;
    let mediaUrl: string | null = null;
    let mediaPath: string | null = null;
    let mediaSize = stillFrame.size;
    let memoryBlob: Blob | null = stillFrame;

    if (this.astralRecordingSessionId) {
      try {
        const result = await this.astralRecording.writeChunk({
          sessionId: this.astralRecordingSessionId,
          participantId: participantRecorder.participantId,
          segmentIndex: this.getNextAstralParticipantSegmentIndex(participantRecorder.participantId),
          mimeType,
          startedAtMs,
          chunkStartedAtMs: 0,
          blob: stillFrame
        });
        mediaUrl = result.fileUrl;
        mediaPath = result.filePath;
        mediaSize = result.size;
        memoryBlob = null;
      } catch (error) {
        console.error('Failed to persist Astral idle still frame', error);
        this.sessionRecordingError = 'Recording failed';
        this.stopSessionRecording(true);
        return;
      }
    }

    if (
      this.finalizingSessionRecording ||
      this.callRecordingDiscardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const idleState: CallParticipantIdleState = {
      participantId: participantRecorder.participantId,
      isLocal: participantRecorder.isLocal,
      userData: participantRecorder.userData,
      participantMeta: participantRecorder.participantMeta,
      volumePercent: participantRecorder.volumePercent,
      stream: participantRecorder.stream,
      tracksSignature: this.getTrackSignature(participantRecorder.stream.getTracks()),
      startedAtMs,
      blob: memoryBlob,
      mimeType,
      mediaUrl,
      mediaPath,
      size: mediaSize,
      activityMonitor: null,
      activityMonitorInterval: null,
      resuming: false
    };

    this.callParticipantIdleStates.set(participantRecorder.participantId, idleState);
    this.startCallParticipantIdleStateMonitor(idleState);
  }

  private startCallParticipantIdleStateMonitor(idleState: CallParticipantIdleState) {
    const monitor = this.createParticipantActivityMonitor(idleState.stream);
    if (!monitor) {
      return;
    }

    idleState.activityMonitor = monitor;
    idleState.activityMonitorInterval = setInterval(() => {
      if (
        idleState.resuming ||
        this.finalizingSessionRecording ||
        !this.sessionRecording.isRecording() ||
        this.callParticipantIdleStates.get(idleState.participantId) !== idleState
      ) {
        return;
      }

      if (monitor.getSample().active) {
        this.resumeCallParticipantRecordingFromIdle(idleState);
      }
    }, this.participantIdleCheckIntervalMs);
  }

  private resumeCallParticipantRecordingFromIdle(idleState: CallParticipantIdleState) {
    if (idleState.resuming) {
      return;
    }

    idleState.resuming = true;
    const participant = this.getCallRecordingParticipantsForStreams()
      .find(candidate => candidate.id === idleState.participantId);
    this.endCallParticipantIdleState(idleState, true);

    if (
      !participant ||
      this.finalizingSessionRecording ||
      this.callRecordingDiscardOnStop ||
      !this.sessionRecording.isRecording()
    ) {
      return;
    }

    const tracks = this.getRecordableParticipantTracks(participant);
    if (tracks.length) {
      this.startCallParticipantRecorder(participant, tracks);
    }
  }

  private endAllCallParticipantIdleStates(attachMedia: boolean) {
    Array.from(this.callParticipantIdleStates.values()).forEach(idleState => {
      this.endCallParticipantIdleState(idleState, attachMedia);
    });
  }

  private endCallParticipantIdleState(idleState: CallParticipantIdleState, attachMedia: boolean) {
    if (idleState.activityMonitorInterval) {
      clearInterval(idleState.activityMonitorInterval);
      idleState.activityMonitorInterval = null;
    }

    idleState.activityMonitor?.cleanup();
    idleState.activityMonitor = null;

    if (this.callParticipantIdleStates.get(idleState.participantId) === idleState) {
      this.callParticipantIdleStates.delete(idleState.participantId);
    }

    if (!attachMedia || this.callRecordingDiscardOnStop) {
      return;
    }

    const durationMs = Math.max(0, Date.now() - this.callRecordingStartedAt - idleState.startedAtMs);
    const participant = {
      participantId: idleState.participantId,
      isLocal: idleState.isLocal,
      userData: idleState.userData,
      participantMeta: idleState.participantMeta,
      volumePercent: idleState.volumePercent,
      startedAtMs: idleState.startedAtMs
    };

    if (idleState.mediaUrl) {
      this.sessionRecording.attachCallParticipantExternalMedia(
        participant,
        idleState.mediaUrl,
        idleState.mimeType,
        durationMs,
        idleState.size,
        idleState.mediaPath
      );
      return;
    }

    if (idleState.blob) {
      this.sessionRecording.attachCallParticipantMedia(
        participant,
        idleState.blob,
        idleState.mimeType,
        durationMs
      );
    }
  }

  private createParticipantActivityMonitor(stream: MediaStream): CallParticipantActivityMonitor | null {
    const audioTrack = stream.getAudioTracks().find(track => track.readyState === 'live') ?? null;
    const videoTrack = stream.getVideoTracks().find(track => track.readyState === 'live') ?? null;
    let audioContext: AudioContext | null = null;
    let audioSource: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let audioData: Uint8Array | null = null;
    let videoElement: HTMLVideoElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let canvasContext: CanvasRenderingContext2D | null = null;
    let previousFrame: Uint8ClampedArray | null = null;

    if (audioTrack) {
      const AudioContextConstructor = this.getAudioContextConstructor();
      if (AudioContextConstructor) {
        try {
          audioContext = new AudioContextConstructor();
          audioSource = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.75;
          audioData = new Uint8Array(analyser.fftSize);
          audioSource.connect(analyser);
          void audioContext.resume().catch(() => undefined);
        } catch {
          audioContext = null;
          audioSource = null;
          analyser = null;
          audioData = null;
        }
      }
    }

    if (videoTrack && typeof document !== 'undefined') {
      videoElement = document.createElement('video');
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.srcObject = new MediaStream([videoTrack]);
      canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 27;
      canvasContext = canvas.getContext('2d', { willReadFrequently: true });
      void videoElement.play().catch(() => undefined);
    }

    if (!analyser && !canvasContext) {
      return null;
    }

    const getAudioLevel = () => {
      if (!audioTrack || !analyser || !audioData || audioTrack.readyState !== 'live' || !audioTrack.enabled) {
        return 0;
      }

      analyser.getByteTimeDomainData(audioData as Uint8Array<ArrayBuffer>);
      let totalSquare = 0;
      for (const value of audioData) {
        const normalized = (value - 128) / 128;
        totalSquare += normalized * normalized;
      }

      return Math.sqrt(totalSquare / audioData.length);
    };

    const getVideoMotion = () => {
      if (
        !videoTrack ||
        !videoElement ||
        !canvas ||
        !canvasContext ||
        videoTrack.readyState !== 'live' ||
        videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !videoElement.videoWidth ||
        !videoElement.videoHeight
      ) {
        return 0;
      }

      try {
        canvasContext.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        const frame = canvasContext.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!previousFrame) {
          previousFrame = new Uint8ClampedArray(frame);
          return 0;
        }

        let totalDifference = 0;
        for (let index = 0; index < frame.length; index += 4) {
          totalDifference += Math.abs(frame[index] - previousFrame[index]);
          totalDifference += Math.abs(frame[index + 1] - previousFrame[index + 1]);
          totalDifference += Math.abs(frame[index + 2] - previousFrame[index + 2]);
        }

        previousFrame.set(frame);
        return totalDifference / (canvas.width * canvas.height * 3);
      } catch {
        return 0;
      }
    };

    return {
      getSample: () => {
        const audioLevel = getAudioLevel();
        const videoMotion = getVideoMotion();
        return {
          audioLevel,
          videoMotion,
          active: audioLevel >= this.participantIdleAudioRmsThreshold ||
            videoMotion >= this.participantIdleVideoMotionThreshold
        };
      },
      cleanup: () => {
        audioSource?.disconnect();
        if (audioContext) {
          void audioContext.close().catch(() => undefined);
        }

        if (videoElement) {
          videoElement.pause();
          videoElement.srcObject = null;
          videoElement.remove();
        }
      }
    };
  }

  private async captureStillFrameFromStream(stream: MediaStream): Promise<Blob | null> {
    const videoTrack = stream.getVideoTracks().find(track => track.readyState === 'live');
    if (!videoTrack || typeof document === 'undefined') {
      return null;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);

    try {
      void video.play().catch(() => undefined);
      await this.waitForVideoFrame(video, 2500);
      if (
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !video.videoWidth ||
        !video.videoHeight
      ) {
        return null;
      }

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        return null;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return await this.canvasToBlob(canvas, this.participantStillFrameMimeType, 0.95) ??
        await this.canvasToBlob(canvas, 'image/png');
    } catch {
      return null;
    } finally {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
  }

  private waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
    if (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let resolved = false;
      const cleanup = () => {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('playing', onReady);
        window.clearTimeout(timeout);
      };
      const onReady = () => {
        if (resolved) {
          return;
        }

        resolved = true;
        cleanup();
        resolve();
      };
      const timeout = window.setTimeout(onReady, timeoutMs);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('playing', onReady);
    });
  }

  private canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), mimeType, quality);
    });
  }

  private stopAllCallParticipantRecorders() {
    Array.from(this.callParticipantRecorders.values()).forEach(recorder => {
      this.stopCallParticipantRecorder(recorder, 'final');
    });
  }

  private stopCallParticipantRecorder(
    participantRecorder: CallParticipantRecorder,
    reason: CallParticipantRecorderStopReason = 'final'
  ) {
    if (participantRecorder.stopping) {
      return;
    }

    participantRecorder.stopReason = reason;
    participantRecorder.stopping = true;
    this.stopCallParticipantRecorderIdleMonitor(participantRecorder);
    if (participantRecorder.recorder.state !== 'inactive') {
      this.stoppingCallParticipantRecorders += 1;
      participantRecorder.recorder.stop();
      return;
    }

    void this.handleCallParticipantRecorderStopped(participantRecorder);
  }

  private async handleCallParticipantRecorderStopped(participantRecorder: CallParticipantRecorder) {
    await participantRecorder.astralWriteChain.catch(() => undefined);
    if (participantRecorder.astralWriteFailed) {
      this.callRecordingDiscardOnStop = true;
      this.sessionRecordingError = 'Recording failed';
    }

    const activeRecorder = this.callParticipantRecorders.get(participantRecorder.participantId);
    if (activeRecorder === participantRecorder) {
      this.callParticipantRecorders.delete(participantRecorder.participantId);
    }

    if (participantRecorder.stopping && this.stoppingCallParticipantRecorders > 0) {
      this.stoppingCallParticipantRecorders -= 1;
    }

    if (!this.callRecordingDiscardOnStop && participantRecorder.astralFileUrl) {
      const durationMs = Math.max(0, Date.now() - this.callRecordingStartedAt - participantRecorder.startedAtMs);
      this.sessionRecording.attachCallParticipantExternalMedia({
        participantId: participantRecorder.participantId,
        isLocal: participantRecorder.isLocal,
        userData: participantRecorder.userData,
        participantMeta: participantRecorder.participantMeta,
        volumePercent: participantRecorder.volumePercent,
        startedAtMs: participantRecorder.startedAtMs
      }, participantRecorder.astralFileUrl, participantRecorder.mimeType, durationMs, participantRecorder.astralSize, participantRecorder.astralFilePath);
    } else if (!this.callRecordingDiscardOnStop && participantRecorder.chunks.length > 0) {
      const durationMs = Math.max(0, Date.now() - this.callRecordingStartedAt - participantRecorder.startedAtMs);
      this.sessionRecording.attachCallParticipantMedia({
        participantId: participantRecorder.participantId,
        isLocal: participantRecorder.isLocal,
        userData: participantRecorder.userData,
        participantMeta: participantRecorder.participantMeta,
        volumePercent: participantRecorder.volumePercent,
        startedAtMs: participantRecorder.startedAtMs
      }, new Blob(participantRecorder.chunks, { type: participantRecorder.mimeType }), participantRecorder.mimeType, durationMs);
    }

    if (participantRecorder.stopReason === 'idle') {
      await this.startCallParticipantIdleState(participantRecorder);
    }

    void this.finishSessionRecordingIfReady();
  }

  private async finishSessionRecordingIfReady() {
    if (this.finalizingSessionRecording && this.callParticipantIdleStates.size > 0) {
      this.endAllCallParticipantIdleStates(!this.callRecordingDiscardOnStop);
    }

    if (!this.finalizingSessionRecording || this.stoppingCallParticipantRecorders > 0 || this.callParticipantRecorders.size > 0 || this.callParticipantIdleStates.size > 0) {
      return;
    }

    const discardRecording = this.callRecordingDiscardOnStop;
    this.cleanupCallParticipantRecorders();

    if (discardRecording) {
      await this.abortAstralRecordingSession();
      this.sessionRecording.abortRecording();
      this.cdr.detectChanges();
      return;
    }

    const recording = this.sessionRecording.stopRecording();
    if (this.hasPlayableCallRecording(recording)) {
      const packagedAsAstral = recording ? await this.finalizeAstralRecordingSession(recording) : false;
      this.recordedSession = this.sessionRecording.getLastRecording() ?? recording;
      this.snackBar.open(
        packagedAsAstral
          ? 'Call and VTT recording ready for playback and saved as .astral.'
          : 'Call and VTT recording ready for playback.',
        'Close',
        { duration: 3000 }
      );
    } else {
      await this.abortAstralRecordingSession();
      this.sessionRecordingError = 'No participant media captured';
    }

    this.cdr.detectChanges();
  }

  private cleanupCallParticipantRecorders() {
    this.clearCallRecordingTimer();
    this.callParticipantRecorders.forEach(recorder => this.stopCallParticipantRecorderIdleMonitor(recorder));
    this.callParticipantRecorders.clear();
    this.endAllCallParticipantIdleStates(false);
    this.stoppingCallParticipantRecorders = 0;
    this.finalizingSessionRecording = false;
    this.callRecordingStartedAt = 0;
    this.callRecordingDiscardOnStop = false;
    this.sessionRecordingDurationSeconds = 0;
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
      video.preload = 'auto';
      video.volume = Math.min(1, Math.max(0, participant.volumePercent / 100));
      if (!isStillFrame) {
        video.src = participant.media.url;
        host.appendChild(video);
        void this.applyAudioOutputToMediaElement(video);
      }

      const source: CallPlaybackSource = {
        participant,
        video,
        stream: isStillFrame ? null : this.capturePlaybackVideoStream(video),
        cleanup: [],
        active: false,
        ended: false
      };
      if (!isStillFrame) {
        this.bindPlaybackSourceVideoReadiness(source);
      }
      this.callPlaybackSources.push(source);
    });

    this.refreshCallPlaybackParticipantStreams(0);
  }

  private capturePlaybackVideoStream(video: HTMLVideoElement): MediaStream | null {
    return (video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    }).captureStream?.() ?? (video as HTMLVideoElement & {
      mozCaptureStream?: () => MediaStream;
    }).mozCaptureStream?.() ?? null;
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

    const refreshInterval = window.setInterval(refreshSourceStream, 250);
    const refreshTimeout = window.setTimeout(() => window.clearInterval(refreshInterval), 4000);
    source.cleanup.push(() => {
      window.clearInterval(refreshInterval);
      window.clearTimeout(refreshTimeout);
    });
  }

  private updatePlaybackSourceStream(source: CallPlaybackSource): boolean {
    const nextStream = this.capturePlaybackVideoStream(source.video);
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
    if (this.hasSameTrackSet(currentTracks, nextTracks)) {
      return false;
    }

    const currentLiveTrackCount = currentTracks.filter(track => track.readyState === 'live').length;
    const nextLiveTrackCount = nextTracks.filter(track => track.readyState === 'live').length;
    if (currentLiveTrackCount === 0 && nextLiveTrackCount > 0) {
      return true;
    }

    return !this.hasVideoTrack(currentStream) && this.hasVideoTrack(nextStream);
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
    this.callPlaybackCurrentTimeMs = 0;
    this.callPlaybackDurationMs = 0;
    this.callPlaybackClockStartedAtMs = 0;
    this.callPlaybackClockStartTimeMs = 0;
    this.visiblePlaybackSyncToken = 0;
    this.activePlaybackVttRoomId = null;
    this.playbackSpotifyState = null;
    this.playbackSpotifyVolumePercent = 100;
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
    } else {
      this.playCallPlaybackSources();
    }
  }

  private seekCallPlaybackSources(currentTimeMs: number) {
    this.isSeekingCallPlaybackSources = true;
    this.callPlaybackCurrentTimeMs = currentTimeMs;
    this.visiblePlaybackSyncToken += 1;
    this.callPlaybackSources.forEach(source => {
      source.ended = false;
      if (this.hasStillFrameMedia(source)) {
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
    this.startCallPlaybackClock(this.callPlaybackCurrentTimeMs);
    this.refreshCallPlaybackParticipantStreams(this.callPlaybackCurrentTimeMs);
    this.callPlaybackSources
      .filter(source => source.active && !source.ended)
      .forEach(source => this.playPlaybackMediaSource(source));
    this.startCallPlaybackSyncTimer();
  }

  private pauseCallPlaybackSources() {
    this.callPlaybackCurrentTimeMs = this.getCurrentCallPlaybackTimeMs();
    this.callPlaybackClockStartedAtMs = 0;
    this.callPlaybackSources.forEach(source => source.video.pause());
    this.stopCallPlaybackSyncTimer();
  }

  setCallPlaybackPaused(paused: boolean) {
    if (!this.isCallPlaybackMode) {
      return;
    }

    this.callPlaybackPaused = paused;
    if (paused) {
      this.pauseCallPlaybackSources();
    } else {
      this.playCallPlaybackSources();
    }

    this.sessionRecording.setPlaybackPaused(paused);
  }

  seekCallPlayback(value: number | string) {
    const currentTimeMs = Math.max(0, Number(value) || 0);
    this.callPlaybackCurrentTimeMs = currentTimeMs;
    this.seekCallPlaybackSources(currentTimeMs);
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

      const currentTimeMs = this.getCurrentCallPlaybackTimeMs();
      this.callPlaybackCurrentTimeMs = currentTimeMs;
      this.sessionRecording.setPlaybackTime(currentTimeMs, this.callPlaybackPaused);
      this.refreshCallPlaybackParticipantStreams(currentTimeMs);
      if (!this.callPlaybackPaused) {
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
    if (this.hasStillFrameMedia(source)) {
      return;
    }

    if (source.ended || source.video.ended) {
      source.ended = true;
      return;
    }

    void source.video.play().catch(() => undefined);
  }

  private refreshCallPlaybackParticipantStreams(currentTimeMs: number) {
    this.callPlaybackSources.forEach(source => {
      const isActive = this.isCallPlaybackSourceActive(source, currentTimeMs);
      if (!isActive) {
        source.active = false;
        source.video.pause();
        return;
      }

      if (!source.active) {
        source.active = true;
        source.ended = false;
        if (!this.hasStillFrameMedia(source)) {
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
          this.bindVisiblePlaybackSourceVideo(video, source);
          return;
        }

        if (source && this.hasStillFrameMedia(source)) {
          this.clearVisiblePlaybackMediaElement(video);
          video.srcObject = null;
          video.muted = true;
          return;
        }
      }
      if (video && stream && video.srcObject !== stream) {
        this.clearVisiblePlaybackMediaElement(video);
        video.srcObject = stream;
      }
      if (video && !stream && video.srcObject) {
        video.srcObject = null;
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
      if (video.srcObject !== stream) {
        this.clearVisiblePlaybackMediaElement(video);
        video.srcObject = stream;
      }
      video.muted = true;
      return;
    }

    this.updateLocalVideoDisplay();
  }

  private shouldBindVisiblePlaybackMediaElement(source: CallPlaybackSource): boolean {
    return this.hasVideoMedia(source);
  }

  private bindVisiblePlaybackSourceVideo(targetVideo: HTMLVideoElement, source: CallPlaybackSource) {
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
    source.video.preload = 'auto';
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

    if (this.callPlaybackPaused || source.ended) {
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
      video.preload = 'auto';
    }

    video.muted = true;
    const syncToken = String(this.visiblePlaybackSyncToken);
    if (isNewSource || video.dataset['playbackSyncToken'] !== syncToken || this.callPlaybackPaused) {
      const sourceTime = Math.max(0, this.callPlaybackCurrentTimeMs - source.participant.startedAtMs) / 1000;
      this.setPlaybackMediaTime(video, sourceTime);
      video.dataset['playbackSyncToken'] = syncToken;
    } else {
      this.correctVisiblePlaybackMediaDrift(video, source);
    }

    if (this.callPlaybackPaused || source.ended) {
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
    if (this.callPlaybackPaused || source.ended || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
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

  private getSupportedSessionRecordingMimeType(stream?: MediaStream): string | null {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return null;
    }

    const hasVideo = stream ? stream.getVideoTracks().length > 0 : true;
    const supportedMimeType = (hasVideo
      ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=h264,opus',
        'video/webm'
      ]
      : [
        'audio/webm;codecs=opus',
        'audio/webm',
        'video/webm;codecs=opus',
        'video/webm'
      ]
    ).find(type => MediaRecorder.isTypeSupported(type));

    return supportedMimeType || null;
  }

  private clearCallRecordingTimer() {
    if (this.callRecordingDurationInterval) {
      clearInterval(this.callRecordingDurationInterval);
      this.callRecordingDurationInterval = null;
    }
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
    return this.hasVisibleSceneMainCharacters && this.hasSceneMainLayoutSpace;
  }

  get sceneSideRowCount(): number {
    if (!this.isSceneMainLayoutActive) {
      return 1;
    }

    const sideParticipantCount = Math.max(0, this.visibleParticipantCount - this.visibleSceneMainCharacterCount);
    return Math.max(1, Math.ceil(sideParticipantCount / Call.sceneSideColumnsPerRow));
  }

  get sceneMainRowCount(): number {
    return this.getSceneMainGridRowCount(this.visibleSceneMainCharacterCount);
  }

  get sceneMainRowHeightCss(): string {
    if (!this.sceneGridContentHeightPx) {
      if (this.sceneMainRowCount <= 1) {
        return `${this.sceneMainAreaHeightPercent}%`;
      }

      const rowPercent = this.sceneMainAreaHeightPercent / this.sceneMainRowCount;
      const rowGapOffsetPx = Call.sceneGridGapPx * (this.sceneMainRowCount - 1) / this.sceneMainRowCount;
      return `calc(${rowPercent}% - ${rowGapOffsetPx}px)`;
    }

    return `${this.sceneMainRowHeightPx}px`;
  }

  get sceneSideRowHeightCss(): string {
    if (!this.sceneGridContentHeightPx) {
      return '120px';
    }

    return `${this.sceneSideRowHeightPx}px`;
  }

  get sceneSideTileMaxWidthCss(): string {
    if (!this.sceneGridContentHeightPx) {
      return '100%';
    }

    return `${Math.floor(this.sceneSideRowHeightPx * 16 / 9)}px`;
  }

  private get sceneMainRowHeightPx(): number {
    const rowCount = this.sceneMainRowCount;
    const rowHeightPoolPx = Math.max(0, this.sceneMainAreaHeightPx - Call.sceneGridGapPx * (rowCount - 1));

    return Math.max(1, Math.floor(rowHeightPoolPx / rowCount));
  }

  private get sceneSideRowHeightPx(): number {
    const sideRowCount = this.sceneSideRowCount;
    const remainingHeightPx = Math.max(
      0,
      this.sceneGridContentHeightPx - this.sceneMainAreaHeightPx - (Call.sceneGridGapPx * sideRowCount)
    );

    return Math.max(1, Math.floor(remainingHeightPx / sideRowCount));
  }

  private get sceneMainAreaHeightPx(): number {
    return Math.max(0, Math.floor(this.sceneGridContentHeightPx * this.sceneMainAreaHeightRatio));
  }

  private get sceneMainAreaHeightRatio(): number {
    if (this.visibleParticipantCount <= 1) {
      return 1;
    }

    return this.visibleSceneMainCharacterCount >= 3
      ? Call.sceneExpandedMainAreaRatio
      : Call.sceneDefaultMainAreaRatio;
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

    const cellWidthPx = this.getPriorityGridCellWidthPx(placement.columnSpan);
    return cellWidthPx ? `${Math.floor(cellWidthPx / Call.sceneMainMinAspectRatio)}px` : null;
  }

  private getPriorityGridPlacement(participantId: string | null | undefined): PriorityGridPlacement | null {
    if (!this.isSceneMainLayoutActive || !participantId) {
      return null;
    }

    const visibleIds = this.getVisibleParticipantIds();
    if (!visibleIds.includes(participantId)) {
      return null;
    }

    const sceneMainIds = this.getVisibleSceneMainParticipantIds(visibleIds);
    const sceneMainIndex = sceneMainIds.indexOf(participantId);
    if (sceneMainIndex !== -1) {
      return this.getSceneMainPriorityGridPlacement(sceneMainIndex, sceneMainIds.length);
    }

    const sideIds = visibleIds.filter(id => !sceneMainIds.includes(id));
    const sideIndex = sideIds.indexOf(participantId);
    if (sideIndex === -1) {
      return null;
    }

    const rowIndex = Math.floor(sideIndex / Call.sceneSideColumnsPerRow);
    const indexInRow = sideIndex % Call.sceneSideColumnsPerRow;
    const rowItemCount = Math.min(
      Call.sceneSideColumnsPerRow,
      sideIds.length - rowIndex * Call.sceneSideColumnsPerRow
    );

    return this.getCenteredRowPlacement(
      this.getSceneMainGridRowCount(sceneMainIds.length) + 1 + rowIndex,
      indexInRow,
      rowItemCount,
      3
    );
  }

  private getSceneMainPriorityGridPlacement(sceneMainIndex: number, sceneMainCount: number): PriorityGridPlacement {
    const rowIndex = Math.floor(sceneMainIndex / Call.sceneMainColumnsPerRow);
    const indexInRow = sceneMainIndex % Call.sceneMainColumnsPerRow;
    const rowItemCount = Math.min(
      Call.sceneMainColumnsPerRow,
      sceneMainCount - rowIndex * Call.sceneMainColumnsPerRow
    );

    const columnSpan = sceneMainCount === 1 && this.visibleParticipantCount === 1
      ? Call.scenePriorityGridColumns
      : this.getSceneMainColumnSpan(rowItemCount);

    return this.getCenteredRowPlacement(
      1 + rowIndex,
      indexInRow,
      rowItemCount,
      columnSpan
    );
  }

  private getCenteredRowPlacement(row: number, indexInRow: number, rowItemCount: number, columnSpan: number): PriorityGridPlacement {
    const usedColumns = rowItemCount * columnSpan;
    const offsetColumns = Math.floor((Call.scenePriorityGridColumns - usedColumns) / 2);

    return {
      row,
      column: 1 + offsetColumns + indexInRow * columnSpan,
      columnSpan
    };
  }

  private getSceneMainGridRowCount(sceneMainCount: number): number {
    return Math.max(1, Math.ceil(sceneMainCount / Call.sceneMainColumnsPerRow));
  }

  private getSceneMainColumnSpan(rowItemCount: number): number {
    return rowItemCount <= 1 ? 8 : 6;
  }

  private getPriorityGridCellWidthPx(columnSpan: number): number | null {
    if (!this.sceneGridContentWidthPx) {
      return null;
    }

    const trackWidthPx = (
      this.sceneGridContentWidthPx - Call.sceneGridGapPx * (Call.scenePriorityGridColumns - 1)
    ) / Call.scenePriorityGridColumns;

    return Math.max(
      1,
      Math.floor(trackWidthPx * columnSpan + Call.sceneGridGapPx * (columnSpan - 1))
    );
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
      ping: r.ping,
      diagnostics: r.diagnostics,
      volumePercent: this.videoService.getParticipantVolume(r.id),
      isSceneMainCharacter: this.isSceneMainCharacter(r.id)
    }));
  }

  onRemoteVideoQualityChange() {
    this.remoteVideoQualityLevel = this.normalizeRemoteVideoQualityLevel(this.remoteVideoQualityLevel);
    this.videoService.setRemoteVideoQualityPreference(this.getSelectedRemoteVideoQualityPreference());
    this.persistMediaPreferences();
  }

  get remoteVideoQualityLabel(): string {
    return this.remoteVideoQualityOptions[this.remoteVideoQualityLevel]?.label ?? 'Balanced';
  }

  async joinCall() {
    if (!this.channelId || !this.character || this.isJoining) return;
    this.isJoining = true;
    this.joinError = '';

    try {
      const currentUserId = this.authService.getCurrentUserId();
      if (!currentUserId) {
        throw new Error('Missing authenticated userId');
      }

      if (this.previewStream && this.previewStream.active) {
        this.localStream = this.previewStream;
        this.previewStream = null;
      } else {
        if (this.isMobileBrowser) {
          await this.prepareMobileMedia();
        }

        this.localStream = await navigator.mediaDevices.getUserMedia(this.buildMediaConstraints());
      }

      if (!this.localStream || !this.localStream.active) {
        throw new Error('Acquired stream is not active');
      }

      this.syncMicInputMonitor();

      // SYNC: Transfer preview settings to live state
      this.isAudioMuted = this.isPreviewMuted;
      this.isVideoOff = this.isPreviewVideoOff;
      this.persistMediaPreferences();

      // Apply initial track states
      this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isAudioMuted);
      this.localStream.getVideoTracks().forEach(t => t.enabled = !this.isVideoOff);

      const characterToBroadcast = this.isDmMode ? this.dmCharacter : this.character;
      this.videoService.updateUserData(this.channelId, characterToBroadcast);
      await this.videoService.initVideoCall(this.channelId, currentUserId, characterToBroadcast);

      await this.videoService.startProducing(this.localStream);

      // Explicitly tell LiveKit the desired initial state
      await this.videoService.setCameraEnabled(!this.isVideoOff);
      await this.videoService.setMicrophoneEnabled(!this.isAudioMuted);

      setTimeout(() => {
        this.updateLocalVideoDisplay();
      }, 100);

      this.videoService.requestSpotifyState();

      } catch (err) {
        console.error('[CRITICAL] Join call failed:', err);
        this.joinError = this.getJoinErrorMessage(err);
        if (this.localStream) {
          this.localStream.getTracks().forEach(t => t.stop());
          this.localStream = null;
      }
      this.isJoining = false;
      await this.startPreview();
    } finally {
      this.isJoining = false;
      this.cdr.detectChanges();
      }
    }

    private getJoinErrorMessage(error: unknown): string {
      const message = error instanceof Error ? error.message : String(error || '');
      if (message.toLowerCase().includes('permission')) {
        return message;
      }

      return 'Could not join this call. Check your device access and channel permissions.';
    }

    async leaveCall() {
    this.stopSessionRecording();
    this.resetMicTestForCaptureChange();
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
      this.checkServerOwner();
    }
  }

  openCharacter(character: ICharacter | undefined) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  // --- THEME PICKER LOGIC ---

  get hasThemeBackgroundImage(): boolean {
    return !!this.activeColors.backgroundImage;
  }

  get themeBackgroundImagePreviewStyle(): string {
    return this.toCssImageValue(this.activeColors.backgroundImage ?? null);
  }

  get isThemeBackgroundBlurred(): boolean {
    return this.hasThemeBackgroundImage && this.activeColors.backgroundImageBlur === true;
  }

  toggleThemePicker() {
    if (this.showThemePicker) {
      this.cancelTheme();
      return;
    }

    this.themePickerBaselineColors = this.isServerOwner ? this.cloneThemeColors(this.activeColors) : null;
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
      return `${theme.colors.background} ${this.toCssImageValue(theme.colors.backgroundImage)} center / cover no-repeat`;
    }

    return theme.colors.primary;
  }

  confirmTheme() {
    this.themeService.applyTheme(this.activeColors, false);
    if (!this.safeSendThemeUpdate(this.activeColors)) {
      return;
    }
    this.recordCallEnvironmentEvent('theme-sync', this.activeColors);
    this.themePickerBaselineColors = null;
    this.showThemePicker = false;
  }

  cancelTheme() {
    if (this.isServerOwner && this.themePickerBaselineColors) {
      this.activeColors = this.cloneThemeColors(this.themePickerBaselineColors);
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
      this.themePickerBaselineColors = this.cloneThemeColors(this.activeColors);
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
      character: this.createCharacterSnapshot(characterToBroadcast)
    });
    this.recordCallParticipantsSnapshotIfChanged();
    this.cdr.detectChanges();
  }

  @HostListener('window:beforeunload')
  async handleBeforeUnload() {
    this.isComponentDestroying = true;
    await this.leaveCall();
  }

  @HostListener('document:click')
  handleDocumentClick() {
    this.closeRemoteContextMenu();
  }

  @HostListener('document:contextmenu')
  handleDocumentContextMenu() {
    this.closeRemoteContextMenu();
  }

  @HostListener('document:keydown.escape')
  handleDocumentEscape() {
    this.closeRemoteContextMenu();
  }

  @HostListener('window:resize')
  handleWindowResize() {
    this.updateSceneMainLayoutSpaceFromElement();
    this.closeRemoteContextMenu();
  }

  ngOnDestroy() {
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;
    this.stopSessionRecording();
    this.cleanupCallPlaybackSources();
    this.resetMicTestForCaptureChange();
    this.stopMicInputMonitor();
    if (this.streamSub) this.streamSub.unsubscribe();
    if (this.spotifySyncSub) this.spotifySyncSub.unsubscribe();
    if (this.spotifyActionSub) this.spotifyActionSub.unsubscribe();
    if (this.spotifyStateRequestSub) this.spotifyStateRequestSub.unsubscribe();
    if (this.spotifyRequestSub) this.spotifyRequestSub.unsubscribe();
    if (this.themeSyncSub) this.themeSyncSub.unsubscribe();
    if (this.pinnedThemesSub) this.pinnedThemesSub.unsubscribe();
    if (this.vttSub) this.vttSub.unsubscribe();
    if (this.overlaySub) this.overlaySub.unsubscribe();
    if (this.overlayTextSub) this.overlayTextSub.unsubscribe();
    if (this.temporaryAtmosphereBackgroundSub) this.temporaryAtmosphereBackgroundSub.unsubscribe();
    if (this.serverDetailsSub) this.serverDetailsSub.unsubscribe();
    if (this.callKickedSub) this.callKickedSub.unsubscribe();
    if (this.companionDevicesSub) this.companionDevicesSub.unsubscribe();
    if (this.selectedVideoSourceSub) this.selectedVideoSourceSub.unsubscribe();
    if (this.selectedAudioSourceSub) this.selectedAudioSourceSub.unsubscribe();
    if (this.remoteVideoQualitySub) this.remoteVideoQualitySub.unsubscribe();
    if (this.participantVolumesSub) this.participantVolumesSub.unsubscribe();
    if (this.sceneMainCharactersSub) this.sceneMainCharactersSub.unsubscribe();
    if (this.sessionRecordingStateSub) this.sessionRecordingStateSub.unsubscribe();
    if (this.sessionRecordingLastSub) this.sessionRecordingLastSub.unsubscribe();
    if (this.sessionPlaybackSub) this.sessionPlaybackSub.unsubscribe();
    if (this.astralPlaybackDropSub) this.astralPlaybackDropSub.unsubscribe();
    this.teardownAllRemoteAudioOutputs();

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

  private toCssImageValue(imageUrl: string | null): string {
    if (!imageUrl) {
      return 'none';
    }

    return `url("${imageUrl.replace(/"/g, '\\"')}")`;
  }

  private cloneThemeColors(colors: ThemeColors): ThemeColors {
    return { ...colors };
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
      if (this.isThemePayloadSizeError(error)) {
        const oversizedImage = theme.backgroundImage ?? null;
        this.revertThemeBackground(theme, false);
        this.promptThemeImageCompression(oversizedImage);
        return false;
      }

      throw error;
    }
  }

  private isThemeSyncPayloadTooLarge(theme: ThemeColors): boolean {
    return this.getThemeSyncPayloadByteLength(theme) > Call.maxThemeSyncPayloadBytes;
  }

  private getThemeSyncPayloadByteLength(theme: ThemeColors): number {
    return new TextEncoder().encode(JSON.stringify({ type: 'theme-sync', theme })).byteLength;
  }

  private revertThemeBackground(theme: ThemeColors, showToast: boolean) {
    const revertedTheme: ThemeColors = {
      ...theme,
      backgroundImage: this.lastValidThemeBackgroundImage,
      backgroundImageBlur: this.lastValidThemeBackgroundImage
        ? this.lastValidThemeBackgroundImageBlur
        : false
    };

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

    this.themeService.applyTheme({
      ...this.activeColors,
      backgroundImage: url,
      backgroundImageBlur: true
    }, false, false);
  }

  private isThemePayloadSizeError(error: unknown): boolean {
    return String(error instanceof Error ? error.message : error).toLowerCase().includes('message too large');
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
      const compressedImage = await this.compressThemeBackgroundImage(source);
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

  private async compressThemeBackgroundImage(source: File | string): Promise<string> {
    const image = await this.loadImageForCompression(source);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Canvas is unavailable');
    }

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const maxDimensions = [1280, 960, 720, 540, 420, 320, 256];
    const qualities = [0.82, 0.72, 0.62, 0.52, 0.42, 0.34, 0.28];

    for (const maxDimension of maxDimensions) {
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      for (const quality of qualities) {
        const compressed = canvas.toDataURL('image/jpeg', quality);
        const candidate = {
          ...this.activeColors,
          backgroundImage: compressed
        };

        if (!this.isThemeSyncPayloadTooLarge(candidate)) {
          return compressed;
        }
      }
    }

    throw new Error('Compressed image is too large');
  }

  private loadImageForCompression(source: File | string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;

      image.onload = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        resolve(image);
      };

      image.onerror = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        reject(new Error('Image could not be loaded'));
      };

      image.src = objectUrl ?? source as string;
    });
  }

  startVttJoining() {
    this.joinVtt.emit(this.vttSession.roomId || this.getVttRoomId());
    this.showVttNotification = false;
  }

  stopVttSession() {
    const roomId = this.vttSession.roomId || this.getVttRoomId();
    this.stopVtt.emit({ roomId, endSession: true });
  }

  dismissOverlay() {
    this.activeOverlayImage = null;
    this.activeOverlayText = null;
  }

  handleSongRequest(request: any) {
      this.spotify.play(request.uri);
      this.removeRequest(request);
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
    if (this.isMobileBrowser) {
      return false;
    }

    const metadata = participant?.participantMeta as CallParticipantMetadata | null;
    if (metadata?.deviceRole === 'phone-camera') {
      return false;
    }

    // Hide transient companion connections before metadata arrives, otherwise they flash as blank users.
    const hasTracks = !!participant?.stream?.getTracks?.().length;
    const hasCharacterName = !!participant?.userData?.name;
    if (!metadata && !hasCharacterName) {
      return false;
    }

    // Companion phone participants should never be shown as normal call tiles.
    if (!metadata && hasTracks && this.videoService.getCurrentDeviceInfo().deviceType !== 'mobile') {
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

    const styles = getComputedStyle(element);
    const contentWidthPx = Math.max(
      0,
      element.clientWidth - this.toCssPixelValue(styles.paddingLeft) - this.toCssPixelValue(styles.paddingRight)
    );
    const contentHeightPx = Math.max(
      0,
      element.clientHeight - this.toCssPixelValue(styles.paddingTop) - this.toCssPixelValue(styles.paddingBottom)
    );

    const nextHasSpace = contentWidthPx >= Call.minSceneMainLayoutWidthPx &&
      contentHeightPx >= Call.minSceneMainLayoutHeightPx;
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

  private toCssPixelValue(value: string): number {
    const numericValue = Number.parseFloat(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
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
    const preferences = this.readStoredMediaPreferences();
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
    if (this.isMicrophoneProcessingMode(preferences.microphoneProcessingMode)) {
      this.microphoneProcessingMode = preferences.microphoneProcessingMode;
    }
    if (this.isRemoteVideoQualityPreference(preferences.remoteVideoQualityPreference)) {
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
    if (typeof preferences.selectedPcVideoSource === 'string' && preferences.selectedPcVideoSource) {
      this.selectedPcVideoSource = preferences.selectedPcVideoSource;
      await this.videoService.selectVideoSource(preferences.selectedPcVideoSource);
    }
    if (typeof preferences.selectedPcAudioSource === 'string' && preferences.selectedPcAudioSource) {
      this.selectedPcAudioSource = preferences.selectedPcAudioSource;
      await this.videoService.selectAudioSource(preferences.selectedPcAudioSource);
    }
  }

  private readStoredMediaPreferences(): Partial<StoredCallMediaPreferences> | null {
    const storage = this.getPreferenceStorage();
    if (!storage) {
      return null;
    }

    const value = storage.getItem(Call.mediaPreferencesStorageKey);
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  private persistMediaPreferences() {
    const preferences: StoredCallMediaPreferences = {
      selectedVideoId: this.selectedVideoId,
      selectedAudioId: this.selectedAudioId,
      selectedOutputId: this.selectedOutputId,
      microphoneProcessingMode: this.microphoneProcessingMode,
      remoteVideoQualityPreference: this.getSelectedRemoteVideoQualityPreference(),
      selectedPcVideoSource: this.selectedPcVideoSource,
      selectedPcAudioSource: this.selectedPcAudioSource,
      isPreviewMuted: this.localStream ? this.isAudioMuted : this.isPreviewMuted,
      isPreviewVideoOff: this.localStream ? this.isVideoOff : this.isPreviewVideoOff,
      experimentalMobile1080pEnabled: this.experimentalMobile1080pEnabled
    };

    this.writeStoredMediaPreferences(preferences);
  }

  private persistCurrentMediaSetupState() {
    const preferences = this.readStoredMediaPreferences() ?? {};
    preferences.isPreviewMuted = this.localStream ? this.isAudioMuted : this.isPreviewMuted;
    preferences.isPreviewVideoOff = this.localStream ? this.isVideoOff : this.isPreviewVideoOff;
    preferences.experimentalMobile1080pEnabled = this.experimentalMobile1080pEnabled;
    this.writeStoredMediaPreferences(preferences);
  }

  private writeStoredMediaPreferences(preferences: Partial<StoredCallMediaPreferences>) {
    const storage = this.getPreferenceStorage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(Call.mediaPreferencesStorageKey, JSON.stringify(preferences));
    } catch (error) {
      console.warn('Failed to persist call media preferences', error);
    }
  }

  private getPreferenceStorage(): Storage | null {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  private resolveAvailableDeviceId(devices: MediaDeviceInfo[], selectedDeviceId: string): string {
    if (!devices.length) {
      return '';
    }

    return selectedDeviceId && devices.some(device => device.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : devices[0].deviceId;
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

  private isMicrophoneProcessingMode(value: unknown): value is MicrophoneProcessingMode {
    return value === 'studio' || value === 'processed';
  }

  private isRemoteVideoQualityPreference(value: unknown): value is RemoteVideoQualityPreference {
    return value === 'low' || value === 'medium' || value === 'high';
  }

  private normalizeRemoteVideoQualityLevel(value: unknown): RemoteVideoQualityLevel {
    const numericValue = typeof value === 'string' ? Number(value) : value;
    if (numericValue === 0 || numericValue === 1 || numericValue === 2) {
      return numericValue;
    }

    return 1;
  }

  private getSelectedRemoteVideoQualityPreference(): RemoteVideoQualityPreference {
    const level = this.normalizeRemoteVideoQualityLevel(this.remoteVideoQualityLevel);
    return this.remoteVideoQualityOptions[level]?.value ?? 'medium';
  }

  private parseDeviceTypeParam(value: string | null | undefined): DeviceType | null {
    if (value === 'desktop' || value === 'mobile' || value === 'tablet' || value === 'unknown') {
      return value;
    }

    return null;
  }

  private preferenceToRemoteVideoQualityLevel(preference: RemoteVideoQualityPreference): RemoteVideoQualityLevel {
    switch (preference) {
      case 'low':
        return 0;
      case 'high':
        return 2;
      default:
        return 1;
    }
  }

  private async replaceActiveMediaStream() {
    this.resetMicTestForCaptureChange();
    const nextStream = await navigator.mediaDevices.getUserMedia(this.buildMediaConstraints());

    nextStream.getAudioTracks().forEach(track => (track.enabled = !this.isAudioMuted));
    nextStream.getVideoTracks().forEach(track => (track.enabled = !this.isVideoOff));

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = nextStream;
      await this.videoService.startProducing(nextStream);
      this.updateLocalVideoDisplay();
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
    const stream = remote.stream;
    const volumePercent = remote.volumePercent ?? this.videoService.getParticipantVolume(remote.id);

    if (!this.supportsRemoteAudioGain || !stream) {
      video.muted = false;
      video.volume = Math.min(1, volumePercent / 100);
      this.teardownRemoteAudioOutput(remote.id);
      return;
    }

    video.muted = true;

    const audioTrack = stream.getAudioTracks()[0] || null;
    if (!audioTrack) {
      this.teardownRemoteAudioOutput(remote.id);
      return;
    }

    const existingOutput = this.remoteAudioOutputs.get(remote.id);
    if (existingOutput && existingOutput.stream === stream && existingOutput.audioTrackId === audioTrack.id) {
      existingOutput.gain.gain.value = volumePercent / 100;
      void this.playRemoteAudioElement(existingOutput.audioElement).then(played => {
        if (!played) {
          video.muted = false;
          video.volume = Math.min(1, volumePercent / 100);
        }
      });
      return;
    }

    this.teardownRemoteAudioOutput(remote.id);

    const audioContext = this.getRemoteAudioContext();
    if (!audioContext) {
      video.muted = false;
      video.volume = Math.min(1, volumePercent / 100);
      return;
    }

    try {
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      const audioElement = new Audio();

      gain.gain.value = volumePercent / 100;
      source.connect(gain);
      gain.connect(destination);

      audioElement.autoplay = true;
      audioElement.srcObject = destination.stream;
      audioElement.volume = 1;

      this.remoteAudioOutputs.set(remote.id, {
        stream,
        audioTrackId: audioTrack.id,
        source,
        gain,
        destination,
        audioElement
      });

      void this.applyAudioOutputToMediaElement(audioElement);
      void this.playRemoteAudioElement(audioElement).then(played => {
        const currentOutput = this.remoteAudioOutputs.get(remote.id);
        if (!played && currentOutput?.audioElement === audioElement) {
          video.muted = false;
          video.volume = Math.min(1, volumePercent / 100);
        }
      });
    } catch (error) {
      console.warn('Failed to create amplified remote audio output', error);
      this.teardownRemoteAudioOutput(remote.id);
      video.muted = false;
      video.volume = Math.min(1, volumePercent / 100);
    }
  }

  private getRemoteAudioContext(): AudioContext | null {
    if (this.remoteAudioContext?.state === 'closed') {
      this.remoteAudioContext = null;
    }

    if (!this.remoteAudioContext) {
      const AudioContextConstructor = this.getAudioContextConstructor();
      if (!AudioContextConstructor) {
        return null;
      }

      this.remoteAudioContext = new AudioContextConstructor();
    }

    if (this.remoteAudioContext.state === 'suspended') {
      void this.remoteAudioContext.resume().catch(() => undefined);
    }

    return this.remoteAudioContext;
  }

  private async playRemoteAudioElement(audioElement: HTMLAudioElement): Promise<boolean> {
    try {
      if (this.remoteAudioContext?.state === 'suspended') {
        await this.remoteAudioContext.resume();
      }

      await audioElement.play();
      return true;
    } catch {
      return false;
    }
  }

  private applyRemoteVolumes() {
    this.remoteStreams.forEach(remote => this.applyRemoteVolume(remote.id, remote.volumePercent));
  }

  private applyRemoteVolume(participantId: string, volumePercent: number) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (output) {
      output.gain.gain.value = volumePercent / 100;
      output.audioElement.volume = 1;
      void this.playRemoteAudioElement(output.audioElement).then(played => {
        const remoteIndex = this.remoteStreams.findIndex(remote => remote.id === participantId);
        const video = remoteIndex >= 0 ? this.remoteVideos?.get(remoteIndex)?.nativeElement : null;
        if (!played && video) {
          video.muted = false;
          video.volume = Math.min(1, volumePercent / 100);
        }
      });
    }

    const remoteIndex = this.remoteStreams.findIndex(remote => remote.id === participantId);
    const video = remoteIndex >= 0 ? this.remoteVideos?.get(remoteIndex)?.nativeElement : null;
    if (video) {
      video.volume = Math.min(1, volumePercent / 100);
      video.muted = this.supportsRemoteAudioGain;
    }
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
    Array.from(this.remoteAudioOutputs.keys()).forEach(participantId => {
      if (!activeParticipantIds.has(participantId)) {
        this.teardownRemoteAudioOutput(participantId);
      }
    });
  }

  private teardownRemoteAudioOutput(participantId: string) {
    const output = this.remoteAudioOutputs.get(participantId);
    if (!output) {
      return;
    }

    output.source.disconnect();
    output.gain.disconnect();
    output.audioElement.pause();
    output.audioElement.srcObject = null;
    output.destination.stream.getTracks().forEach(track => track.stop());
    this.remoteAudioOutputs.delete(participantId);
  }

  private teardownAllRemoteAudioOutputs() {
    Array.from(this.remoteAudioOutputs.keys()).forEach(participantId => this.teardownRemoteAudioOutput(participantId));

    if (this.remoteAudioContext && this.remoteAudioContext.state !== 'closed') {
      void this.remoteAudioContext.close().catch(() => undefined);
    }
    this.remoteAudioContext = null;
  }

  private async applyAudioOutputToAllMedia() {
    if (!this.supportsAudioOutputSelection || !this.selectedOutputId) {
      return;
    }

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
    this.remoteAudioOutputs.forEach(output => {
      mediaElements.push(output.audioElement);
    });

    for (const element of mediaElements) {
      await this.applyAudioOutputToMediaElement(element);
    }
  }

  private async applyAudioOutputToMediaElement(element: HTMLMediaElement) {
    if (!this.supportsAudioOutputSelection || !this.selectedOutputId) {
      return;
    }

    try {
      await element.setSinkId(this.selectedOutputId);
    } catch (error) {
      console.warn('Failed to switch audio output device', error);
    }
  }

  trackRemoteStream(_: number, remote: ParticipantStream): string {
    return remote.id;
  }

  getConnectionQualityLabel(diagnostics?: ParticipantMediaDiagnostics): string {
    if (!diagnostics) {
      return 'Unknown';
    }

    switch (diagnostics.connectionQuality) {
      case 'excellent':
        return 'Excellent';
      case 'good':
        return 'Good';
      case 'poor':
        return 'Poor';
      case 'lost':
        return 'Lost';
      default:
        return 'Unknown';
    }
  }

  getConnectionQualityClass(diagnostics?: ParticipantMediaDiagnostics): string {
    switch (diagnostics?.connectionQuality) {
      case 'excellent':
        return 'quality-excellent';
      case 'good':
        return 'quality-good';
      case 'poor':
        return 'quality-poor';
      case 'lost':
        return 'quality-lost';
      default:
        return 'quality-unknown';
    }
  }

  formatBitrateKbps(value: number | null | undefined): string {
    return value == null ? '--' : `${value} kbps`;
  }

  formatPacketLoss(value: number | null | undefined): string {
    return value == null ? '--' : `${value}%`;
  }

  formatJitter(value: number | null | undefined): string {
    return value == null ? '--' : `${value} ms`;
  }

  formatResolution(diagnostics?: ParticipantMediaDiagnostics): string {
    const width = diagnostics?.video?.width;
    const height = diagnostics?.video?.height;
    if (!width || !height) {
      return '--';
    }

    return `${width}x${height}`;
  }

  formatFrameRate(diagnostics?: ParticipantMediaDiagnostics): string {
    const frameRate = diagnostics?.video?.frameRate;
    return frameRate == null ? '--' : `${frameRate} fps`;
  }
}

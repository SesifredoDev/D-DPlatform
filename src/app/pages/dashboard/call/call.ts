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
import { CallParticipantMetadata, CompanionDeviceOption, CompanionSourceId, ParticipantMediaDiagnostics, RemoteVideoQualityPreference, Video } from '../../../shared/services/video/video';
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

interface ParticipantStream {
  id: string;
  stream?: MediaStream;
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
  vttSession: { active: boolean, roomId: string | null, hostId: string | null } = { active: false, roomId: null, hostId: null };
  showVttNotification: boolean = false;
  private vttNotificationTimeout: any;

  // Broadcast state
  activeOverlayImage: string | null = null;
  activeOverlayText: string | null = null;

  // Spotify Requests
  spotifyRequests: any[] = [];
  showSpotifyRequests: boolean = false;

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
    private snackBar: MatSnackBar
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
      if (
        this.remoteContextMenu &&
        !this.isContextMenuParticipantAvailable(this.remoteContextMenu.remoteId)
      ) {
        this.closeRemoteContextMenu();
      }

      this.updateLocalVideoDisplay(streams);

      setTimeout(() => {
        this.remoteVideos.forEach((videoRef, i) => {
          const video = videoRef.nativeElement;
          const remote = this.remoteStreams[i];
          const stream = remote?.stream;
          if (video && stream && video.srcObject !== stream) {
            video.srcObject = stream;
          }
          if (video && !stream && video.srcObject) {
            video.srcObject = null;
          }
          if (video && remote) {
            this.configureRemoteAudio(remote, video);
          }
        });
        this.teardownMissingRemoteAudioOutputs(new Set(this.remoteStreams.map(remote => remote.id)));
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
            contextUri: state.context?.uri,
            shuffle: state.shuffle_state,
            hostId: this.character.ownerId // Embed host ID for validation
          }, 'manual');
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
           this.cdr.detectChanges();
        }
      }
    });

    this.themeSyncSub = this.videoService.themeSync$.subscribe(colors => {
      this.activeColors = colors;
      this.rememberValidThemeBackground(colors);
      this.themeService.applyTheme(colors, false); // DO NOT save call atmosphere to local player preference
    });

    this.pinnedThemesSub = this.themeService.pinnedThemes$.subscribe(themes => {
      this.pinnedThemes = themes;
      this.cdr.detectChanges();
    });

    this.vttSub = this.videoService.vttSession$.subscribe(session => {
      const wasActive = this.vttSession.active;
      this.vttSession = session;
      if (session.active && !wasActive && session.hostId !== this.videoService.getCurrentParticipantIdentity()) {
        this.triggerVttNotification();
      } else if (!session.active) {
        this.showVttNotification = false;
        if (this.vttNotificationTimeout) clearTimeout(this.vttNotificationTimeout);
      }
    });

    this.overlaySub = this.videoService.overlayImage$.subscribe(url => {
      this.activeOverlayImage = url;
      this.cdr.detectChanges();
    });

    this.overlayTextSub = this.videoService.overlayText$.subscribe(text => {
      this.activeOverlayText = text;
      this.cdr.detectChanges();
    });

    this.temporaryAtmosphereBackgroundSub = this.videoService.temporaryAtmosphereBackground$.subscribe(url => {
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
      this.sceneMainCharacterIds = state.participantIds;
      this.refreshSceneMainCharacterFlags();
      this.cdr.detectChanges();
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

  changeRemoteVolume(participantId: string, value: number | string) {
    const volumePercent = this.normalizeRemoteVolume(value);
    this.videoService.setParticipantVolume(participantId, volumePercent);
    this.remoteStreams = this.remoteStreams.map(remote => remote.id === participantId
      ? { ...remote, volumePercent }
      : remote
    );
    this.applyRemoteVolume(participantId, volumePercent);
  }

  getRemoteVolumeIcon(remote: ParticipantStream): string {
    if (remote.volumePercent <= 0) return 'volume_off';
    if (remote.volumePercent > 100) return 'volume_up';
    return 'volume_down';
  }

  get localSceneMainCharacter(): boolean {
    return this.isSceneMainCharacter(this.videoService.getCurrentParticipantIdentity());
  }

  get localContextMenuOpen(): boolean {
    return this.remoteContextMenu?.remoteId === this.videoService.getCurrentParticipantIdentity();
  }

  get showLocalSelfView(): boolean {
    return !!this.localStream && !this.hideSelfView;
  }

  get visibleSceneMainCharacterCount(): number {
    return this.getVisibleSceneMainParticipantIds().length;
  }

  get visibleParticipantCount(): number {
    return this.remoteStreams.length + (this.showLocalSelfView ? 1 : 0);
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
    return this.getPriorityGridColumn(this.videoService.getCurrentParticipantIdentity());
  }

  getLocalPriorityGridRow(): string | null {
    return this.getPriorityGridRow(this.videoService.getCurrentParticipantIdentity());
  }

  getLocalPriorityGridMaxHeight(): string | null {
    return this.getPriorityGridMaxHeight(this.videoService.getCurrentParticipantIdentity());
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
    const localParticipantId = this.videoService.getCurrentParticipantIdentity();

    if (this.showLocalSelfView && localParticipantId) {
      participantIds.push(localParticipantId);
    }

    this.remoteStreams.forEach(remote => participantIds.push(remote.id));

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

    return this.remoteStreams.find(remote => remote.id === this.remoteContextMenu?.remoteId);
  }

  private getLocalContextMenuParticipant(): ParticipantStream | undefined {
    const localParticipantId = this.videoService.getCurrentParticipantIdentity();
    if (!localParticipantId) {
      return undefined;
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
    return participantId === this.videoService.getCurrentParticipantIdentity() ||
      this.remoteStreams.some(remote => remote.id === participantId);
  }

  private getContextMenuHeight(participant: ParticipantStream): number {
    return 96 +
      (this.isServerOwner ? 44 : 0) +
      (this.canShowTemporaryDmMenu(participant) ? 220 : 0) +
      (participant.isLocal ? 0 : 112);
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
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return 100;
    }

    return Math.min(200, Math.max(0, Math.round(numericValue)));
  }

  private refreshSceneMainCharacterFlags() {
    this.remoteStreams = this.remoteStreams.map(remote => ({
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

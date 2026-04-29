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
import { ServerService } from '../../../shared/services/server/server';
import { IServer } from '../../../shared/models/server/server.model';
import { IUser } from '../../../shared/models/user/user.model';
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
}

type MicrophoneProcessingMode = 'studio' | 'processed';
type RemoteVideoQualityLevel = 0 | 1 | 2;

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer, MatIconModule, MatTooltipModule, MatMenuModule, MarkdownComponent]
})
export class Call implements OnInit, OnDestroy, OnChanges {
  private static readonly micTestMaxDurationMs = 8000;
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
  @Output() stopVtt = new EventEmitter<string>();

  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('previewVideo') previewVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('micTestAudio') micTestAudio?: ElementRef<HTMLAudioElement>;
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
  experimentalMobile1080pEnabled = false;
  private hasRequestedMobileMedia = false;

  // UI States
  showSpotify: boolean = false;
  showThemePicker: boolean = false;
  showDeviceRouting: boolean = false;
  showDiagnosticsPanel: boolean = false;
  showPinNaming: boolean = false;
  newThemeName: string = '';

  // Theme state
  activeColors: ThemeColors;
  pinnedThemes: PinnedTheme[] = [];

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
  isDmMode: boolean = false;
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
  private serverDetailsSub!: Subscription;
  private callKickedSub!: Subscription;
  private companionDevicesSub!: Subscription;
  private selectedVideoSourceSub!: Subscription;
  private selectedAudioSourceSub!: Subscription;
  private remoteVideoQualitySub!: Subscription;
  readonly supportsAudioOutputSelection = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

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
    private deviceService: DeviceService
  ) {
    this.activeColors = this.themeService.getColors();
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

    this.isMobileBrowser = this.deviceService.getDeviceType() === 'mobile';
    this.microphoneProcessingMode = this.isMobileBrowser ? 'processed' : 'studio';
    this.remoteVideoQualityLevel = this.preferenceToRemoteVideoQualityLevel(
      this.videoService.getRemoteVideoQualityPreference()
    );

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

      const visibleRemoteParticipants = streams.filter(p => !p.isLocal && this.shouldDisplayRemoteParticipant(p));
      this.remoteStreams = visibleRemoteParticipants.map(r => ({
        id: r.id,
        stream: r.stream,
        userData: r.userData || { name: 'Unknown', _id: r.id } as ICharacter,
        participantMeta: r.participantMeta,
        ping: r.ping,
        diagnostics: r.diagnostics
      }));

      this.updateLocalVideoDisplay(streams);

      setTimeout(() => {
        this.remoteVideos.forEach((videoRef, i) => {
          const video = videoRef.nativeElement;
          const stream = this.remoteStreams[i]?.stream;
          if (video && stream && video.srcObject !== stream) {
            video.srcObject = stream;
          }
        });
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
        if (state.source === 'manual' && state.hostId && state.hostId !== this.character.ownerId) return;
      } else {
        // CLIENT: Only obey the Host
        const currentServer = this.serverService.getCurrentServer();
        const actualHostId = currentServer ? this.extractOwnerId(currentServer) : null;

        // Drop the command if it wasn't stamped by the Server Owner
        if (state.hostId && state.hostId !== actualHostId) return;

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
          this.videoService.sendThemeUpdate(this.activeColors);
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

      this.checkServerOwner();
      this.cdr.detectChanges();



  }

  checkServerOwner(){
    const server = this.serverService.getCurrentServer()
    if (server && this.character && this.character.ownerId) {

      this.isServerOwner = this.extractOwnerId(server) === this.character.ownerId;
    } else {
      this.isServerOwner = false;
    }
    console.log("Is Server Owner: ",this.isServerOwner)
  }

  private extractOwnerId(server: IServer): string {
    if (!server.owner) return '';
    return typeof server.owner === 'string' ? server.owner : (server.owner as IUser)._id;
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

      if (this.videoDevices.length && !this.selectedVideoId) this.selectedVideoId = this.videoDevices[0].deviceId;
      if (this.audioDevices.length && !this.selectedAudioId) this.selectedAudioId = this.audioDevices[0].deviceId;
      if (this.audioOutputDevices.length && !this.selectedOutputId) this.selectedOutputId = this.audioOutputDevices[0].deviceId;
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
        this.syncMicInputMonitor();
        await this.applyAudioOutputToAllMedia();
        this.cdr.detectChanges();
      } catch (fallbackErr) {
        console.error('All media access failed', fallbackErr);
      }
    }
  }

  async onDeviceChange() {
    if (this.localStream) {
      await this.replaceActiveMediaStream();
      return;
    }

    await this.startPreview();
  }

  async onMicrophoneProcessingChange() {
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
  }

  async changePcAudioSource(sourceId: CompanionSourceId) {
    await this.videoService.selectAudioSource(sourceId);
  }

  async changeAudioOutput() {
    await this.applyAudioOutputToAllMedia();
  }

  onRemoteVideoQualityChange() {
    this.videoService.setRemoteVideoQualityPreference(
      this.remoteVideoQualityOptions[this.remoteVideoQualityLevel]?.value ?? 'medium'
    );
  }

  get remoteVideoQualityLabel(): string {
    return this.remoteVideoQualityOptions[this.remoteVideoQualityLevel]?.label ?? 'Balanced';
  }

  async joinCall() {
    if (!this.channelId || !this.character || this.isJoining) return;
    this.isJoining = true;

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

  async leaveCall() {
    this.resetMicTestForCaptureChange();
    await this.videoService.leaveCall(this.channelId);
    this.themeService.resetToDefault();
    this.localStream = null;
    this.remoteStreams = [];
    this.showSpotify = false;
    this.stopVtt.emit(this.channelId);
    this.isDmMode = false;
    if (!this.isComponentDestroying) {
        await this.startPreview();
    }
  }

  toggleAudio() {
    if (this.localStream) {
      this.isAudioMuted = !this.isAudioMuted;
      this.localStream.getAudioTracks().forEach(track => (track.enabled = !this.isAudioMuted));
      this.videoService.setMicrophoneEnabled(!this.isAudioMuted);
    } else {
      this.isPreviewMuted = !this.isPreviewMuted;
      if (this.previewStream) {
        this.previewStream.getAudioTracks().forEach(t => t.enabled = !this.isPreviewMuted);
      }
    }
  }

  toggleVideo() {
    if (this.localStream) {
      this.isVideoOff = !this.isVideoOff;
      this.localStream.getVideoTracks().forEach(track => (track.enabled = !this.isVideoOff));
      this.videoService.setCameraEnabled(!this.isVideoOff);
    } else {
      this.isPreviewVideoOff = !this.isPreviewVideoOff;
      if (this.previewStream) {
        this.previewStream.getVideoTracks().forEach(t => t.enabled = !this.isPreviewVideoOff);
      }
    }
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
        const currentServer = this.serverService.getCurrentServer();
        if (currentServer) {
          this.isServerOwner = this.extractOwnerId(currentServer) === newCharacter.ownerId;
        }
      }

      if (!this.isDmMode && this.channelId) {
        this.videoService.updateUserData(this.channelId, newCharacter);
      }
    }

    if (channelIdChange && channelIdChange.currentValue) {
      this.checkServerOwner()
    }
  }

  openCharacter(character: ICharacter | undefined) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  // --- THEME PICKER LOGIC ---

  updateThemeLocally(key: keyof ThemeColors, color: string) {
    this.activeColors = { ...this.activeColors, [key]: color };
    this.themeService.applyTheme(this.activeColors, false);
  }

  confirmTheme() {
    this.themeService.applyTheme(this.activeColors, true);
    this.videoService.sendThemeUpdate(this.activeColors);
    this.showThemePicker = false;
  }

  cancelTheme() {
    this.themeService.revertToSaved();
    this.activeColors = this.themeService.getColors();
    this.showThemePicker = false;
    this.showPinNaming = false;
  }

  resetToFactory() {
    this.themeService.resetToDefault();
    this.activeColors = this.themeService.getColors();
    this.videoService.sendThemeUpdate(this.activeColors);
  }

  selectPinnedTheme(theme: PinnedTheme) {
    this.activeColors = { ...theme.colors };
    this.themeService.applyTheme(this.activeColors, false);
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

  ngOnDestroy() {
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
    if (this.serverDetailsSub) this.serverDetailsSub.unsubscribe();
    if (this.callKickedSub) this.callKickedSub.unsubscribe();
    if (this.companionDevicesSub) this.companionDevicesSub.unsubscribe();
    if (this.selectedVideoSourceSub) this.selectedVideoSourceSub.unsubscribe();
    if (this.selectedAudioSourceSub) this.selectedAudioSourceSub.unsubscribe();
    if (this.remoteVideoQualitySub) this.remoteVideoQualitySub.unsubscribe();

    // Just clean up local hardware previews.
    // The actual call room disconnection is now handled by TabService.closeTab()
    if (this.previewStream) {
      this.previewStream.getTracks().forEach(t => t.stop());
    }
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChangeBound);
  }

  startVttHosting() {
    this.videoService.sendVttCommand('start', this.channelId);
    this.hostVtt.emit(this.channelId);
  }

  startVttJoining() {
    this.joinVtt.emit(this.vttSession.roomId || this.channelId);
    this.showVttNotification = false;
  }

  stopVttSession() {
    this.videoService.sendVttCommand('stop', this.channelId);
    this.stopVtt.emit(this.channelId);
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

  private updateLocalVideoDisplay(participants: any[] = this.videoService.remoteStreams$.value) {
    const displayStream = this.getCompanionLocalStream(participants) || this.localStream;
    if (this.localVideo && displayStream && this.localVideo.nativeElement.srcObject !== displayStream) {
      this.localVideo.nativeElement.srcObject = displayStream;
      void this.applyAudioOutputToAllMedia();
    }
  }

  private async handleCallKickout(reason: string) {
    this.themeService.resetToDefault();
    this.localStream = null;
    this.remoteStreams = [];
    this.showSpotify = false;
    this.stopVtt.emit(this.channelId);
    this.isDmMode = false;
    this.vttSession = { active: false, roomId: null, hostId: null };
    this.lastAutoSelectedCompanionVideoId = null;

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

    for (const element of mediaElements) {
      try {
        await element.setSinkId(this.selectedOutputId);
      } catch (error) {
        console.warn('Failed to switch audio output device', error);
      }
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

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
import { CallParticipantMetadata, CompanionDeviceOption, CompanionSourceId, ParticipantMediaDiagnostics, Video } from '../../../shared/services/video/video';
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

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer, MatIconModule, MatTooltipModule, MatMenuModule, MarkdownComponent]
})
export class Call implements OnInit, OnDestroy, OnChanges {
  private static readonly desktopVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
    aspectRatio: { ideal: 16 / 9 }
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
  @ViewChildren('remoteVideo') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;

  videoDevices: MediaDeviceInfo[] = [];
  audioDevices: MediaDeviceInfo[] = [];
  audioOutputDevices: MediaDeviceInfo[] = [];
  selectedVideoId: string = '';
  selectedAudioId: string = '';
  selectedOutputId: string = '';
  selectedPcVideoSource: CompanionSourceId = 'desktop-local';
  selectedPcAudioSource: CompanionSourceId = 'desktop-local';
  companionDevices: CompanionDeviceOption[] = [];

  localStream: MediaStream | null = null;
  previewStream: MediaStream | null = null;
  remoteStreams: ParticipantStream[] = [];
  localParticipantPing: number | undefined;
  localParticipantDiagnostics?: ParticipantMediaDiagnostics;


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
  readonly supportsAudioOutputSelection = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  private isComponentDestroying = false;
  private lastAutoSelectedCompanionVideoId: string | null = null;
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
    const baseConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    };

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
      await this.applyAudioOutputToAllMedia();
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Preview failed, trying fallback', err);
      try {
        this.previewStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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

  private async replaceActiveMediaStream() {
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

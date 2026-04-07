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
  AfterViewInit
} from '@angular/core';
import { Video } from '../../../shared/services/video/video';
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
import { Theme, ThemeOption, ThemeService } from '../../../shared/services/theme/theme.service';
import { MatMenuModule } from '@angular/material/menu';
import { ServerService } from '../../../shared/services/server/server';
import { IServer } from '../../../shared/models/server/server.model';
import { IUser } from '../../../shared/models/user/user.model';

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer, MatIconModule, MatTooltipModule, MatMenuModule]
})
export class Call implements OnInit, OnDestroy, OnChanges {
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
  selectedVideoId: string = '';
  selectedAudioId: string = '';

  localStream: MediaStream | null = null;
  previewStream: MediaStream | null = null;
  remoteStreams: { id: string; stream: MediaStream; userData: ICharacter }[] = [];

  isAudioMuted = false;
  isVideoOff = false;
  isPreviewMuted = false;
  isPreviewVideoOff = false;
  isJoining = false;

  // UI States
  showSpotify: boolean = false;
  showThemePicker: boolean = false;

  // Theme state
  activeThemeSession: Theme | null = null;
  availableThemes: ThemeOption[] = [];

  // VTT Session state
  vttSession: { active: boolean, roomId: string | null, hostId: string | null } = { active: false, roomId: null, hostId: null };
  showVttNotification: boolean = false;
  private vttNotificationTimeout: any;

  // Broadcast state
  activeOverlayImage: string | null = null;

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
  private vttSub!: Subscription;
  private overlaySub!: Subscription;
  private serverDetailsSub!: Subscription;

  private isComponentDestroying = false;

  constructor(
    private videoService: Video,
    private tabService: TabService,
    public spotify: SpotifyService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    public themeService: ThemeService,
    private serverService: ServerService
  ) {
    this.availableThemes = this.themeService.availableThemes;
  }

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['access_token']) {
        this.spotify.setTokens(params['access_token'], params['refresh_token']);
      }
    });

    await this.loadDevices();

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
      await this.startPreview();
    }

    this.streamSub = this.videoService.remoteStreams$.subscribe(streams => {
      this.remoteStreams = streams.map(r => ({
        id: r.id,
        stream: r.stream,
        userData: r.userData || { name: 'Unknown', _id: r.id } as ICharacter
      }));

      setTimeout(() => {
        this.remoteVideos.forEach((videoRef, i) => {
          const video = videoRef.nativeElement;
          const stream = this.remoteStreams[i]?.stream;
          if (video && stream && video.srcObject !== stream) {
            video.srcObject = stream;
          }
        });
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
        const isDifferentPosition = !currentState || Math.abs(currentState.position - adjustedPosition) > 5000;
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
    this.spotifyActionSub = this.spotify.syncAction$.subscribe(action => {
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

        if (this.activeThemeSession) {
          this.videoService.sendThemeUpdate(this.activeThemeSession);
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

    this.themeSyncSub = this.videoService.themeSync$.subscribe(theme => {
      this.activeThemeSession = theme;
      this.themeService.applyTemporaryTheme(theme);
    });

    this.vttSub = this.videoService.vttSession$.subscribe(session => {
      const wasActive = this.vttSession.active;
      this.vttSession = session;
      if (session.active && !wasActive && session.hostId !== this.character?.name) {
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

  async loadDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');

      if (this.videoDevices.length && !this.selectedVideoId) this.selectedVideoId = this.videoDevices[0].deviceId;
      if (this.audioDevices.length && !this.selectedAudioId) this.selectedAudioId = this.audioDevices[0].deviceId;
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
      const constraints = {
        video: this.selectedVideoId ? { deviceId: { exact: this.selectedVideoId } } : true,
        audio: this.selectedAudioId ? { deviceId: { exact: this.selectedAudioId } } : true
      };

      this.previewStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (this.previewVideo) {
        this.previewVideo.nativeElement.srcObject = this.previewStream;
      }
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
    await this.startPreview();
  }

  async joinCall() {
    if (!this.channelId || !this.character || this.isJoining) return;
    this.isJoining = true;

    try {
      if (this.previewStream && this.previewStream.active) {
        this.localStream = this.previewStream;
        this.previewStream = null;
      } else {
        const constraints = {
          video: this.selectedVideoId ? { deviceId: { exact: this.selectedVideoId } } : true,
          audio: this.selectedAudioId ? { deviceId: { exact: this.selectedAudioId } } : true
        };
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      }

      if (!this.localStream || !this.localStream.active) {
        throw new Error('Acquired stream is not active');
      }

      this.isAudioMuted = this.isPreviewMuted;
      this.isVideoOff = !this.isPreviewVideoOff;

      this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isAudioMuted);
      this.localStream.getVideoTracks().forEach(t => t.enabled = this.isVideoOff);

      const characterToBroadcast = this.isDmMode ? this.dmCharacter : this.character;
      this.videoService.updateUserData(this.channelId, characterToBroadcast);
      await this.videoService.initVideoCall(this.channelId, characterToBroadcast);

      await this.videoService.startProducing(this.localStream);

      setTimeout(() => {
        if (this.localVideo) {
          this.localVideo.nativeElement.srcObject = this.localStream;
        }
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
    this.themeService.revertToSavedTheme();
    this.activeThemeSession = null;
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

  openCharacter(character: ICharacter) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  syncTheme(theme: Theme) {
    this.activeThemeSession = theme;
    this.themeService.applyTemporaryTheme(theme);
    this.videoService.sendThemeUpdate(theme);
  }

  previewTheme(theme: Theme) {
    this.themeService.applyTemporaryTheme(theme);
  }

  clearThemePreview() {
    if (this.activeThemeSession) {
      this.themeService.applyTemporaryTheme(this.activeThemeSession);
    } else {
      this.themeService.revertToSavedTheme();
    }
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
    this.isComponentDestroying = true;
    if (this.streamSub) this.streamSub.unsubscribe();
    if (this.spotifySyncSub) this.spotifySyncSub.unsubscribe();
    if (this.spotifyActionSub) this.spotifyActionSub.unsubscribe();
    if (this.spotifyStateRequestSub) this.spotifyStateRequestSub.unsubscribe();
    if (this.spotifyRequestSub) this.spotifyRequestSub.unsubscribe();
    if (this.themeSyncSub) this.themeSyncSub.unsubscribe();
    if (this.vttSub) this.vttSub.unsubscribe();
    if (this.overlaySub) this.overlaySub.unsubscribe();
    if (this.serverDetailsSub) this.serverDetailsSub.unsubscribe();

    if (this.videoService.currentChannelId === this.channelId) {
      if (this.previewStream) {
        this.previewStream.getTracks().forEach(t => t.stop());
      }
    } else {
      this.leaveCall();
    }
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
  }

  handleSongRequest(request: any) {
      this.spotify.play(request.uri);
      this.removeRequest(request);
  }

  removeRequest(request: any) {
      this.spotifyRequests = this.spotifyRequests.filter(r => r !== request);
  }
}

import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  OnChanges,
  SimpleChanges,
  HostListener,
  ViewChildren,
  QueryList,
  Output,
  EventEmitter,
  ChangeDetectorRef
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

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer, MatIconModule, MatTooltipModule]
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

  // Spotify Control
  showSpotify: boolean = false;

  // VTT Session state
  vttSession: { active: boolean, roomId: string | null, hostId: string | null } = { active: false, roomId: null, hostId: null };
  showVttNotification: boolean = false;
  private vttNotificationTimeout: any;

  private streamSub!: Subscription;
  private spotifySyncSub!: Subscription;
  private spotifyActionSub!: Subscription;
  private vttSub!: Subscription;

  private isComponentDestroying = false;

  constructor(
    private videoService: Video,
    private tabService: TabService,
    public spotify: SpotifyService,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['access_token']) {
        this.spotify.setTokens(params['access_token'], params['refresh_token']);
      }
    });

    await this.loadDevices();

    // Check if there's already an active stream for this channel
    const existingStream = this.videoService.getLocalStream();
    if (existingStream && this.videoService.currentChannelId === this.channelId) {
      this.localStream = existingStream;
      // Sync UI states from tracks
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

    // Subscribe to remote streams
    this.streamSub = this.videoService.remoteStreams$.subscribe(streams => {
      this.remoteStreams = streams.map(r => ({
        id: r.id,
        stream: r.stream,
        userData: r.userData || { name: 'Unknown', _id: r.id } as ICharacter
      }));

      // Bind streams to video elements
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

    // Spotify sync logic
    this.spotifySyncSub = this.videoService.spotifySync$.subscribe(async (state) => {
      if (!state.uri || !this.localStream) return;
      const currentState = await this.spotify.getPlaybackState();
      const isDifferentTrack = currentState?.track_window?.current_track?.uri !== state.uri;
      const drift = state.timestamp ? (Date.now() - state.timestamp) : 0;
      const adjustedPosition = state.position + drift;
      const isDifferentPosition = !currentState || Math.abs(currentState.position - adjustedPosition) > 5000;
      const isDifferentStatus = currentState?.paused !== state.paused;

      if (isDifferentTrack || isDifferentPosition || isDifferentStatus) {
        if (!state.paused) {
          await this.spotify.play(state.uri, adjustedPosition, true);
        } else {
          if (isDifferentTrack) {
             await this.spotify.play(state.uri, state.position, true);
             setTimeout(() => this.spotify.pause(true), 500);
          } else {
             await this.spotify.pause(true);
          }
        }
      }
    });

    this.spotifyActionSub = this.spotify.syncAction$.subscribe(action => {
      if (this.localStream) {
        this.videoService.sendSpotifyCommand(action.command, action.data);
      }
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
  }

  async loadDevices() {
    try {
      // First try to get any permissions
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');

      // Set defaults if not set
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
        // Fallback: Just audio or just video if one fails
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
      // 1. Get the stream (either from preview or fresh)
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

      // 2. Double check the stream is valid
      if (!this.localStream || !this.localStream.active) {
        throw new Error('Acquired stream is not active');
      }

      // 3. Sync UI states
      this.isAudioMuted = this.isPreviewMuted;
      this.isVideoOff = this.isPreviewVideoOff;

      this.localStream.getAudioTracks().forEach(t => t.enabled = !this.isAudioMuted);
      this.localStream.getVideoTracks().forEach(t => t.enabled = !this.isVideoOff);

      // 4. Initialize the video service
      this.videoService.updateUserData(this.channelId, this.character);
      await this.videoService.initVideoCall(this.channelId, this.character);

      // 5. Start broadcasting
      await this.videoService.startProducing(this.localStream);

      // 6. Update local video element
      setTimeout(() => {
        if (this.localVideo) {
          this.localVideo.nativeElement.srcObject = this.localStream;
        }
      }, 100);

    } catch (err) {
      console.error('[CRITICAL] Join call failed:', err);
      // Clean up on failure
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => t.stop());
        this.localStream = null;
      }
      this.isJoining = false;
      await this.startPreview(); // Restore preview so they can try again
    } finally {
      this.isJoining = false;
      this.cdr.detectChanges();
    }
  }

  async leaveCall() {
    await this.videoService.leaveCall(this.channelId);
    this.localStream = null;
    this.remoteStreams = [];
    this.showSpotify = false;
    this.stopVtt.emit(this.channelId);
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
    const currentCharacter = changes['character']?.currentValue;
    if (currentCharacter && this.channelId && this.localStream) {
      this.videoService.updateUserData(this.channelId, currentCharacter);
    }
  }

  openCharacter(character: ICharacter) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  @HostListener('window:beforeunload')
  async handleBeforeUnload() {
    this.isComponentDestroying = true;
    // Ensure leaveCall is always called on full page unload
    await this.leaveCall();
  }

  ngOnDestroy() {
    this.isComponentDestroying = true;
    if (this.streamSub) this.streamSub.unsubscribe();
    if (this.spotifySyncSub) this.spotifySyncSub.unsubscribe();
    if (this.spotifyActionSub) this.spotifyActionSub.unsubscribe();
    if (this.vttSub) this.vttSub.unsubscribe();

    // If the videoService is still connected to this channel, it means the tab is being moved,
    // so we don't want to disconnect the call.
    if (this.videoService.currentChannelId === this.channelId) {
      // Just stop the preview stream if it's active, as the component is being destroyed.
      if (this.previewStream) {
        this.previewStream.getTracks().forEach(t => t.stop());
      }
    } else {
      // If the videoService is NOT connected to this channel, it means the tab is truly closing
      // or the videoService has already disconnected. In this case, ensure we leave the call.
      // The leaveCall() method already handles stopping the localStream and disconnecting.
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
}

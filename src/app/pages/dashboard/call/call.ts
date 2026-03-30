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
  QueryList
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

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  styleUrls: ['./call.scss'],
  standalone: true,
  imports: [FormsModule, NgForOf, NgIf, AsyncPipe, SpotifyPlayer]
})
export class Call implements OnInit, OnDestroy, OnChanges {
  @Input() channelId!: string;
  @Input() character!: ICharacter;

  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChildren('remoteVideo') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;

  videoDevices: MediaDeviceInfo[] = [];
  audioDevices: MediaDeviceInfo[] = [];
  selectedVideoId: string = '';
  selectedAudioId: string = '';

  localStream: MediaStream | null = null;
  remoteStreams: { id: string; stream: MediaStream; userData: ICharacter }[] = [];

  isAudioMuted = false;
  isVideoOff = false;

  // Spotify Control
  showSpotify: boolean = false;

  private streamSub!: Subscription;

  constructor(
    private videoService: Video,
    private tabService: TabService,
    public spotify: SpotifyService,
    private route: ActivatedRoute
  ) {}

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['access_token']) {
        this.spotify.setTokens(params['access_token'], params['refresh_token']);
      }
    });

    await this.loadDevices();

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
  }

  async ngOnChanges(changes: SimpleChanges) {
    const currentCharacter = changes['character']?.currentValue;
    if (currentCharacter && this.channelId) {
      this.videoService.updateUserData(this.channelId, currentCharacter);
    }
  }

  async loadDevices() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: {
          width: { min: 1280 },   // Force 720p
          height: { min: 720 },
          frameRate: { ideal: 30 }
        } });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');

      if (this.videoDevices.length) this.selectedVideoId = this.videoDevices[0].deviceId;
      if (this.audioDevices.length) this.selectedAudioId = this.audioDevices[0].deviceId;
    } catch (err) {
      console.error('Could not access media devices', err);
    }
  }

  async joinCall() {
    if (!this.channelId || !this.character) return;

    try {
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => t.stop());
      }

      const constraints: MediaStreamConstraints = {
        video: {
          deviceId: this.selectedVideoId ? { exact: this.selectedVideoId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: this.selectedAudioId ? { deviceId: { exact: this.selectedAudioId } } : true
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (this.localVideo?.nativeElement) {
        this.localVideo.nativeElement.srcObject = this.localStream;
        this.localVideo.nativeElement.muted = true;
        await this.localVideo.nativeElement.play();
      }

      this.videoService.updateUserData(this.channelId, this.character);
      await this.videoService.initVideoCall(this.channelId, this.character);
      await this.videoService.startProducing(this.localStream);

    } catch (err) {
      console.error('[ERROR] Join call failed:', err);
    }
  }

  async leaveCall() {
    await this.videoService.leaveCall(this.channelId);

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.remoteStreams = [];
    this.isAudioMuted = false;
    this.isVideoOff = false;
    this.showSpotify = false;
  }

  toggleAudio() {
    if (this.localStream) {
      this.isAudioMuted = !this.isAudioMuted;
      this.localStream.getAudioTracks().forEach(track => (track.enabled = !this.isAudioMuted));
    }
  }

  toggleVideo() {
    if (this.localStream) {
      this.isVideoOff = !this.isVideoOff;
      this.localStream.getVideoTracks().forEach(track => (track.enabled = !this.isVideoOff));
    }
  }

  openCharacter(character: ICharacter) {
    if (character?._id) {
      this.tabService.openTab(character._id, character.name, 'character', 'right', character);
    }
  }

  @HostListener('window:beforeunload')
  async handleBeforeUnload() {
    await this.leaveCall();
  }

  ngOnDestroy() {
    if (this.streamSub) this.streamSub.unsubscribe();
    this.leaveCall();
  }
}

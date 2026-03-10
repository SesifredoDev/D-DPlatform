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
import { NgForOf, NgIf } from '@angular/common';
import { ICharacter } from '../../../shared/models/user/character.model';
import { TabService } from '../../../shared/services/tab/tab-service';

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  imports: [FormsModule, NgForOf, NgIf],
  styleUrls: ['./call.scss']
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

  private streamSub!: Subscription;

  constructor(private videoService: Video, private tabService: TabService) {}

  async ngOnInit() {
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
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
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
      // 1. Get local media first
      if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());

      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: this.selectedVideoId ? { deviceId: { exact: this.selectedVideoId } } : true,
        audio: this.selectedAudioId ? { deviceId: { exact: this.selectedAudioId } } : true
      });

      if (this.localVideo?.nativeElement) {
        this.localVideo.nativeElement.srcObject = this.localStream;
        this.localVideo.nativeElement.muted = true;
        await this.localVideo.nativeElement.play();
      }

      // 2. Update user metadata
      this.videoService.updateUserData(this.channelId, this.character);

      // 3. Initialize Mediasoup (transports, consume existing producers)
      await this.videoService.initVideoCall(this.channelId, this.character);

      // 4. Start producing local tracks
      await this.videoService.startProducing(this.localStream);

      console.log('[DEBUG] Successfully joined call');
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

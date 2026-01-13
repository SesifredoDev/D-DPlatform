import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { Video } from '../../../shared/services/video/video';
import { Subscription } from 'rxjs';
import {FormsModule} from '@angular/forms';
import {NgForOf} from '@angular/common';

@Component({
  selector: 'app-video-call',
  templateUrl: './call.html',
  imports: [
    FormsModule,
    NgForOf
  ],
  styleUrls: ['./call.scss']
})
export class Call implements OnInit, OnDestroy {
  @Input() channelId!: string;
  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;

  videoDevices: MediaDeviceInfo[] = [];
  selectedVideoId: string = '';
  localStream: MediaStream | null = null;
  remoteStreams: { id: string; stream: MediaStream }[] = [];
  private streamSub!: Subscription;

  constructor(private videoService: Video) {}

  async ngOnInit() {
    await this.loadDevices();
    this.streamSub = this.videoService.remoteStreams$.subscribe(streams => {
      this.remoteStreams = streams;
    });
  }

  async loadDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.videoDevices = devices.filter(d => d.kind === 'videoinput');
    if (this.videoDevices.length > 0) this.selectedVideoId = this.videoDevices[0].deviceId;
  }

  async joinCall() {
    try {
      await this.videoService.initVideoCall(this.channelId);

      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: this.selectedVideoId ? { exact: this.selectedVideoId } : undefined },
        audio: true
      });

      if (this.localVideo) {
        this.localVideo.nativeElement.srcObject = this.localStream;
      }

      await this.videoService.startProducing(this.channelId, this.localStream);
    } catch (err) {
      console.error('Join failed', err);
    }
  }

  ngOnDestroy() {
    if (this.streamSub) this.streamSub.unsubscribe();
    this.localStream?.getTracks().forEach(t => t.stop());
  }
}

import { Injectable } from '@angular/core';
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Track,
  LocalVideoTrack,
  LocalAudioTrack,
  createLocalVideoTrack,
  createLocalAudioTrack,
  DataPacket_Kind
} from 'livekit-client';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { TokenService } from '../auth/token';

@Injectable({ providedIn: 'root' })
export class Video {
  private room: Room;
  public remoteStreams$ = new BehaviorSubject<any[]>([]);
  public spotifySync$ = new Subject<any>();
  public vttSession$ = new BehaviorSubject<{ active: boolean, roomId: string | null, hostId: string | null }>({ active: false, roomId: null, hostId: null });

  constructor(private tokenService: TokenService) {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    this.setupRoomListeners();
  }

  private setupRoomListeners() {
    this.room
      .on(RoomEvent.TrackSubscribed, () => this.emitParticipants())
      .on(RoomEvent.TrackUnsubscribed, () => this.emitParticipants())
      .on(RoomEvent.ParticipantConnected, () => this.emitParticipants())
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          this.emitParticipants();
          if (this.vttSession$.value.hostId === participant.identity) {
              this.vttSession$.next({ active: false, roomId: null, hostId: null });
          }
      })
      .on(RoomEvent.ParticipantMetadataChanged, () => this.emitParticipants())
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === 'spotify-sync') {
            this.spotifySync$.next({
              ...data.data,
              from: participant?.identity,
              command: data.command
            });
          } else if (data.type === 'vtt-session') {
            this.vttSession$.next({
              active: data.command === 'start',
              roomId: data.roomId,
              hostId: data.command === 'start' ? participant?.identity || null : null
            });
          }
        } catch (e) {
          console.error('Failed to parse data message', e);
        }
      });
  }

  async initVideoCall(channelId: string, character: any) {
    const token = await this.getLiveKitToken(channelId, character.name);
    await this.room.connect(environment.livekitUrl, token);

    if (character) {
        await this.room.localParticipant.setMetadata(JSON.stringify(character));
    }

    this.emitParticipants();
  }

  async updateUserData(channelId: string, character: any) {
    if (this.room.state === 'connected') {
      await this.room.localParticipant.setMetadata(JSON.stringify(character));
    }
  }

  async startProducing(stream: MediaStream) {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (videoTrack) {
      await this.room.localParticipant.publishTrack(videoTrack, { name: 'video' });
    }
    if (audioTrack) {
      await this.room.localParticipant.publishTrack(audioTrack, { name: 'audio' });
    }
  }

  sendSpotifyCommand(command: string, data: any) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'spotify-sync',
      command,
      data: {
        ...data,
        timestamp: Date.now()
      }
    }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  sendVttCommand(command: 'start' | 'stop', roomId: string) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'vtt-session',
      command,
      roomId
    }));
    this.room.localParticipant.publishData(payload, { reliable: true });

    if (command === 'start') {
        this.vttSession$.next({ active: true, roomId, hostId: this.room.localParticipant.identity });
    } else {
        this.vttSession$.next({ active: false, roomId: null, hostId: null });
    }
  }

  private emitParticipants() {
    const participants = Array.from(this.room.remoteParticipants.values()).map(p => ({
      id: p.identity,
      userData: this.parseMetadata(p.metadata),
      stream: this.getStreamFromParticipant(p)
    }));
    this.remoteStreams$.next(participants);
  }

  private parseMetadata(metadata: string | undefined): any {
    try {
      return metadata ? JSON.parse(metadata) : {};
    } catch {
      return {};
    }
  }

  private getStreamFromParticipant(participant: RemoteParticipant): MediaStream {
    const stream = new MediaStream();
    participant.getTrackPublications().forEach(pub => {
      if (pub.track && pub.track.mediaStreamTrack) {
        stream.addTrack(pub.track.mediaStreamTrack);
      }
    });
    return stream;
  }

  async leaveCall(channelId?: string) {
    if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
        this.sendVttCommand('stop', this.vttSession$.value.roomId!);
    }
    await this.room.disconnect();
    this.remoteStreams$.next([]);
    this.vttSession$.next({ active: false, roomId: null, hostId: null });
  }

  private async getLiveKitToken(room: string, identity: string) {
    const url = `${environment.apiURL}livekit/token?room=${room}&identity=${encodeURIComponent(identity)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error('Failed to fetch LiveKit token');
    }
    const data = await res.json();
    return data.token;
  }
}

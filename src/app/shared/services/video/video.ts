import { Injectable } from '@angular/core';
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RoomConnectOptions,
  setLogLevel,
  DataPacket_Kind,
  RemoteTrackPublication,
  RemoteTrack,
  Participant
} from 'livekit-client';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ThemeColors } from '../theme/theme.service';

@Injectable({ providedIn: 'root' })
export class Video {
  private room: Room;
  public remoteStreams$ = new BehaviorSubject<any[]>([]);
  public spotifySync$ = new Subject<any>();
  public spotifyStateRequest$ = new Subject<{ from: string }>();
  public spotifyRequest$ = new Subject<any>();
  public themeSync$ = new Subject<ThemeColors>();
  public vttSession$ = new BehaviorSubject<{ active: boolean, roomId: string | null, hostId: string | null }>({ active: false, roomId: null, hostId: null });
  public overlayImage$ = new Subject<string | null>();
  public overlayText$ = new Subject<string | null>();

  private localStream: MediaStream | null = null;
  public currentChannelId: string | null = null;

  // Cache streams to prevent desync/re-creation lag
  private participantStreams = new Map<string, MediaStream>();
  private pingInterval: any;

  constructor() {
    setLogLevel('debug');
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    this.setupRoomListeners();
  }

  private setupRoomListeners() {
    this.room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          this.updateParticipantStream(participant);
          this.emitParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          this.updateParticipantStream(participant);
          this.emitParticipants();
      })
      .on(RoomEvent.TrackMuted, () => this.emitParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.emitParticipants())
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
          this.emitParticipants();
          if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
              this.sendVttCommand('start', this.vttSession$.value.roomId!);
          }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          this.participantStreams.delete(participant.identity);
          this.emitParticipants();
          if (this.vttSession$.value.hostId === participant.identity) {
              this.vttSession$.next({ active: false, roomId: null, hostId: null });
          }
      })
      .on(RoomEvent.ParticipantMetadataChanged, () => this.emitParticipants())
      .on(RoomEvent.ConnectionStateChanged, (state) => {
          if (state === 'connected') {
              this.startPingMonitor();
          } else {
              this.stopPingMonitor();
          }
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === 'spotify-sync') {
            this.spotifySync$.next({
              ...data.data,
              from: participant?.identity,
              command: data.command,
              source: data.source || 'manual'
            });
          } else if (data.type === 'spotify-state-request') {
            this.spotifyStateRequest$.next({ from: participant?.identity || '' });
          } else if (data.type === 'spotify-request') {
            this.spotifyRequest$.next({
                ...data.data,
                from: participant?.identity || 'Unknown',
                fromName: data.fromName || 'Unknown Player'
            });
          } else if (data.type === 'theme-sync') {
            this.themeSync$.next(data.theme);
          } else if (data.type === 'vtt-session') {
            this.vttSession$.next({
              active: data.command === 'start',
              roomId: data.roomId,
              hostId: data.command === 'start' ? participant?.identity || null : null
            });
          } else if (data.type === 'overlay-image') {
            this.overlayImage$.next(data.url);
          } else if (data.type === 'overlay-text') {
            this.overlayText$.next(data.text);
          }
        } catch (e) {
          console.error('Failed to parse data message', e);
        }
      });
  }

  private startPingMonitor() {
      this.stopPingMonitor();
      this.pingInterval = setInterval(() => this.emitParticipants(), 3000);
  }

  private stopPingMonitor() {
      if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
      }
  }

  private updateParticipantStream(participant: RemoteParticipant) {
    let stream = this.participantStreams.get(participant.identity);
    if (!stream) {
        stream = new MediaStream();
        this.participantStreams.set(participant.identity, stream);
    }

    // Clear old tracks and add current ones
    stream.getTracks().forEach(t => stream!.removeTrack(t));
    participant.getTrackPublications().forEach(pub => {
      if (pub.track && pub.track.mediaStreamTrack) {
          stream!.addTrack(pub.track.mediaStreamTrack);
      }
    });
  }

  async initVideoCall(channelId: string, character: any) {
    if (this.room.state === 'connected' && this.currentChannelId === channelId) return;
    try {
      const data = await this.getLiveKitConnectionInfo(channelId, character.name);
      const connectOptions: RoomConnectOptions = {
        autoSubscribe: true,
        rtcConfig: { iceServers: data.iceServers }
      };
      await this.room.connect(environment.livekitUrl, data.token, connectOptions);
      this.currentChannelId = channelId;
      if (character) await this.room.localParticipant.setMetadata(JSON.stringify(character));
      this.emitParticipants();
    } catch (error) { throw error; }
  }

  async updateUserData(channelId: string, character: any) {
    if (this.room.state === 'connected') {
      await this.room.localParticipant.setMetadata(JSON.stringify(character));
    }
  }

  async startProducing(stream: MediaStream) {
    if (this.localStream === stream && this.room.localParticipant.getTrackPublications().length > 0) return;
    this.localStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    if (videoTrack) await this.room.localParticipant.publishTrack(videoTrack, { name: 'video' });
    if (audioTrack) await this.room.localParticipant.publishTrack(audioTrack, { name: 'audio' });
  }

  async setCameraEnabled(enabled: boolean) {
    if (this.room.state === 'connected') {
        await this.room.localParticipant.setCameraEnabled(enabled);
    }
  }

  async setMicrophoneEnabled(enabled: boolean) {
    if (this.room.state === 'connected') {
        await this.room.localParticipant.setMicrophoneEnabled(enabled);
    }
  }

  sendSpotifyCommand(command: string, data: any, source: string = 'manual') {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'spotify-sync',
      command,
      source,
      data: { ...data, timestamp: Date.now() }
    }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  sendSpotifyRequest(item: any, fromName: string) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'spotify-request',
      fromName,
      data: {
          uri: item.uri,
          name: item.name,
          artist: item.artist || item.owner || '',
          image: item.image || (item.images?.[0]?.url) || (item.album?.images?.[0]?.url) || ''
      }
    }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  sendThemeUpdate(theme: ThemeColors) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'theme-sync', theme }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  requestSpotifyState() {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'spotify-state-request' }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  sendVttCommand(command: 'start' | 'stop', roomId: string) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'vtt-session', command, roomId }));
    this.room.localParticipant.publishData(payload, { reliable: true });
    if (command === 'start') this.vttSession$.next({ active: true, roomId, hostId: this.room.localParticipant.identity });
    else this.vttSession$.next({ active: false, roomId: null, hostId: null });
  }

  broadcastOverlayImage(url: string | null) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'overlay-image', url }));
    this.room.localParticipant.publishData(payload, { reliable: true });
    this.overlayImage$.next(url);
  }

  broadcastOverlayText(text: string | null) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'overlay-text', text }));
    this.room.localParticipant.publishData(payload, { reliable: true });
    this.overlayText$.next(text);
  }

  private emitParticipants() {
    const timestamp = new Date().toLocaleTimeString();
    const participants = Array.from(this.room.remoteParticipants.values()).map(p => {
      if (!this.participantStreams.has(p.identity)) {
          this.updateParticipantStream(p);
      }
      const rtt = (p as any).getRTT ? (p as any).getRTT() : (p as any).lastPingRTT;
      if (rtt !== undefined) {
          console.log(`[${timestamp}] Ping for ${p.identity}: ${rtt}ms`);
      }
      return {
        id: p.identity,
        userData: this.parseMetadata(p.metadata),
        stream: this.participantStreams.get(p.identity),
        ping: rtt
      };
    });

    const localRTT = (this.room.localParticipant as any).getRTT ? (this.room.localParticipant as any).getRTT() : (this.room.localParticipant as any).lastPingRTT;
    if (localRTT !== undefined) {
        console.log(`[${timestamp}] Local Ping: ${localRTT}ms`);
    }

    this.remoteStreams$.next([{
        id: 'local',
        ping: localRTT,
        isLocal: true
    }, ...participants]);
  }

  private parseMetadata(metadata: string | undefined): any {
    try { return metadata ? JSON.parse(metadata) : {}; } catch { return {}; }
  }

  async leaveCall(channelId?: string) {
    this.stopPingMonitor();
    if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
        this.sendVttCommand('stop', this.vttSession$.value.roomId!);
    }
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    await this.room.disconnect();
    this.remoteStreams$.next([]);
    this.participantStreams.clear();
    this.vttSession$.next({ active: false, roomId: null, hostId: null });
    this.localStream = null;
    this.currentChannelId = null;
  }

  getLocalStream() { return this.localStream; }

  private async getLiveKitConnectionInfo(room: string, identity: string) {
    const url = `${environment.apiURL}livekit/token?room=${room}&identity=${encodeURIComponent(identity)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch LiveKit connection info');
    return await res.json();
  }
}

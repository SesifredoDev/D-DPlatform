import { Injectable } from '@angular/core';
import {
  AudioPresets,
  Room,
  RoomEvent,
  RemoteParticipant,
  RoomConnectOptions,
  setLogLevel,
  RemoteTrackPublication,
  RemoteTrack,
  ParticipantTrackPermission,
  TrackPublishOptions,
  VideoPresets
} from 'livekit-client';
import { BehaviorSubject, Subject } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ThemeColors } from '../theme/theme.service';
import { DeviceInfo, DeviceService } from '../device/device';

export type CallDeviceRole = 'desktop-main' | 'phone-camera';
export type CompanionSourceId = 'desktop-local' | string;

export interface CallParticipantMetadata {
  userId: string;
  deviceId: string;
  deviceType: DeviceInfo['deviceType'];
  deviceRole: CallDeviceRole;
  character: any;
}

export interface CompanionDeviceOption {
  identity: string;
  deviceId: string;
  deviceType: DeviceInfo['deviceType'];
  label: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

@Injectable({ providedIn: 'root' })
export class Video {
  private static readonly cameraPublishOptions: TrackPublishOptions = {
    audioPreset: AudioPresets.speech,
    dtx: true,
    red: true,
    simulcast: true,
    videoCodec: 'vp8',
    videoEncoding: VideoPresets.h720.encoding,
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    degradationPreference: 'maintain-resolution',
  };

  private room: Room;
  public remoteStreams$ = new BehaviorSubject<any[]>([]);
  public spotifySync$ = new Subject<any>();
  public spotifyStateRequest$ = new Subject<{ from: string }>();
  public spotifyRequest$ = new Subject<any>();
  public themeSync$ = new Subject<ThemeColors>();
  public vttSession$ = new BehaviorSubject<{ active: boolean, roomId: string | null, hostId: string | null }>({ active: false, roomId: null, hostId: null });
  public overlayImage$ = new Subject<string | null>();
  public overlayText$ = new Subject<string | null>();
  public callKicked$ = new Subject<string>();
  public readonly deviceInfo$;
  public readonly companionDevices$ = new BehaviorSubject<CompanionDeviceOption[]>([]);
  public readonly selectedVideoSource$ = new BehaviorSubject<CompanionSourceId>('desktop-local');
  public readonly selectedAudioSource$ = new BehaviorSubject<CompanionSourceId>('desktop-local');

  private localStream: MediaStream | null = null;
  public currentChannelId: string | null = null;

  private participantStreams = new Map<string, MediaStream>();
  private pingInterval: any;
  private currentParticipantMetadata: CallParticipantMetadata | null = null;
  private currentParticipantIdentity: string | null = null;
  private phoneCompanionTargetIdentity: string | null = null;
  private forwardedCompanionVideoTrack: MediaStreamTrack | null = null;
  private forwardedCompanionAudioTrack: MediaStreamTrack | null = null;
  private activeCompanionVideoIdentity: string | null = null;
  private activeCompanionAudioIdentity: string | null = null;
  private companionSyncPromise: Promise<void> | null = null;
  private currentVideoPublicationTrack: MediaStreamTrack | null = null;
  private currentAudioPublicationTrack: MediaStreamTrack | null = null;

  constructor(private deviceService: DeviceService) {
    setLogLevel(environment.production ? 'warn' : 'info');
    this.deviceInfo$ = this.deviceService.deviceInfo$;
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
        void this.syncCompanionState();
        this.emitParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        void this.syncCompanionState();
        this.emitParticipants();
      })
      .on(RoomEvent.TrackMuted, () => {
        void this.syncCompanionState();
        this.emitParticipants();
      })
      .on(RoomEvent.TrackUnmuted, () => {
        void this.syncCompanionState();
        this.emitParticipants();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        void this.syncCompanionState();
        this.emitParticipants();
        if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
          this.sendVttCommand('start', this.vttSession$.value.roomId!);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.participantStreams.delete(participant.identity);
        void this.syncCompanionState();
        this.emitParticipants();
        if (this.vttSession$.value.hostId === participant.identity) {
          this.vttSession$.next({ active: false, roomId: null, hostId: null });
        }
      })
      .on(RoomEvent.ParticipantMetadataChanged, () => {
        void this.syncCompanionState();
        this.emitParticipants();
      })
      .on(RoomEvent.Disconnected, (reason?: unknown) => {
        this.stopPingMonitor();
        const reasonText = String(reason ?? '');
        if (reasonText.includes('DUPLICATE_IDENTITY')) {
          this.resetCallState();
          this.callKicked$.next('duplicate_identity');
        }
      })
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

    stream.getTracks().forEach(t => stream!.removeTrack(t));
    participant.getTrackPublications().forEach(pub => {
      if (pub.track && pub.track.mediaStreamTrack) {
        stream!.addTrack(pub.track.mediaStreamTrack);
      }
    });
  }

  async initVideoCall(channelId: string, userId: string, character: any) {
    if (this.room.state === 'connected' && this.currentChannelId === channelId) return;

    try {
      const deviceInfo = this.deviceService.getDeviceInfo();
      const deviceRole = this.resolveDeviceRole(deviceInfo);
      const identity = this.buildParticipantIdentity(userId, deviceInfo.deviceId);
      const metadata = this.buildParticipantMetadata(userId, deviceInfo, deviceRole, character);
      const data = await this.getLiveKitConnectionInfo(channelId, identity);
      const connectOptions: RoomConnectOptions = {
        autoSubscribe: deviceRole !== 'phone-camera',
        rtcConfig: { iceServers: data.iceServers }
      };

      await this.room.connect(environment.livekitUrl, data.token, connectOptions);
      this.currentChannelId = channelId;
      this.currentParticipantIdentity = identity;
      this.currentParticipantMetadata = metadata;
      await this.room.localParticipant.setMetadata(JSON.stringify(metadata));

      if (deviceRole === 'phone-camera') {
        const desktopIdentity = this.findDesktopMainIdentityForUser(userId);
        if (!desktopIdentity) {
          await this.room.disconnect();
          this.resetCallState();
          this.callKicked$.next('phone_requires_desktop');
          throw new Error('Phone companion requires an active desktop session');
        }
        this.phoneCompanionTargetIdentity = desktopIdentity;
      } else {
        this.phoneCompanionTargetIdentity = null;
      }

      await this.syncCompanionState();
      this.emitParticipants();
    } catch (error) {
      throw error;
    }
  }

  async updateUserData(channelId: string, character: any) {
    if (this.room.state === 'connected' && this.currentParticipantMetadata) {
      const deviceInfo = this.deviceService.getDeviceInfo();
      this.currentParticipantMetadata = this.buildParticipantMetadata(
        this.currentParticipantMetadata.userId,
        deviceInfo,
        this.resolveDeviceRole(deviceInfo),
        character
      );
      await this.room.localParticipant.setMetadata(JSON.stringify(this.currentParticipantMetadata));
      this.emitParticipants();
    }
  }

  async startProducing(stream: MediaStream) {
    this.localStream = stream;
    await this.applyPublishedTracks();
    if (this.currentParticipantMetadata?.deviceRole === 'phone-camera') {
      this.updatePhoneTrackPermissions();
    }
    await this.syncCompanionState();
  }

  async setCameraEnabled(enabled: boolean) {
    const currentTrack = this.forwardedCompanionVideoTrack || this.currentVideoPublicationTrack;
    if (currentTrack) {
      currentTrack.enabled = enabled;
      return;
    }

    if (this.room.state === 'connected') {
      await this.room.localParticipant.setCameraEnabled(enabled);
    }
  }

  async setMicrophoneEnabled(enabled: boolean) {
    const currentTrack = this.forwardedCompanionAudioTrack || this.currentAudioPublicationTrack;
    if (currentTrack) {
      currentTrack.enabled = enabled;
      return;
    }

    if (this.room.state === 'connected') {
      await this.room.localParticipant.setMicrophoneEnabled(enabled);
    }
  }

  async selectVideoSource(sourceId: CompanionSourceId) {
    this.selectedVideoSource$.next(sourceId);
    await this.syncCompanionState();
  }

  async selectAudioSource(sourceId: CompanionSourceId) {
    this.selectedAudioSource$.next(sourceId);
    await this.syncCompanionState();
  }

  getSelectedVideoSource(): CompanionSourceId {
    return this.selectedVideoSource$.value;
  }

  getSelectedAudioSource(): CompanionSourceId {
    return this.selectedAudioSource$.value;
  }

  getSelectedCompanionVideoStream(): MediaStream | null {
    if (this.selectedVideoSource$.value === 'desktop-local') return null;
    return this.participantStreams.get(this.selectedVideoSource$.value) || null;
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
        image: item.image || item.images?.[0]?.url || item.album?.images?.[0]?.url || ''
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

      const participantMeta = this.parseMetadata(p.metadata);
      const rtt = (p as any).getRTT ? (p as any).getRTT() : (p as any).lastPingRTT;
      if (rtt !== undefined) {
        console.log(`[${timestamp}] Ping for ${p.identity}: ${rtt}ms`);
      }

      return {
        id: p.identity,
        userData: participantMeta?.character || {},
        participantMeta,
        stream: this.participantStreams.get(p.identity),
        ping: rtt
      };
    });

    this.companionDevices$.next(this.buildCompanionDeviceOptions(participants));

    const localRTT = (this.room.localParticipant as any).getRTT ? (this.room.localParticipant as any).getRTT() : (this.room.localParticipant as any).lastPingRTT;
    if (localRTT !== undefined) {
      console.log(`[${timestamp}] Local Ping: ${localRTT}ms`);
    }

    this.remoteStreams$.next([{
      id: 'local',
      ping: localRTT,
      isLocal: true,
      participantMeta: this.currentParticipantMetadata
    }, ...participants]);
  }

  private buildCompanionDeviceOptions(participants: any[]): CompanionDeviceOption[] {
    if (!this.currentParticipantMetadata || this.currentParticipantMetadata.deviceRole === 'phone-camera') {
      return [];
    }

    return participants
      .filter(participant => {
        const metadata = participant.participantMeta as CallParticipantMetadata | null;
        return metadata?.userId === this.currentParticipantMetadata?.userId && metadata?.deviceRole === 'phone-camera';
      })
      .map((participant, index) => {
        const metadata = participant.participantMeta as CallParticipantMetadata;
        const stream = participant.stream as MediaStream | undefined;
        return {
          identity: participant.id,
          deviceId: metadata.deviceId,
          deviceType: metadata.deviceType,
          label: `${metadata.deviceType === 'mobile' ? 'Mobile' : 'Companion'} ${index + 1}`,
          hasVideo: !!stream?.getVideoTracks().length,
          hasAudio: !!stream?.getAudioTracks().length,
        };
      });
  }

  private parseMetadata(metadata: string | undefined): CallParticipantMetadata | null {
    try {
      return metadata ? JSON.parse(metadata) : null;
    } catch {
      return null;
    }
  }

  async leaveCall(channelId?: string) {
    this.stopPingMonitor();
    if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
      this.sendVttCommand('stop', this.vttSession$.value.roomId!);
    }
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    await this.room.disconnect();
    this.resetCallState();
  }

  getLocalStream() { return this.localStream; }

  getCurrentDeviceInfo(): DeviceInfo {
    return this.deviceService.getDeviceInfo();
  }

  getCurrentParticipantIdentity(): string | null {
    return this.currentParticipantIdentity;
  }

  getCurrentParticipantMetadata(): CallParticipantMetadata | null {
    return this.currentParticipantMetadata;
  }

  private resetCallState() {
    this.remoteStreams$.next([]);
    this.companionDevices$.next([]);
    this.selectedVideoSource$.next('desktop-local');
    this.selectedAudioSource$.next('desktop-local');
    this.participantStreams.clear();
    this.vttSession$.next({ active: false, roomId: null, hostId: null });
    this.localStream = null;
    this.currentChannelId = null;
    this.currentParticipantMetadata = null;
    this.currentParticipantIdentity = null;
    this.phoneCompanionTargetIdentity = null;
    this.currentVideoPublicationTrack = null;
    this.currentAudioPublicationTrack = null;
    this.activeCompanionVideoIdentity = null;
    this.activeCompanionAudioIdentity = null;
    if (this.forwardedCompanionVideoTrack) {
      this.forwardedCompanionVideoTrack.stop();
      this.forwardedCompanionVideoTrack = null;
    }
    if (this.forwardedCompanionAudioTrack) {
      this.forwardedCompanionAudioTrack.stop();
      this.forwardedCompanionAudioTrack = null;
    }
  }

  private buildParticipantIdentity(userId: string, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  private buildParticipantMetadata(
    userId: string,
    deviceInfo: DeviceInfo,
    deviceRole: CallDeviceRole,
    character: any
  ): CallParticipantMetadata {
    return {
      userId,
      deviceId: deviceInfo.deviceId,
      deviceType: deviceInfo.deviceType,
      deviceRole,
      character
    };
  }

  private resolveDeviceRole(deviceInfo: DeviceInfo): CallDeviceRole {
    return deviceInfo.deviceType === 'mobile' ? 'phone-camera' : 'desktop-main';
  }

  private findDesktopMainIdentityForUser(userId: string): string | null {
    const desktopParticipant = Array.from(this.room.remoteParticipants.values()).find(p => {
      const metadata = this.parseMetadata(p.metadata);
      return metadata?.userId === userId && metadata?.deviceRole === 'desktop-main';
    });

    return desktopParticipant?.identity || null;
  }

  private updatePhoneTrackPermissions() {
    if (!this.phoneCompanionTargetIdentity) return;

    const permissions: ParticipantTrackPermission[] = [{
      participantIdentity: this.phoneCompanionTargetIdentity,
      allowAll: true
    }];

    this.room.localParticipant.setTrackSubscriptionPermissions(false, permissions);
  }

  private async syncCompanionState() {
    if (this.companionSyncPromise) {
      return this.companionSyncPromise;
    }

    this.companionSyncPromise = this.performCompanionSync();
    try {
      await this.companionSyncPromise;
    } finally {
      this.companionSyncPromise = null;
    }
  }

  private async performCompanionSync() {
    if (!this.currentParticipantMetadata) return;

    if (this.currentParticipantMetadata.deviceRole === 'phone-camera') {
      const desktopIdentity = this.findDesktopMainIdentityForUser(this.currentParticipantMetadata.userId);
      if (!desktopIdentity) {
        if (this.room.state === 'connected') {
          await this.room.disconnect();
        }
        this.resetCallState();
        this.callKicked$.next('desktop_missing');
        return;
      }

      this.phoneCompanionTargetIdentity = desktopIdentity;
      this.updatePhoneTrackPermissions();
      return;
    }

    await this.applyPublishedTracks();
  }

  private async applyPublishedTracks() {
    if (this.room.state !== 'connected') return;

    await this.applyVideoSource();
    await this.applyAudioSource();
  }

  private async applyVideoSource() {
    const nextSource = this.resolveVideoTrack();
    if (this.currentVideoPublicationTrack === nextSource.track) return;

    if (this.currentVideoPublicationTrack) {
      await this.room.localParticipant.unpublishTrack(this.currentVideoPublicationTrack, false);
      if (this.currentVideoPublicationTrack === this.forwardedCompanionVideoTrack) {
        this.currentVideoPublicationTrack.stop();
      }
    }

    this.forwardedCompanionVideoTrack = nextSource.forwardedTrack;
    this.activeCompanionVideoIdentity = nextSource.identity;
    this.currentVideoPublicationTrack = nextSource.track;

    if (nextSource.track) {
      nextSource.track.contentHint = 'motion';
      await this.room.localParticipant.publishTrack(nextSource.track, {
        ...Video.cameraPublishOptions,
        name: 'video',
      });
    }
  }

  private async applyAudioSource() {
    const nextSource = this.resolveAudioTrack();
    if (this.currentAudioPublicationTrack === nextSource.track) return;

    if (this.currentAudioPublicationTrack) {
      await this.room.localParticipant.unpublishTrack(this.currentAudioPublicationTrack, false);
      if (this.currentAudioPublicationTrack === this.forwardedCompanionAudioTrack) {
        this.currentAudioPublicationTrack.stop();
      }
    }

    this.forwardedCompanionAudioTrack = nextSource.forwardedTrack;
    this.activeCompanionAudioIdentity = nextSource.identity;
    this.currentAudioPublicationTrack = nextSource.track;

    if (nextSource.track && this.currentParticipantMetadata?.deviceRole !== 'phone-camera') {
      await this.room.localParticipant.publishTrack(nextSource.track, {
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
        name: 'audio',
      });
    }
  }

  private resolveVideoTrack(): { track: MediaStreamTrack | null; forwardedTrack: MediaStreamTrack | null; identity: string | null } {
    const selectedIdentity = this.selectedVideoSource$.value;
    if (selectedIdentity !== 'desktop-local') {
      const companionTrack = this.participantStreams.get(selectedIdentity)?.getVideoTracks()[0] || null;
      if (companionTrack) {
        const clonedTrack = companionTrack.clone();
        return { track: clonedTrack, forwardedTrack: clonedTrack, identity: selectedIdentity };
      }
      this.selectedVideoSource$.next('desktop-local');
    }

    return {
      track: this.localStream?.getVideoTracks()[0] || null,
      forwardedTrack: null,
      identity: null,
    };
  }

  private resolveAudioTrack(): { track: MediaStreamTrack | null; forwardedTrack: MediaStreamTrack | null; identity: string | null } {
    const selectedIdentity = this.selectedAudioSource$.value;
    if (selectedIdentity !== 'desktop-local') {
      const companionTrack = this.participantStreams.get(selectedIdentity)?.getAudioTracks()[0] || null;
      if (companionTrack) {
        const clonedTrack = companionTrack.clone();
        return { track: clonedTrack, forwardedTrack: clonedTrack, identity: selectedIdentity };
      }
      this.selectedAudioSource$.next('desktop-local');
    }

    return {
      track: this.localStream?.getAudioTracks()[0] || null,
      forwardedTrack: null,
      identity: null,
    };
  }

  private async getLiveKitConnectionInfo(room: string, identity: string) {
    const url = `${environment.apiURL}livekit/token?room=${room}&identity=${encodeURIComponent(identity)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch LiveKit connection info');
    return await res.json();
  }
}

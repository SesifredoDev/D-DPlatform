import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  AudioPresets,
  ConnectionQuality,
  Room,
  RoomEvent,
  RemoteParticipant,
  RoomConnectOptions,
  setLogLevel,
  RemoteTrackPublication,
  RemoteTrack,
  ParticipantTrackPermission,
  TrackPublishOptions,
  VideoEncoding,
  VideoQuality,
  VideoPreset,
  VideoPresets
} from 'livekit-client';
import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ThemeColors } from '../theme/theme.service';
import { DeviceInfo, DeviceService } from '../device/device';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';
import type { CallDeviceRole, MobileCallJoinMode, CompanionSourceId, RemoteVideoQualityPreference, ParticipantVolumeMap, SceneMainCharacterState, CallParticipantMetadata, CompanionDeviceOption, MediaTrackDiagnostics, ParticipantMediaDiagnostics, CallRecordingParticipant, LiveKitConnectionInfo } from '../../models/video/video.model';
export type { CallDeviceRole, MobileCallJoinMode, CompanionSourceId, RemoteVideoQualityPreference, ParticipantVolumeMap, SceneMainCharacterState, CallParticipantMetadata, CompanionDeviceOption, MediaTrackDiagnostics, ParticipantMediaDiagnostics, CallRecordingParticipant } from '../../models/video/video.model';

export interface VideoCallInitOptions {
  mobileJoinMode?: MobileCallJoinMode;
}

@Injectable({ providedIn: 'root' })
export class Video {
  private static readonly overlayTextTopic = 'overlay-text';
  private static readonly vttSessionStateKey = 'video:vtt-session';
  private static readonly selectedVideoSourceStateKey = 'video:selected-video-source';
  private static readonly selectedAudioSourceStateKey = 'video:selected-audio-source';
  private static readonly remoteVideoQualityStateKey = 'video:remote-video-quality';
  private static readonly participantVolumesStateKey = 'video:participant-volumes';
  private static readonly sceneMainCharactersStateKey = 'video:scene-main-characters';

  private static readonly maxIceServers = 4;
  private static readonly maxSceneMainCharacters = 4;
  private static readonly dataMessageDedupeTtlMs = 5 * 60 * 1000;
  private static readonly defaultParticipantVolumePercent = 100;
  private static readonly minParticipantVolumePercent = 0;
  private static readonly maxParticipantVolumePercent = 200;
  private static readonly remoteVideoPreferenceProfiles: Record<RemoteVideoQualityPreference, {
    quality: VideoQuality;
    dimensions: { width: number; height: number };
  }> = {
    low: {
      quality: VideoQuality.LOW,
      dimensions: { width: 384, height: 216 }
    },
    medium: {
      quality: VideoQuality.MEDIUM,
      dimensions: { width: 640, height: 360 }
    },
    high: {
      quality: VideoQuality.HIGH,
      dimensions: { width: 1920, height: 1080 }
    }
  };
  private static readonly fullHdVideoEncoding: VideoEncoding = {
    ...VideoPresets.h1080.encoding,
    maxBitrate: 2_500_000,
    maxFramerate: 30,
  };
  private static readonly qhdVideoEncoding: VideoEncoding = {
    ...VideoPresets.h1440.encoding,
    maxBitrate: 4_000_000,
    maxFramerate: 30,
  };
  private static readonly highQualityMonoAudioPreset = AudioPresets.musicHighQuality;
  private static readonly highQualityStereoAudioPreset = AudioPresets.musicHighQualityStereo;
  private static readonly baseCameraPublishOptions: TrackPublishOptions = {
    dtx: true,
    red: true,
    simulcast: true,
    videoCodec: 'vp8',
    degradationPreference: 'balanced',
  };
  private static readonly fullHdSimulcastLayers = [
    VideoPresets.h216,
    new VideoPreset({
      width: 640,
      height: 360,
      maxBitrate: 900_000,
      maxFramerate: 30,
    })
  ];
  private static readonly qhdSimulcastLayers = [
    new VideoPreset({
      width: 640,
      height: 360,
      maxBitrate: 900_000,
      maxFramerate: 30,
    }),
    new VideoPreset({
      width: 1280,
      height: 720,
      maxBitrate: 2_200_000,
      maxFramerate: 30,
    })
  ];

  private room: Room;
  public remoteStreams$ = new BehaviorSubject<any[]>([]);
  public soundCloudSync$ = new Subject<any>();
  public soundCloudStateRequest$ = new Subject<{ from: string }>();
  public soundCloudRequest$ = new Subject<any>();
  public spotifySync$ = this.soundCloudSync$;
  public spotifyStateRequest$ = this.soundCloudStateRequest$;
  public spotifyRequest$ = this.soundCloudRequest$;
  public callReconnected$ = new Subject<void>();
  public callParticipantConnected$ = new Subject<string>();
  public themeSync$ = new Subject<ThemeColors>();
  public vttSession$ = new BehaviorSubject<{ active: boolean, roomId: string | null, hostId: string | null }>({ active: false, roomId: null, hostId: null });
  public overlayImage$ = new BehaviorSubject<string | null>(null);
  public overlayText$ = new BehaviorSubject<string | null>(null);
  public temporaryAtmosphereBackground$ = new BehaviorSubject<string | null>(null);
  public callKicked$ = new Subject<string>();
  public readonly deviceInfo$;
  public readonly companionDevices$ = new BehaviorSubject<CompanionDeviceOption[]>([]);
  public readonly selectedVideoSource$ = new BehaviorSubject<CompanionSourceId>('desktop-local');
  public readonly selectedAudioSource$ = new BehaviorSubject<CompanionSourceId>('desktop-local');
  public readonly remoteVideoQualityPreference$ = new BehaviorSubject<RemoteVideoQualityPreference>('medium');
  public readonly participantVolumes$ = new BehaviorSubject<ParticipantVolumeMap>({});
  public readonly sceneMainCharacters$ = new BehaviorSubject<SceneMainCharacterState>({ participantIds: [], updatedAt: 0 });

  private localStream: MediaStream | null = null;
  public currentChannelId: string | null = null;

  private participantStreams = new Map<string, MediaStream>();
  private effectiveParticipantStreams = new Map<string, MediaStream>();
  private pingInterval: any;
  private currentParticipantMetadata: CallParticipantMetadata | null = null;
  private currentParticipantIdentity: string | null = null;
  private sceneMainCharacterControllerUserIds = new Set<string>();
  private phoneCompanionTargetIdentity: string | null = null;
  private companionSyncPromise: Promise<void> | null = null;
  private currentVideoPublicationTrack: MediaStreamTrack | null = null;
  private currentAudioPublicationTrack: MediaStreamTrack | null = null;
  private applyingSharedState = false;
  private isIntentionalDisconnect = false;
  private dataMessageSequence = 0;
  private readonly receivedDataMessageIds = new Map<string, number>();
  private readonly dataEncoder = new TextEncoder();
  private readonly dataDecoder = new TextDecoder();

  constructor(
    private http: HttpClient,
    private deviceService: DeviceService,
    private sharedWindowState: SharedWindowStateService
  ) {
    setLogLevel(environment.production ? 'warn' : 'info');
    this.deviceInfo$ = this.deviceService.deviceInfo$;
    this.room = new Room({
      // Remote tracks are routed through app-owned MediaStreams so companion
      // devices, recording, and per-participant volume all use one stream.
      // LiveKit adaptiveStream requires Track.attach() on the rendered element;
      // without that, remote video can stay paused even after subscription.
      adaptiveStream: false,
      dynacast: true,
    });
    this.setupSharedWindowState();
    this.setupRoomListeners();
  }

  private setupSharedWindowState() {
    this.bindSharedBehaviorSubject(Video.vttSessionStateKey, this.vttSession$);
    this.bindSharedBehaviorSubject(Video.selectedVideoSourceStateKey, this.selectedVideoSource$, () => {
      void this.updateSelectedSourcesMetadata();
    });
    this.bindSharedBehaviorSubject(Video.selectedAudioSourceStateKey, this.selectedAudioSource$, () => {
      void this.updateSelectedSourcesMetadata();
    });
    this.bindSharedBehaviorSubject(Video.remoteVideoQualityStateKey, this.remoteVideoQualityPreference$, () => {
      this.applyRemoteVideoSubscriptionPreferences();
      void this.emitParticipants();
    });
    this.bindSharedBehaviorSubject(Video.participantVolumesStateKey, this.participantVolumes$);
    this.bindSharedBehaviorSubject(Video.sceneMainCharactersStateKey, this.sceneMainCharacters$);
  }

  private bindSharedBehaviorSubject<T>(
    key: string,
    subject: BehaviorSubject<T>,
    onRemoteValue?: (value: T) => void
  ) {
    const snapshot = this.sharedWindowState.getSnapshot<T>(key, null);
    if (snapshot !== null && !this.isSameSharedState(subject.value, snapshot)) {
      subject.next(snapshot);
    }

    this.sharedWindowState.observe<T>(key, subject.value).subscribe(value => {
      if (value === null || this.isSameSharedState(subject.value, value)) {
        return;
      }

      this.applyingSharedState = true;
      subject.next(value);
      this.applyingSharedState = false;
      onRemoteValue?.(value);
    });

    let hasSeenInitialValue = false;
    subject.subscribe(value => {
      if (!hasSeenInitialValue) {
        hasSeenInitialValue = true;
        return;
      }

      if (!this.applyingSharedState) {
        this.sharedWindowState.publish(key, value);
      }
    });
  }

  private setupRoomListeners() {
    this.room.registerTextStreamHandler(Video.overlayTextTopic, reader => {
      void reader.readAll()
        .then(text => this.overlayText$.next(text))
        .catch(error => console.error('Failed to read overlay text stream', error));
    });

    this.room
      .on(RoomEvent.Reconnecting, () => {
        this.rebuildAllParticipantStreams();
        void this.emitParticipants();
      })
      .on(RoomEvent.Reconnected, () => {
        this.rebuildAllParticipantStreams();
        this.applyRemoteVideoSubscriptionPreferences();
        void this.syncCompanionState();
        void this.emitParticipants();
        this.callReconnected$.next();
      })
      .on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        this.applyRemoteVideoSubscriptionPreferences(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        this.applyRemoteVideoSubscriptionPreferences(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid: string, participant: RemoteParticipant, reason) => {
        console.warn('LiveKit track subscription failed', {
          participantIdentity: participant.identity,
          trackSid,
          reason: String(reason ?? '')
        });
        this.updateParticipantStream(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        this.applyRemoteVideoSubscriptionPreferences(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackUnpublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        this.applyRemoteVideoSubscriptionPreferences(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackSubscriptionStatusChanged, (publication: RemoteTrackPublication, status: unknown, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackSubscriptionPermissionChanged, (publication: RemoteTrackPublication, status: unknown, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackStreamStateChanged, (publication: RemoteTrackPublication, streamState: unknown, participant: RemoteParticipant) => {
        this.updateParticipantStream(participant);
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackMuted, () => {
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.TrackUnmuted, () => {
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.applyRemoteVideoSubscriptionPreferences();
        void this.syncCompanionState();
        void this.emitParticipants();
        this.callParticipantConnected$.next(participant.identity);
        if (this.vttSession$.value.active && this.vttSession$.value.hostId === this.room.localParticipant.identity) {
          this.sendVttCommand('start', this.vttSession$.value.roomId!);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.participantStreams.delete(participant.identity);
        this.effectiveParticipantStreams.delete(participant.identity);
        void this.removeDisconnectedSceneMainCharacter(participant.identity);
        void this.syncCompanionState();
        void this.emitParticipants();
        if (this.vttSession$.value.hostId === participant.identity) {
          this.vttSession$.next({ active: false, roomId: null, hostId: null });
        }
      })
      .on(RoomEvent.ParticipantMetadataChanged, () => {
        this.applyLatestSceneMainCharactersFromMetadata();
        void this.syncCompanionState();
        void this.emitParticipants();
      })
      .on(RoomEvent.Disconnected, (reason?: unknown) => {
        this.stopPingMonitor();
        if (this.isIntentionalDisconnect) {
          return;
        }

        const reasonText = String(reason ?? '');
        this.resetCallState();
        if (reasonText.includes('DUPLICATE_IDENTITY')) {
          this.callKicked$.next('duplicate_identity');
        } else {
          this.callKicked$.next('connection_lost');
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
        this.handleDataMessage(payload, participant);
      });
  }

  private handleDataMessage(payload: Uint8Array, participant?: RemoteParticipant) {
    const data = this.parseDataMessage(payload);
    if (!data || participant?.identity === this.room.localParticipant.identity) {
      return;
    }

    if (!this.rememberDataMessage(data, participant)) {
      return;
    }

    if (data.type === 'soundcloud-sync' || data.type === 'spotify-sync') {
      this.handleSoundCloudSyncMessage(data, participant);
    } else if (data.type === 'soundcloud-state-request' || data.type === 'spotify-state-request') {
      this.soundCloudStateRequest$.next({ from: participant?.identity || '' });
    } else if (data.type === 'soundcloud-request' || data.type === 'spotify-request') {
      this.handleSoundCloudRequestMessage(data, participant);
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
    } else if (data.type === 'temporary-atmosphere-background') {
      this.temporaryAtmosphereBackground$.next(data.url);
    } else if (data.type === 'scene-main-characters') {
      void this.receiveSceneMainCharactersState(data.state, participant);
    }
  }

  private parseDataMessage(payload: Uint8Array): any | null {
    try {
      const data = JSON.parse(this.dataDecoder.decode(payload));
      return data && typeof data === 'object' ? data : null;
    } catch (error) {
      console.error('Failed to parse data message', error);
      return null;
    }
  }

  private handleSoundCloudSyncMessage(data: any, participant?: RemoteParticipant) {
    const command = typeof data.command === 'string' ? data.command : '';
    if (!command) {
      return;
    }

    const messageData = this.isRecord(data.data) ? data.data : {};
    this.soundCloudSync$.next({
      ...messageData,
      from: participant?.identity,
      command,
      source: data.source === 'auto' ? 'auto' : 'manual',
      messageId: this.getMessageId(data),
      timestamp: this.normalizeMessageTimestamp(messageData.timestamp ?? data.sentAt)
    });
  }

  private handleSoundCloudRequestMessage(data: any, participant?: RemoteParticipant) {
    const messageData = this.isRecord(data.data) ? data.data : {};
    const uri = this.getStringValue(messageData.uri);
    if (!uri) {
      return;
    }

    this.soundCloudRequest$.next({
      uri,
      name: this.getStringValue(messageData.name) || 'Requested Song',
      artist: this.getStringValue(messageData.artist) || 'Unknown Artist',
      image: this.getStringValue(messageData.image),
      duration: this.getFiniteNumber(messageData.duration),
      type: this.getStringValue(messageData.type) || 'track',
      requestId: this.getMessageId(data),
      requestedAt: this.normalizeMessageTimestamp(data.sentAt),
      from: participant?.identity || 'Unknown',
      fromName: this.getStringValue(data.fromName) || 'Unknown Player'
    });
  }

  private rememberDataMessage(data: any, participant?: RemoteParticipant): boolean {
    const messageId = this.getMessageId(data);
    if (!messageId) {
      return true;
    }

    const now = Date.now();
    this.pruneReceivedDataMessages(now);
    const key = `${participant?.identity || 'unknown'}:${messageId}`;
    if (this.receivedDataMessageIds.has(key)) {
      return false;
    }

    this.receivedDataMessageIds.set(key, now);
    return true;
  }

  private pruneReceivedDataMessages(now: number) {
    if (this.receivedDataMessageIds.size < 250) {
      return;
    }

    this.receivedDataMessageIds.forEach((receivedAt, key) => {
      if (now - receivedAt > Video.dataMessageDedupeTtlMs) {
        this.receivedDataMessageIds.delete(key);
      }
    });
  }

  private getMessageId(data: any): string {
    return this.getStringValue(data?.messageId) || this.getStringValue(data?.data?.messageId);
  }

  private normalizeMessageTimestamp(value: unknown): number | undefined {
    const timestamp = this.getFiniteNumber(value);
    return timestamp && timestamp > 0 ? timestamp : undefined;
  }

  private getStringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private getFiniteNumber(value: unknown): number | undefined {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private startPingMonitor() {
    this.stopPingMonitor();
    this.pingInterval = setInterval(() => void this.emitParticipants(), 3000);
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

    const nextTracks = participant.getTrackPublications()
      .map(pub => pub.track?.mediaStreamTrack)
      .filter((track): track is MediaStreamTrack => !!track);
    const currentTracks = stream.getTracks();
    if (this.hasSameTracks(currentTracks, nextTracks)) {
      return;
    }

    currentTracks.forEach(track => stream!.removeTrack(track));
    nextTracks.forEach(track => stream!.addTrack(track));
  }

  private hasSameTracks(currentTracks: MediaStreamTrack[], nextTracks: MediaStreamTrack[]): boolean {
    return currentTracks.length === nextTracks.length &&
      currentTracks.every(track => nextTracks.includes(track));
  }

  private rebuildAllParticipantStreams() {
    this.room.remoteParticipants.forEach(participant => {
      this.updateParticipantStream(participant);
    });
  }

  async initVideoCall(channelId: string, userId: string, character: any, options: VideoCallInitOptions = {}) {
    if (this.room.state === 'connected' && this.currentChannelId === channelId) return;

    try {
      if (this.room.state !== 'disconnected') {
        await this.disconnectRoomForReset();
      }

      const deviceInfo = this.deviceService.getDeviceInfo();
      const deviceRole = this.resolveDeviceRole(deviceInfo, options.mobileJoinMode);
      const identity = this.buildParticipantIdentity(userId, deviceInfo.deviceId);
      const metadata = this.buildParticipantMetadata(userId, deviceInfo, deviceRole, character);
      const data = await this.getLiveKitConnectionInfo(channelId, identity);
      const connectOptions: RoomConnectOptions = {
        autoSubscribe: deviceRole !== 'phone-camera',
        rtcConfig: { iceServers: this.selectIceServers(data.iceServers) }
      };

      await this.room.connect(environment.livekitUrl, data.token, connectOptions);
      this.currentChannelId = channelId;
      this.currentParticipantIdentity = identity;
      this.applyLatestSceneMainCharactersFromMetadata();
      this.currentParticipantMetadata = {
        ...metadata,
        sceneMainCharacters: this.sceneMainCharacters$.value
      };
      await this.room.localParticipant.setMetadata(JSON.stringify(this.currentParticipantMetadata));
      this.applyRemoteVideoSubscriptionPreferences();

      if (deviceRole === 'phone-camera') {
        const desktopIdentity = this.findDesktopMainIdentityForUser(userId);
        if (!desktopIdentity) {
          await this.disconnectRoomWithoutReset();
          this.resetCallState();
          this.callKicked$.next('phone_requires_desktop');
          throw new Error('Phone companion requires an active desktop session');
        }
        this.phoneCompanionTargetIdentity = desktopIdentity;
      } else {
        this.phoneCompanionTargetIdentity = null;
      }

      await this.syncCompanionState();
      await this.emitParticipants();
    } catch (error) {
      if (this.room.state !== 'disconnected') {
        await this.disconnectRoomForReset();
      }
      throw error;
    }
  }

  async updateUserData(channelId: string, character: any) {
    if (this.room.state === 'connected' && this.currentParticipantMetadata) {
      const deviceInfo = this.deviceService.getDeviceInfo();
      this.currentParticipantMetadata = this.buildParticipantMetadata(
        this.currentParticipantMetadata.userId,
        deviceInfo,
        this.currentParticipantMetadata.deviceRole,
        character
      );
      await this.publishLocalMetadata();
      await this.emitParticipants();
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

  async startPlayback() {
    if (this.room.state !== 'connected') {
      return;
    }

    await Promise.allSettled([
      this.room.startAudio(),
      this.room.startVideo()
    ]);
  }

  async setCameraEnabled(enabled: boolean) {
    const currentTrack = this.currentVideoPublicationTrack;
    if (currentTrack) {
      currentTrack.enabled = enabled;
      return;
    }

    if (this.room.state === 'connected') {
      await this.room.localParticipant.setCameraEnabled(enabled);
    }
  }

  async setMicrophoneEnabled(enabled: boolean) {
    const currentTrack = this.currentAudioPublicationTrack;
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
    await this.updateSelectedSourcesMetadata();
    await this.syncCompanionState();
  }

  async selectAudioSource(sourceId: CompanionSourceId) {
    this.selectedAudioSource$.next(sourceId);
    await this.updateSelectedSourcesMetadata();
    await this.syncCompanionState();
  }

  getSelectedVideoSource(): CompanionSourceId {
    return this.selectedVideoSource$.value;
  }

  getSelectedAudioSource(): CompanionSourceId {
    return this.selectedAudioSource$.value;
  }

  getRemoteVideoQualityPreference(): RemoteVideoQualityPreference {
    return this.remoteVideoQualityPreference$.value;
  }

  getParticipantVolume(participantIdentity: string): number {
    return this.participantVolumes$.value[participantIdentity] ?? Video.defaultParticipantVolumePercent;
  }

  setParticipantVolume(participantIdentity: string, volumePercent: number) {
    const nextVolume = this.normalizeParticipantVolume(volumePercent);
    const currentVolume = this.getParticipantVolume(participantIdentity);
    if (currentVolume === nextVolume) {
      return;
    }

    this.participantVolumes$.next({
      ...this.participantVolumes$.value,
      [participantIdentity]: nextVolume
    });
  }

  setRemoteVideoQualityPreference(preference: RemoteVideoQualityPreference) {
    if (this.remoteVideoQualityPreference$.value === preference) {
      return;
    }

    this.remoteVideoQualityPreference$.next(preference);
    this.applyRemoteVideoSubscriptionPreferences();
    void this.emitParticipants();
  }

  getSceneMainCharacterIds(): string[] {
    return [...this.sceneMainCharacters$.value.participantIds];
  }

  getMaxSceneMainCharacters(): number {
    return Video.maxSceneMainCharacters;
  }

  setSceneMainCharacterControllerUserId(userId: string | null) {
    this.setSceneMainCharacterControllerUserIds(userId ? [userId] : []);
  }

  setSceneMainCharacterControllerUserIds(userIds: string[]) {
    const nextControllerUserIds = new Set(
      userIds
        .map(userId => userId.trim())
        .filter(userId => !!userId)
    );

    if (this.areSameControllerUserIds(nextControllerUserIds)) {
      return;
    }

    this.sceneMainCharacterControllerUserIds = nextControllerUserIds;
    this.applyLatestSceneMainCharactersFromMetadata();
  }

  async setSceneMainCharacter(participantIdentity: string, enabled: boolean): Promise<boolean> {
    if (!this.canCurrentParticipantManageSceneMainCharacters()) {
      return false;
    }

    const normalizedIdentity = participantIdentity.trim();
    if (!normalizedIdentity) {
      return false;
    }

    const currentIds = this.sceneMainCharacters$.value.participantIds;
    const alreadySelected = currentIds.includes(normalizedIdentity);
    if (enabled) {
      if (alreadySelected) {
        return true;
      }

      if (currentIds.length >= Video.maxSceneMainCharacters) {
        return false;
      }

      await this.publishSceneMainCharactersState([...currentIds, normalizedIdentity]);
      return true;
    }

    if (!alreadySelected) {
      return true;
    }

    await this.publishSceneMainCharactersState(currentIds.filter(id => id !== normalizedIdentity));
    return true;
  }

  async clearSceneMainCharacters(): Promise<boolean> {
    if (!this.canCurrentParticipantManageSceneMainCharacters()) {
      return false;
    }

    if (!this.sceneMainCharacters$.value.participantIds.length) {
      return true;
    }

    await this.publishSceneMainCharactersState([]);
    return true;
  }

  getSelectedCompanionVideoStream(): MediaStream | null {
    if (this.selectedVideoSource$.value === 'desktop-local') return null;
    return this.participantStreams.get(this.selectedVideoSource$.value) || null;
  }

  getSelectedCompanionAudioStream(): MediaStream | null {
    if (this.selectedAudioSource$.value === 'desktop-local') return null;
    return this.participantStreams.get(this.selectedAudioSource$.value) || null;
  }

  private async publishReliableData(message: Record<string, unknown>): Promise<boolean> {
    if (this.room.state !== 'connected') {
      return false;
    }

    try {
      const payload = this.dataEncoder.encode(JSON.stringify(message));
      await this.room.localParticipant.publishData(payload, { reliable: true });
      return true;
    } catch (error) {
      console.warn('Failed to publish LiveKit data message', message['type'], error);
      return false;
    }
  }

  private createDataMessageId(type: string): string {
    this.dataMessageSequence += 1;
    const identity = this.room.localParticipant.identity || this.currentParticipantIdentity || 'local';
    return `${identity}:${type}:${Date.now()}:${this.dataMessageSequence}`;
  }

  async sendSoundCloudCommand(command: string, data: any, source: string = 'manual'): Promise<boolean> {
    if (this.room.state !== 'connected' || !command) return false;

    const sentAt = Date.now();
    const messageId = this.createDataMessageId('soundcloud-sync');
    const messageData = this.isRecord(data) ? data : {};
    const hostId = messageData['hostId'] ?? this.currentParticipantMetadata?.userId;
    return this.publishReliableData({
      type: 'soundcloud-sync',
      version: 1,
      messageId,
      command,
      source,
      sentAt,
      data: { ...messageData, hostId, timestamp: sentAt, messageId }
    });
  }

  sendSpotifyCommand(command: string, data: any, source: string = 'manual'): Promise<boolean> {
    return this.sendSoundCloudCommand(command, data, source);
  }

  async sendSoundCloudRequest(item: any, fromName: string): Promise<boolean> {
    if (this.room.state !== 'connected') return false;

    const track = item?.track || item?.item || item;
    const uri = this.getStringValue(track?.uri) || this.getStringValue(track?.permalink_url);
    if (!uri) return false;

    const sentAt = Date.now();
    const messageId = this.createDataMessageId('soundcloud-request');
    return this.publishReliableData({
      type: 'soundcloud-request',
      version: 1,
      messageId,
      sentAt,
      fromName: fromName || 'Unknown Player',
      data: {
        uri,
        name: track.name || track.title || 'Requested Song',
        artist: track.artist || track.owner || track.user?.username || 'Unknown Artist',
        image: track.image || track.artwork_url || track.images?.[0]?.url || track.album?.images?.[0]?.url || track.user?.avatar_url || '',
        duration: track.duration,
        type: track.type || 'track',
        messageId
      }
    });
  }

  sendSpotifyRequest(item: any, fromName: string): Promise<boolean> {
    return this.sendSoundCloudRequest(item, fromName);
  }

  sendThemeUpdate(theme: ThemeColors) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'theme-sync', theme }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  requestSoundCloudState(): Promise<boolean> {
    return this.publishReliableData({
      type: 'soundcloud-state-request',
      version: 1,
      messageId: this.createDataMessageId('soundcloud-state-request'),
      sentAt: Date.now()
    });
  }

  requestSpotifyState(): Promise<boolean> {
    return this.requestSoundCloudState();
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

  async broadcastOverlayText(text: string | null): Promise<boolean> {
    if (this.room.state !== 'connected') return false;

    if (text) {
      await this.room.localParticipant.sendText(text, { topic: Video.overlayTextTopic });
      this.overlayText$.next(text);
      return true;
    }

    const payload = new TextEncoder().encode(JSON.stringify({ type: 'overlay-text', text }));
    await this.room.localParticipant.publishData(payload, { reliable: true });
    this.overlayText$.next(text);
    return true;
  }

  broadcastTemporaryAtmosphereBackground(url: string | null) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'temporary-atmosphere-background', url }));
    this.room.localParticipant.publishData(payload, { reliable: true });
    this.temporaryAtmosphereBackground$.next(url);
  }

  private async receiveSceneMainCharactersState(state: unknown, participant?: RemoteParticipant) {
    if (!this.canParticipantManageSceneMainCharacters(participant)) {
      return;
    }

    if (!this.applySceneMainCharactersState(state)) {
      return;
    }

    await this.persistSceneMainCharactersMetadata();
    await this.emitParticipants();
  }

  private async publishSceneMainCharactersState(participantIds: string[]) {
    const state: SceneMainCharacterState = {
      participantIds: this.normalizeSceneMainCharacterIds(participantIds),
      updatedAt: this.nextSceneMainCharactersTimestamp(),
      updatedBy: this.currentParticipantIdentity || undefined
    };

    this.applySceneMainCharactersState(state, true);
    await this.persistSceneMainCharactersMetadata();
    this.broadcastSceneMainCharactersState(state);
    await this.emitParticipants();
  }

  private broadcastSceneMainCharactersState(state: SceneMainCharacterState) {
    if (this.room.state !== 'connected') return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'scene-main-characters', state }));
    this.room.localParticipant.publishData(payload, { reliable: true });
  }

  private async persistSceneMainCharactersMetadata() {
    if (this.room.state !== 'connected' || !this.currentParticipantMetadata) {
      return;
    }

    const nextState = this.sceneMainCharacters$.value;
    if (this.isSameSceneMainCharactersState(this.currentParticipantMetadata.sceneMainCharacters, nextState)) {
      return;
    }

    this.currentParticipantMetadata = {
      ...this.currentParticipantMetadata,
      sceneMainCharacters: nextState
    };

    await this.publishLocalMetadata();
  }

  private async removeDisconnectedSceneMainCharacter(participantIdentity: string) {
    if (!this.sceneMainCharacters$.value.participantIds.includes(participantIdentity)) {
      return;
    }

    await this.setSceneMainCharacter(participantIdentity, false);
  }

  private applyLatestSceneMainCharactersFromMetadata() {
    const states: SceneMainCharacterState[] = [];
    const localState = this.normalizeSceneMainCharactersState(this.currentParticipantMetadata?.sceneMainCharacters);
    if (localState && this.canMetadataManageSceneMainCharacters(this.currentParticipantMetadata)) {
      states.push(localState);
    }

    this.room.remoteParticipants.forEach(participant => {
      const metadata = this.parseMetadata(participant.metadata);
      const state = this.normalizeSceneMainCharactersState(metadata?.sceneMainCharacters);
      if (state && this.canMetadataManageSceneMainCharacters(metadata)) {
        states.push(state);
      }
    });

    const latestState = states.reduce<SceneMainCharacterState | null>((latest, state) => {
      if (!latest || state.updatedAt > latest.updatedAt) {
        return state;
      }

      return latest;
    }, null);

    if (latestState) {
      this.applySceneMainCharactersState(latestState);
    } else if (this.sceneMainCharacters$.value.participantIds.length) {
      this.sceneMainCharacters$.next({ participantIds: [], updatedAt: this.nextSceneMainCharactersTimestamp() });
    }
  }

  private applySceneMainCharactersState(state: unknown, force = false): boolean {
    const nextState = this.normalizeSceneMainCharactersState(state);
    if (!nextState) {
      return false;
    }

    const currentState = this.sceneMainCharacters$.value;
    if (
      !force &&
      (nextState.updatedAt < currentState.updatedAt ||
        this.isSameSceneMainCharactersState(currentState, nextState))
    ) {
      return false;
    }

    this.sceneMainCharacters$.next(nextState);
    return true;
  }

  private normalizeSceneMainCharactersState(state: unknown): SceneMainCharacterState | null {
    if (!state || typeof state !== 'object') {
      return null;
    }

    const candidate = state as Partial<SceneMainCharacterState>;
    const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? Math.max(0, Math.round(candidate.updatedAt))
      : 0;

    return {
      participantIds: this.normalizeSceneMainCharacterIds(candidate.participantIds),
      updatedAt,
      updatedBy: typeof candidate.updatedBy === 'string' ? candidate.updatedBy : undefined
    };
  }

  private normalizeSceneMainCharacterIds(participantIds: unknown): string[] {
    if (!Array.isArray(participantIds)) {
      return [];
    }

    const normalizedIds: string[] = [];
    participantIds.forEach(candidate => {
      const participantId = typeof candidate === 'string' ? candidate.trim() : '';
      if (participantId && !normalizedIds.includes(participantId)) {
        normalizedIds.push(participantId);
      }
    });

    return normalizedIds.slice(0, Video.maxSceneMainCharacters);
  }

  private nextSceneMainCharactersTimestamp(): number {
    return Math.max(Date.now(), this.sceneMainCharacters$.value.updatedAt + 1);
  }

  private isSameSceneMainCharactersState(
    currentState: SceneMainCharacterState | undefined,
    nextState: SceneMainCharacterState
  ): boolean {
    return !!currentState &&
      currentState.updatedAt === nextState.updatedAt &&
      this.areSameSceneMainCharacterIds(currentState.participantIds, nextState.participantIds);
  }

  private areSameSceneMainCharacterIds(firstIds: string[], secondIds: string[]): boolean {
    return firstIds.length === secondIds.length && firstIds.every((id, index) => id === secondIds[index]);
  }

  private canCurrentParticipantManageSceneMainCharacters(): boolean {
    return this.canMetadataManageSceneMainCharacters(this.currentParticipantMetadata);
  }

  private canParticipantManageSceneMainCharacters(participant?: RemoteParticipant): boolean {
    return this.canMetadataManageSceneMainCharacters(this.parseMetadata(participant?.metadata));
  }

  private canMetadataManageSceneMainCharacters(metadata: CallParticipantMetadata | null | undefined): boolean {
    return !!metadata?.userId &&
      this.sceneMainCharacterControllerUserIds.has(metadata.userId) &&
      metadata.deviceRole === 'desktop-main';
  }

  private areSameControllerUserIds(nextControllerUserIds: Set<string>): boolean {
    if (this.sceneMainCharacterControllerUserIds.size !== nextControllerUserIds.size) {
      return false;
    }

    return Array.from(this.sceneMainCharacterControllerUserIds).every(userId => nextControllerUserIds.has(userId));
  }

  private async emitParticipants() {
    const timestamp = new Date().toLocaleTimeString();
    const participants = await Promise.all(Array.from(this.room.remoteParticipants.values()).map(async p => {
      this.updateParticipantStream(p);

      const participantMeta = this.parseMetadata(p.metadata);
      const stream = this.buildEffectiveParticipantStream(p.identity, participantMeta);
      const rtt = (p as any).getRTT ? (p as any).getRTT() : (p as any).lastPingRTT;
      if (rtt !== undefined) {
        console.log(`[${timestamp}] Ping for ${p.identity}: ${rtt}ms`);
      }

      return {
        id: p.identity,
        userData: participantMeta?.character || {},
        participantMeta,
        stream,
        remoteAudioTrack: this.getRemoteAudioTrackForStream(stream),
        remoteVideoTrack: this.getRemoteVideoTrackForStream(stream),
        ping: rtt,
        diagnostics: await this.collectParticipantDiagnostics(p, rtt)
      };
    }));

    this.companionDevices$.next(this.buildCompanionDeviceOptions(participants));

    const localRTT = (this.room.localParticipant as any).getRTT ? (this.room.localParticipant as any).getRTT() : (this.room.localParticipant as any).lastPingRTT;
    if (localRTT !== undefined) {
      console.log(`[${timestamp}] Local Ping: ${localRTT}ms`);
    }

    this.remoteStreams$.next([{
      id: 'local',
      ping: localRTT,
      isLocal: true,
      participantMeta: this.currentParticipantMetadata,
      diagnostics: await this.collectParticipantDiagnostics(this.room.localParticipant, localRTT)
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
    await this.disconnectRoomWithoutReset();
    this.resetCallState();
  }

  getLocalStream() { return this.localStream; }

  isCallConnected(): boolean {
    return this.room.state === 'connected';
  }

  getCallRecordingParticipants(localStream: MediaStream | null = this.localStream): CallRecordingParticipant[] {
    const participants = this.remoteStreams$.value;
    const remoteParticipants = participants
      .filter(participant => !participant.isLocal)
      .map(participant => ({
        id: participant.id,
        stream: participant.stream,
        userData: participant.userData,
        participantMeta: participant.participantMeta,
        isLocal: false,
        volumePercent: this.getParticipantVolume(participant.id)
      }));

    return [{
      id: this.currentParticipantIdentity ?? 'local',
      stream: localStream ?? undefined,
      userData: this.currentParticipantMetadata?.character,
      participantMeta: this.currentParticipantMetadata,
      isLocal: true,
      volumePercent: 100
    }, ...remoteParticipants];
  }

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
    this.participantVolumes$.next({});
    this.sceneMainCharacters$.next({ participantIds: [], updatedAt: 0 });
    this.participantStreams.clear();
    this.effectiveParticipantStreams.clear();
    this.vttSession$.next({ active: false, roomId: null, hostId: null });
    this.localStream = null;
    this.currentChannelId = null;
    this.currentParticipantMetadata = null;
    this.currentParticipantIdentity = null;
    this.phoneCompanionTargetIdentity = null;
    this.currentVideoPublicationTrack = null;
    this.currentAudioPublicationTrack = null;
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
      character,
      selectedVideoSource: deviceRole === 'desktop-main' ? this.selectedVideoSource$.value : 'desktop-local',
      selectedAudioSource: deviceRole === 'desktop-main' ? this.selectedAudioSource$.value : 'desktop-local',
      sceneMainCharacters: this.sceneMainCharacters$.value
    };
  }

  private resolveDeviceRole(deviceInfo: DeviceInfo, mobileJoinMode: MobileCallJoinMode = 'companion'): CallDeviceRole {
    if (deviceInfo.deviceType !== 'mobile') {
      return 'desktop-main';
    }

    return mobileJoinMode === 'companion' ? 'phone-camera' : 'phone-caller';
  }

  private getDesktopMainParticipantForUser(userId: string): RemoteParticipant | null {
    return Array.from(this.room.remoteParticipants.values()).find(p => {
      const metadata = this.parseMetadata(p.metadata);
      return metadata?.userId === userId && metadata?.deviceRole === 'desktop-main';
    }) || null;
  }

  private findDesktopMainIdentityForUser(userId: string): string | null {
    const desktopParticipant = this.getDesktopMainParticipantForUser(userId);
    return desktopParticipant?.identity || null;
  }

  private shouldPhoneCompanionBeSharedToRoom(): boolean {
    if (
      !this.currentParticipantIdentity ||
      !this.currentParticipantMetadata ||
      this.currentParticipantMetadata.deviceRole !== 'phone-camera'
    ) {
      return false;
    }

    const desktopParticipant = this.getDesktopMainParticipantForUser(this.currentParticipantMetadata.userId);
    const desktopMetadata = this.parseMetadata(desktopParticipant?.metadata);
    return desktopMetadata?.selectedVideoSource === this.currentParticipantIdentity
      || desktopMetadata?.selectedAudioSource === this.currentParticipantIdentity;
  }

  private updatePhoneTrackPermissions() {
    if (!this.phoneCompanionTargetIdentity) return;

    if (this.shouldPhoneCompanionBeSharedToRoom()) {
      this.room.localParticipant.setTrackSubscriptionPermissions(true);
      return;
    }

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
          await this.disconnectRoomWithoutReset();
        }
        this.resetCallState();
        this.callKicked$.next('desktop_missing');
        return;
      }

      this.phoneCompanionTargetIdentity = desktopIdentity;
      this.updatePhoneTrackPermissions();
      return;
    }

    await this.normalizeSelectedSources();
    await this.applyPublishedTracks();
  }

  private async applyPublishedTracks() {
    if (this.room.state !== 'connected') return;

    await this.applyVideoSource();
    await this.applyAudioSource();
  }

  private async disconnectRoomForReset() {
    this.stopPingMonitor();
    await this.disconnectRoomWithoutReset();
    this.resetCallState();
  }

  private async disconnectRoomWithoutReset() {
    this.isIntentionalDisconnect = true;
    try {
      await this.room.disconnect();
    } finally {
      this.isIntentionalDisconnect = false;
    }
  }

  private applyRemoteVideoSubscriptionPreferences(participant?: RemoteParticipant) {
    if (this.currentParticipantMetadata?.deviceRole === 'phone-camera') {
      return;
    }

    const targets = participant
      ? [participant]
      : Array.from(this.room.remoteParticipants.values());
    const profile = Video.remoteVideoPreferenceProfiles[this.remoteVideoQualityPreference$.value];

    targets.forEach(remoteParticipant => {
      remoteParticipant.audioTrackPublications.forEach(publication => {
        publication.setSubscribed(true);
        publication.setEnabled(true);
      });
      remoteParticipant.videoTrackPublications.forEach(publication => {
        publication.setSubscribed(true);
        publication.setEnabled(true);
        publication.setVideoQuality(profile.quality);
        publication.setVideoDimensions(profile.dimensions);
      });
    });
  }

  private async applyVideoSource() {
    const nextSource = this.localStream?.getVideoTracks()[0] || null;
    if (this.currentVideoPublicationTrack === nextSource) return;

    if (this.currentVideoPublicationTrack) {
      await this.room.localParticipant.unpublishTrack(this.currentVideoPublicationTrack, false);
    }

    this.currentVideoPublicationTrack = nextSource;

    if (nextSource) {
      nextSource.contentHint = 'detail';
      await this.room.localParticipant.publishTrack(nextSource, {
        ...this.getCameraPublishOptions(nextSource),
        name: 'video',
      });
    }
  }

  private getCameraPublishOptions(track: MediaStreamTrack): TrackPublishOptions {
    const settings = track.getSettings();
    const width = settings.width ?? 0;
    const height = settings.height ?? 0;
    const useQhdProfile = width >= 2200 || height >= 1200;
    const videoEncoding = useQhdProfile ? Video.qhdVideoEncoding : Video.fullHdVideoEncoding;
    const simulcastLayers = useQhdProfile
      ? Video.qhdSimulcastLayers
      : Video.fullHdSimulcastLayers;

    return {
      ...Video.baseCameraPublishOptions,
      videoEncoding,
      videoSimulcastLayers: simulcastLayers,
    };
  }

  private async applyAudioSource() {
    const nextSource = this.localStream?.getAudioTracks()[0] || null;
    if (this.currentAudioPublicationTrack === nextSource) return;

    if (this.currentAudioPublicationTrack) {
      await this.room.localParticipant.unpublishTrack(this.currentAudioPublicationTrack, false);
    }

    this.currentAudioPublicationTrack = nextSource;

    if (nextSource && this.currentParticipantMetadata?.deviceRole !== 'phone-camera') {
      await this.room.localParticipant.publishTrack(nextSource, this.getAudioPublishOptions(nextSource));
    }
  }

  private getAudioPublishOptions(track: MediaStreamTrack): TrackPublishOptions {
    const settings = track.getSettings();
    const channelCount = settings.channelCount ?? 1;

    return {
      audioPreset: channelCount > 1
        ? Video.highQualityStereoAudioPreset
        : Video.highQualityMonoAudioPreset,
      dtx: true,
      red: true,
      name: 'audio',
    };
  }

  private buildEffectiveParticipantStream(
    participantIdentity: string,
    metadata: CallParticipantMetadata | null
  ): MediaStream | undefined {
    const sourceStream = this.participantStreams.get(participantIdentity);
    if (!sourceStream) {
      this.effectiveParticipantStreams.delete(participantIdentity);
      return undefined;
    }

    if (metadata?.deviceRole !== 'desktop-main') {
      this.effectiveParticipantStreams.delete(participantIdentity);
      return sourceStream;
    }

    const effectiveStream = this.effectiveParticipantStreams.get(participantIdentity) || new MediaStream();
    const selectedVideoTrack = this.resolveEffectiveTrack(metadata.selectedVideoSource, 'video', sourceStream);
    const selectedAudioTrack = this.resolveEffectiveTrack(metadata.selectedAudioSource, 'audio', sourceStream);

    this.syncEffectiveStreamTrack(effectiveStream, 'video', selectedVideoTrack);
    this.syncEffectiveStreamTrack(effectiveStream, 'audio', selectedAudioTrack);

    this.effectiveParticipantStreams.set(participantIdentity, effectiveStream);
    return effectiveStream;
  }

  private syncEffectiveStreamTrack(
    effectiveStream: MediaStream,
    kind: 'audio' | 'video',
    nextTrack: MediaStreamTrack | null
  ) {
    const currentTrack = kind === 'video'
      ? effectiveStream.getVideoTracks()[0] || null
      : effectiveStream.getAudioTracks()[0] || null;

    if (currentTrack === nextTrack) {
      return;
    }

    if (currentTrack) {
      effectiveStream.removeTrack(currentTrack);
    }

    if (nextTrack) {
      effectiveStream.addTrack(nextTrack);
    }
  }

  private resolveEffectiveTrack(
    sourceId: CompanionSourceId | undefined,
    kind: 'audio' | 'video',
    fallbackStream: MediaStream
  ): MediaStreamTrack | null {
    const getter = kind === 'video' ? 'getVideoTracks' : 'getAudioTracks';
    if (sourceId && sourceId !== 'desktop-local') {
      const selectedTrack = this.participantStreams.get(sourceId)?.[getter]()[0] || null;
      if (selectedTrack) {
        return selectedTrack;
      }
    }

    return fallbackStream[getter]()[0] || null;
  }

  private getRemoteAudioTrackForStream(stream: MediaStream | undefined): RemoteAudioTrack | undefined {
    const track = this.findRemoteTrackForMediaStreamTrack(stream?.getAudioTracks()[0] || null);
    return track?.kind === 'audio' ? track as RemoteAudioTrack : undefined;
  }

  private getRemoteVideoTrackForStream(stream: MediaStream | undefined): RemoteVideoTrack | undefined {
    const track = this.findRemoteTrackForMediaStreamTrack(stream?.getVideoTracks()[0] || null);
    return track?.kind === 'video' ? track as RemoteVideoTrack : undefined;
  }

  private findRemoteTrackForMediaStreamTrack(mediaStreamTrack: MediaStreamTrack | null): RemoteTrack | undefined {
    if (!mediaStreamTrack) {
      return undefined;
    }

    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.getTrackPublications()) {
        if (publication.track?.mediaStreamTrack === mediaStreamTrack) {
          return publication.track as RemoteTrack;
        }
      }
    }

    return undefined;
  }

  private async updateSelectedSourcesMetadata() {
    if (!this.currentParticipantMetadata || this.currentParticipantMetadata.deviceRole !== 'desktop-main') {
      return;
    }

    this.currentParticipantMetadata = {
      ...this.currentParticipantMetadata,
      selectedVideoSource: this.selectedVideoSource$.value,
      selectedAudioSource: this.selectedAudioSource$.value,
    };

    await this.publishLocalMetadata();
    await this.emitParticipants();
  }

  private async normalizeSelectedSources() {
    if (!this.currentParticipantMetadata || this.currentParticipantMetadata.deviceRole !== 'desktop-main') {
      return;
    }

    let changed = false;
    if (!this.hasAvailableCompanionTrack(this.selectedVideoSource$.value, 'video')) {
      this.selectedVideoSource$.next('desktop-local');
      changed = true;
    }
    if (!this.hasAvailableCompanionTrack(this.selectedAudioSource$.value, 'audio')) {
      this.selectedAudioSource$.next('desktop-local');
      changed = true;
    }

    if (changed) {
      await this.updateSelectedSourcesMetadata();
    }
  }

  private hasAvailableCompanionTrack(sourceId: CompanionSourceId, kind: 'audio' | 'video'): boolean {
    if (sourceId === 'desktop-local') {
      return true;
    }

    const getter = kind === 'video' ? 'getVideoTracks' : 'getAudioTracks';
    return !!this.participantStreams.get(sourceId)?.[getter]().length;
  }

  private async publishLocalMetadata() {
    if (this.room.state !== 'connected' || !this.currentParticipantMetadata) {
      return;
    }

    await this.room.localParticipant.setMetadata(JSON.stringify(this.currentParticipantMetadata));
  }

  private normalizeParticipantVolume(volumePercent: number): number {
    if (!Number.isFinite(volumePercent)) {
      return Video.defaultParticipantVolumePercent;
    }

    return Math.min(
      Video.maxParticipantVolumePercent,
      Math.max(Video.minParticipantVolumePercent, Math.round(volumePercent))
    );
  }

  private selectIceServers(iceServers?: RTCIceServer[]): RTCIceServer[] | undefined {
    if (!iceServers?.length) {
      return undefined;
    }

    const normalizedServers = iceServers
      .map(server => this.normalizeIceServer(server))
      .filter((server): server is RTCIceServer => !!server);

    if (!normalizedServers.length) {
      return undefined;
    }

    const turnServers = normalizedServers.filter(server => this.isTurnServer(server));
    const stunServers = normalizedServers.filter(server => !this.isTurnServer(server));

    return [...turnServers, ...stunServers].slice(0, Video.maxIceServers);
  }

  private normalizeIceServer(server: RTCIceServer): RTCIceServer | null {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const uniqueUrls = Array.from(new Set(urls.filter((url): url is string => !!url?.trim())));
    if (!uniqueUrls.length) {
      return null;
    }

    return {
      ...server,
      urls: uniqueUrls.length === 1 ? uniqueUrls[0] : uniqueUrls
    };
  }

  private isTurnServer(server: RTCIceServer): boolean {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => /^turns?:/i.test(url));
  }

  private async getLiveKitConnectionInfo(channelId: string, identity: string): Promise<LiveKitConnectionInfo> {
    try {
      return await firstValueFrom(this.http.post<LiveKitConnectionInfo>(
        `${environment.apiURL}livekit/token`,
        { channelId, identity },
        { withCredentials: true }
      ));
    } catch (error: any) {
      const errorPayload = error?.error;
      const message = errorPayload?.error
        || errorPayload?.message
        || (error?.status === 401 ? 'Authentication required to join this call' : '')
        || error?.message
        || 'Failed to fetch LiveKit connection info';
      throw new Error(message);
    }
  }

  private async collectParticipantDiagnostics(participant: any, rtt: unknown): Promise<ParticipantMediaDiagnostics> {
    const publications = participant.getTrackPublications?.() ?? [];
    const audioPublication = publications.find((publication: any) => publication.kind === 'audio');
    const videoPublication = publications.find((publication: any) => publication.kind === 'video');

    return {
      connectionQuality: participant.connectionQuality ?? ConnectionQuality.Unknown,
      connectionState: this.room.state,
      rttMs: typeof rtt === 'number' ? Math.round(rtt) : null,
      audio: await this.buildTrackDiagnostics(audioPublication),
      video: await this.buildTrackDiagnostics(videoPublication),
    };
  }

  private async buildTrackDiagnostics(publication: any): Promise<MediaTrackDiagnostics | undefined> {
    const track = publication?.track;
    const mediaStreamTrack = track?.mediaStreamTrack as MediaStreamTrack | undefined;
    if (!track || !mediaStreamTrack) {
      return undefined;
    }

    const settings = mediaStreamTrack.getSettings?.() ?? {};
    const statsReport = typeof track.getRTCStatsReport === 'function'
      ? await track.getRTCStatsReport() as RTCStatsReport | undefined
      : undefined;

    const kind = mediaStreamTrack.kind as 'audio' | 'video';
    const baseDiagnostics: MediaTrackDiagnostics = {
      kind,
      bitrateKbps: this.normalizeBitrateKbps(track.currentBitrate),
      packetLossPct: null,
      jitterMs: null,
      width: kind === 'video' ? settings.width ?? null : undefined,
      height: kind === 'video' ? settings.height ?? null : undefined,
      frameRate: kind === 'video' ? this.normalizeFrameRate(settings.frameRate) : undefined,
      enabled: mediaStreamTrack.enabled,
      muted: !!track.isMuted,
    };

    const stats = this.extractTrackStats(statsReport, kind, !!track.isLocal);
    if (stats) {
      baseDiagnostics.packetLossPct = stats.packetLossPct;
      baseDiagnostics.jitterMs = stats.jitterMs;
    }

    return baseDiagnostics;
  }

  private extractTrackStats(
    report: RTCStatsReport | undefined,
    kind: 'audio' | 'video',
    isLocalTrack: boolean
  ): { packetLossPct: number | null; jitterMs: number | null } | null {
    if (!report) {
      return null;
    }

    let jitterMs: number | null = null;
    let packetLossPct: number | null = null;

    report.forEach((entry: any) => {
      if (entry.kind !== kind) {
        return;
      }

      if (!isLocalTrack && entry.type === 'inbound-rtp') {
        jitterMs ??= this.toJitterMs(entry.jitter);
        packetLossPct ??= this.toPacketLossPct(entry.packetsLost, entry.packetsReceived);
      }

      if (isLocalTrack && entry.type === 'remote-inbound-rtp') {
        jitterMs ??= this.toJitterMs(entry.jitter);
        packetLossPct ??= this.toPacketLossPct(entry.packetsLost, entry.packetsReceived);
      }
    });

    return { packetLossPct, jitterMs };
  }

  private normalizeBitrateKbps(currentBitrate: unknown): number | null {
    return typeof currentBitrate === 'number' && Number.isFinite(currentBitrate)
      ? Math.round(currentBitrate / 1000)
      : null;
  }

  private normalizeFrameRate(frameRate: unknown): number | null {
    return typeof frameRate === 'number' && Number.isFinite(frameRate)
      ? Math.round(frameRate)
      : null;
  }

  private toJitterMs(jitterSeconds: unknown): number | null {
    return typeof jitterSeconds === 'number' && Number.isFinite(jitterSeconds)
      ? Math.round(jitterSeconds * 1000)
      : null;
  }

  private toPacketLossPct(packetsLost: unknown, packetsReceived: unknown): number | null {
    if (
      typeof packetsLost !== 'number' ||
      !Number.isFinite(packetsLost) ||
      typeof packetsReceived !== 'number' ||
      !Number.isFinite(packetsReceived)
    ) {
      return null;
    }

    const totalPackets = packetsLost + packetsReceived;
    if (totalPackets <= 0) {
      return null;
    }

    return Math.round((packetsLost / totalPackets) * 1000) / 10;
  }

  private isSameSharedState(first: unknown, second: unknown): boolean {
    return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
  }
}

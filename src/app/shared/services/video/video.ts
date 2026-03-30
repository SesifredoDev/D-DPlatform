import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { BehaviorSubject, Subject } from 'rxjs';
import { Device, Transport } from 'mediasoup-client/types';
import { environment } from '../../../../environments/environment';
import { TokenService } from '../auth/token';

@Injectable({ providedIn: 'root' })
export class Video {
  private socket: Socket;
  private device!: Device;
  private sendTransport!: Transport;
  private recvTransport!: Transport;
  private joinedChannel: string | null = null;

  public remoteStreams$ = new BehaviorSubject<
    { id: string; stream: MediaStream; userData: any }[]
  >([]);

  // Spotify sync stream
  public spotifySync$ = new Subject<any>();

  private streamList: Map<
    string,
    { stream: MediaStream; producerIds: Set<string>; userData: any }
  > = new Map();

  private lastBytes: { [key: string]: number } = {};

  private readonly iceServers = [
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];

  constructor(private tokenService: TokenService) {
    this.socket = io(environment.videoServerUrl || 'http://localhost', {
      path: '/video/',
      withCredentials: true,
      transports: ['websocket'],
      auth: (cb) => {
        cb({ token: this.tokenService.getAccessToken() });
      }
    });

    this.registerCoreListeners();
  }

  async initVideoCall(channelId: string, initialData: any) {
    this.joinedChannel = channelId;

    const rtpCapabilities = await new Promise<any>((resolve) =>
      this.socket.emit('getRouterRtpCapabilities', channelId, resolve)
    );

    if (!rtpCapabilities || rtpCapabilities.error) throw new Error('Failed to get router RTP capabilities');

    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });

    await this.createSendTransport(channelId);
    await this.createRecvTransport(channelId);

    const existingProducers = await this.getExistingProducers(channelId);
    for (const pid of existingProducers) await this.consume(channelId, pid);
  }

  // Spotify Control
  sendSpotifyCommand(command: string, data: any) {
    if (this.joinedChannel) {
      this.socket.emit('spotify-command', { channelId: this.joinedChannel, command, data });
    }
  }

  private async createSendTransport(channelId: string) {
    const res = await new Promise<any>((resolve) =>
      this.socket.emit('createWebRtcTransport', { channelId, direction: 'send' }, resolve)
    );

    if (!res || res.error) throw new Error(res?.error || 'Failed to create send transport');

    this.sendTransport = this.device.createSendTransport({ ...res.params, iceServers: this.iceServers });

    this.sendTransport.on('connect', ({ dtlsParameters }, cb) => {
      this.socket.emit('transport-connect', { channelId, direction: 'send', dtlsParameters }, cb);
    });

    this.sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
      this.socket.emit('transport-produce', { channelId, kind, rtpParameters }, (resp: any) => {
          if (!resp || resp.error) return cb({ id: '' });
          cb({ id: resp.id });
        }
      );
    });
  }

  private async createRecvTransport(channelId: string) {
    const res = await new Promise<any>((resolve) =>
      this.socket.emit('createWebRtcTransport', { channelId, direction: 'recv' }, resolve)
    );

    if (!res || res.error) throw new Error(res?.error || 'Failed to create receive transport');
    this.recvTransport = this.device.createRecvTransport({ ...res.params, iceServers: this.iceServers });
    this.recvTransport.on('connect', ({ dtlsParameters }, cb) => {
      this.socket.emit('transport-connect', { channelId, direction: 'recv', dtlsParameters }, cb);
    });
  }

  async startProducing(stream: MediaStream) {
    if (!this.sendTransport) throw new Error('Send transport not ready');
    for (const track of stream.getTracks()) {
      try {
        if (track.kind === 'video') {
          await this.sendTransport.produce({
            track,
            encodings: [
              { rid: 'r0', maxBitrate: 150000, scaleResolutionDownBy: 4 },
              { rid: 'r1', maxBitrate: 600000, scaleResolutionDownBy: 2 },
              { rid: 'r2', maxBitrate: 4000000, scaleResolutionDownBy: 1 },
            ],
            codecOptions: { videoGoogleStartBitrate: 1500 }
          });
        } else if (track.kind === 'audio') {
          await this.sendTransport.produce({
            track,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true }
          });
        }
      } catch (err) { console.error('Failed to produce track', err); }
    }
  }

  private async consume(channelId: string, producerId: string) {
    if (!this.recvTransport) return;
    const params = await new Promise<any>((resolve) =>
      this.socket.emit('consume', { channelId, remoteProducerId: producerId, rtpCapabilities: this.device.rtpCapabilities }, resolve)
    );
    if (!params || params.error) return;
    const consumer = await this.recvTransport.consume(params);
    let entry = this.streamList.get(params.remoteSocketId);
    if (!entry) {
      entry = { stream: new MediaStream(), producerIds: new Set(), userData: params.userData || {} };
      this.streamList.set(params.remoteSocketId, entry);
    }
    entry.stream.addTrack(consumer.track);
    entry.producerIds.add(producerId);
    this.socket.emit('resume-consumer', { consumerId: consumer.id });
    this.emitStreams();
  }

  async getExistingProducers(channelId: string): Promise<string[]> {
    return new Promise((resolve) => {
      this.socket.emit('getProducers', channelId, (producerIds: string[]) => resolve(producerIds || []));
    });
  }

  updateUserData(channelId: string, data: any) {
    this.socket.emit('update-user-data', { channelId, data });
  }

  private registerCoreListeners() {
    this.socket.on('new-producer', ({ producerId }) => {
      if (this.joinedChannel) this.consume(this.joinedChannel, producerId);
    });

    this.socket.on('producer-closed', ({ producerId }) => this.removeProducer(producerId));

    this.socket.on('peer-updated', ({ socketId, data }) => {
      const entry = this.streamList.get(socketId);
      if (entry) {
        entry.userData = data;
        this.emitStreams();
      }
    });

    this.socket.on('spotify-state-sync', (state) => {
        this.spotifySync$.next(state);
    });
  }

  async leaveCall(channelId: string) {
    this.joinedChannel = null;
    if (this.sendTransport) this.sendTransport.close();
    if (this.recvTransport) this.recvTransport.close();
    this.socket.emit('leave-room', { channelId });
    this.streamList.clear();
    this.emitStreams();
  }

  private removeProducer(producerId: string) {
    for (const [socketId, entry] of this.streamList.entries()) {
      if (entry.producerIds.has(producerId)) {
        entry.producerIds.delete(producerId);
        if (entry.producerIds.size === 0) this.streamList.delete(socketId);
        break;
      }
    }
    this.emitStreams();
  }

  private emitStreams() {
    const arr = Array.from(this.streamList.entries()).map(([id, value]) => ({
      id,
      userData: value.userData,
      stream: new MediaStream(value.stream.getTracks()),
    }));
    this.remoteStreams$.next(arr);
  }
}

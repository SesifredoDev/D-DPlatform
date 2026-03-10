import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { BehaviorSubject } from 'rxjs';
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

  private streamList: Map<
    string,
    { stream: MediaStream; producerIds: Set<string>; userData: any }
  > = new Map();

  constructor(private tokenService: TokenService) {
    this.socket = io('http://localhost',{
      path: '/video/',
      withCredentials: true,
        transports: ['websocket'],
        auth: (cb) => {
        // This callback ensures the most recent token is sent
          // even if the socket reconnects later
          //
          cb({ token: this.tokenService.getAccessToken() }); } });

    this.registerCoreListeners(); }

  /* -------------------------- INIT CALL -------------------------- */
  async initVideoCall(channelId: string, initialData: any) {
    this.joinedChannel = channelId;

    // Get router RTP capabilities
    const rtpCapabilities = await new Promise<any>((resolve) =>
      this.socket.emit('getRouterRtpCapabilities', channelId, resolve)
    );

    if (!rtpCapabilities || rtpCapabilities.error) {
      throw new Error('Failed to get router RTP capabilities');
    }
    console.log('[DEBUG] initVideoCall: loading device...');
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    console.log('[DEBUG] Device loaded');

    console.log('[DEBUG] Creating send transport...');
    await this.createSendTransport(channelId);
    console.log('[DEBUG] Send transport created');

    console.log('[DEBUG] Creating recv transport...');
    await this.createRecvTransport(channelId);
    console.log('[DEBUG] Recv transport created');

    const existingProducers = await this.getExistingProducers(channelId);
    console.log('[DEBUG] Existing producers:', existingProducers);
    for (const pid of existingProducers) {
      console.log('[DEBUG] Consuming producer:', pid);
      await this.consume(channelId, pid);
    }
  }



  /* ---------------------- TRANSPORT CREATION ---------------------- */
  private async createSendTransport(channelId: string) {
    const res = await new Promise<any>((resolve) =>
      this.socket.emit('createWebRtcTransport', { channelId, direction: 'send' }, resolve)
    );

    if (!res || res.error) throw new Error(res?.error || 'Failed to create send transport');

    this.sendTransport = this.device.createSendTransport(res.params);

    this.sendTransport.on('connect', ({ dtlsParameters }, cb) => {
      this.socket.emit('transport-connect', { channelId, direction: 'send', dtlsParameters }, cb);
    });

    this.sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
      this.socket.emit(
        'transport-produce',
        { channelId, kind, rtpParameters },
        (resp: any) => {
          if (!resp || resp.error) {
            console.error('Failed to produce track:', resp?.error);
            return cb({ id: '' });
          }
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

    this.recvTransport = this.device.createRecvTransport(res.params);

    this.recvTransport.on('connect', ({ dtlsParameters }, cb) => {
      this.socket.emit('transport-connect', { channelId, direction: 'recv', dtlsParameters }, cb);
    });
  }

  /* -------------------------- PRODUCING -------------------------- */
  async startProducing(stream: MediaStream) {
    if (!this.sendTransport) throw new Error('Send transport not ready');

    for (const track of stream.getTracks()) {
      try {
        if (track.kind === 'video') {
          await this.sendTransport.produce({
            track,
            encodings: [
              // Low Quality (180p-ish)
              { rid: 'r0', maxBitrate: 150000, scaleResolutionDownBy: 4 },
              // Medium Quality (360p-ish)
              { rid: 'r1', maxBitrate: 500000, scaleResolutionDownBy: 2 },
              // High Quality (720p/1080p)
              { rid: 'r2', maxBitrate: 2500000, scaleResolutionDownBy: 1 }
            ],
            codecOptions: {
              // Start at 1Mbps instead of 1kbps to avoid initial pixelation
              videoGoogleStartBitrate: 1000
            }
          });
        } else {
          await this.sendTransport.produce({ track });
        }
      } catch (err) {
        console.error('Failed to produce track', err);
      }
    }
  }
  /* -------------------------- CONSUMING -------------------------- */
  private async consume(channelId: string, producerId: string) {
    if (!this.recvTransport) return;

    const params = await new Promise<any>((resolve) =>
      this.socket.emit(
        'consume',
        { channelId, remoteProducerId: producerId, rtpCapabilities: this.device.rtpCapabilities },
        resolve
      )
    );

    if (!params || params.error) return;
    const consumer = await this.recvTransport.consume(params);

    // Add track to stream
    let entry = this.streamList.get(params.remoteSocketId);
    if (!entry) {
      entry = { stream: new MediaStream(), producerIds: new Set(), userData: params.userData || {} };
      this.streamList.set(params.remoteSocketId, entry);
    }

    console.log(`[DEBUG] Consuming remote producer ${producerId} on channel ${channelId}`);

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

  /* -------------------------- USER DATA -------------------------- */
  updateUserData(channelId: string, data: any) {
    this.socket.emit('update-user-data', { channelId, data });
  }

  /* -------------------------- LISTENERS -------------------------- */
  private registerCoreListeners() {
    this.socket.on('new-producer', ({ producerId }) => {
      if (!this.joinedChannel) return;
      this.consume(this.joinedChannel, producerId);
    });

    this.socket.on('producer-closed', ({ producerId }) => {
      this.removeProducer(producerId);
    });

    this.socket.on('peer-updated', ({ socketId, data }) => {
      const entry = this.streamList.get(socketId);
      if (entry) {
        entry.userData = data;
        this.emitStreams();
      }
    });
  }

  /* -------------------------- LEAVE -------------------------- */
  async leaveCall(channelId: string) {
    this.joinedChannel = null;

    if (this.sendTransport) this.sendTransport.close();
    if (this.recvTransport) this.recvTransport.close();

    this.socket.emit('leave-room', { channelId });

    this.streamList.clear();
    this.emitStreams();
  }

  /* -------------------------- HELPERS -------------------------- */
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

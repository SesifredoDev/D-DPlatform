import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { BehaviorSubject } from 'rxjs';
import { Device, Transport } from 'mediasoup-client/types';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class Video {
  private socket: Socket;
  private device!: mediasoupClient.Device;
  private sendTransport!: Transport;
  private recvTransport!: Transport;

  public remoteStreams$ = new BehaviorSubject<{ id: string; stream: MediaStream }[]>([]);
  private streamList: { id: string; stream: MediaStream }[] = [];

  constructor() {
    this.socket = io(environment.apiURL, { withCredentials: true });
  }

  async initVideoCall(channelId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('getRouterRtpCapabilities', channelId, async (rtpCapabilities: any) => {
        try {
          this.device = new mediasoupClient.Device();
          await this.device.load({ routerRtpCapabilities: rtpCapabilities });

          await this.createSendTransport(channelId);
          await this.createRecvTransport(channelId);

          this.handleSignaling(channelId);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private createSendTransport(channelId: string): Promise<void> {
    return new Promise(resolve => {
      this.socket.emit('createWebRtcTransport', { channelId, direction: 'send' }, ({ params }: any) => {
        this.sendTransport = this.device.createSendTransport(params);
        this.sendTransport.on('connect', ({ dtlsParameters }, cb) =>
          this.socket.emit('transport-connect', { channelId, direction: 'send', dtlsParameters }, cb));
        this.sendTransport.on('produce', ({ kind, rtpParameters }, cb) =>
          this.socket.emit('transport-produce', { channelId, kind, rtpParameters }, cb));
        resolve();
      });
    });
  }

  private createRecvTransport(channelId: string): Promise<void> {
    return new Promise(resolve => {
      this.socket.emit('createWebRtcTransport', { channelId, direction: 'recv' }, ({ params }: any) => {
        this.recvTransport = this.device.createRecvTransport(params);
        this.recvTransport.on('connect', ({ dtlsParameters }, cb) =>
          this.socket.emit('transport-connect', { channelId, direction: 'recv', dtlsParameters }, cb));
        resolve();
      });
    });
  }

  async startProducing(channelId: string, stream: MediaStream) {
    if (!this.sendTransport) return;
    for (const track of stream.getTracks()) {
      await this.sendTransport.produce({ track });
    }
  }

  private handleSignaling(channelId: string) {
    this.socket.on('new-producer', ({ producerId }) => this.consumeStream(channelId, producerId));
    this.socket.on('producer-closed', ({ producerId }) => this.removeProducerTrack(producerId));

    // Now that transports are ready, ask for existing producers
    this.socket.emit('getProducers', channelId, (ids: string[]) => {
      ids.forEach(id => this.consumeStream(channelId, id));
    });
  }

  private async consumeStream(channelId: string, producerId: string) {
    if (!this.recvTransport) return;

    this.socket.emit('consume', { channelId, remoteProducerId: producerId, rtpCapabilities: this.device.rtpCapabilities },
      async (params: any) => {
        if (params.error) return;

        const consumer = await this.recvTransport.consume(params);
        this.socket.emit('resume-consumer', { channelId, consumerId: consumer.id });

        // Group tracks by remoteSocketId (the user)
        let entry = this.streamList.find(s => s.id === params.remoteSocketId);
        if (!entry) {
          entry = { id: params.remoteSocketId, stream: new MediaStream() };
          this.streamList.push(entry);
        }

        entry.stream.addTrack(consumer.track);
        this.remoteStreams$.next([...this.streamList]);

        consumer.on('transportclose', () => this.removeProducerTrack(producerId));
      });
  }

  private removeProducerTrack(producerId: string) {
    // Basic cleanup: if a user leaves, their socketId will eventually be removed from the list via other signaling
    // or you can implement more granular track removal here.
    this.streamList = this.streamList.filter(s => s.id !== producerId);
    this.remoteStreams$.next([...this.streamList]);
  }
}

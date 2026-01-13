import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable } from 'rxjs';
import {environment} from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class Message {
  private socket: Socket;
  private messageSource = new BehaviorSubject<any[]>([]);
  public messages$ = this.messageSource.asObservable();

  constructor(private http: HttpClient) {
    // Initialize socket connection
    this.socket = io(environment.apiURL, { withCredentials: true });

    // Listen for the 'new_message' event defined in message.controller.js
    this.socket.on('new_message', (message: any) => {
      const currentMessages = this.messageSource.value;
      this.messageSource.next([...currentMessages, message]);
      console.log(message);
    });
  }

  // Join a specific channel room
  joinChannel(channelId: string) {
    this.socket.emit('join_channel', channelId);
    this.getHistory(channelId).subscribe(msgs => this.messageSource.next(msgs.reverse()));
  }

  // Fetch history via HTTP GET
  getHistory(channelId: string): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiURL}message/${channelId}`);
  }

  // Send message via HTTP POST
  sendMessage(channelId: string, content: string, characterId?: string) {
    console.log(characterId);
    return this.http.post(`${environment.apiURL}message/${channelId}`, {
      content,
      characterId
    });
  }
}

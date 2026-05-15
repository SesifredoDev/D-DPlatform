import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import {BehaviorSubject, Observable} from 'rxjs';

import {environment} from '../../../../environments/environment';
import {handleApiError} from '../../utils/api-error.util';
import {IChannel} from '../../models/server/channel.model';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';
@Injectable({
  providedIn: 'root',
})
export class ChannelService {
  private static readonly selectedChannelStateKey = 'channel:selected';

  private baseUrl = environment.apiURL+'server';

  private selectedChannelSubject = new BehaviorSubject<IChannel | null>(null);
  public currentChannel$ = this.selectedChannelSubject.asObservable();

  constructor(
    private http: HttpClient,
    private sharedWindowState: SharedWindowStateService
  ) {
    this.selectedChannelSubject.next(
      this.sharedWindowState.getSnapshot<IChannel>(ChannelService.selectedChannelStateKey, null)
    );

    this.sharedWindowState.observe<IChannel>(ChannelService.selectedChannelStateKey, null)
      .subscribe(channel => {
        if (!this.isSameChannel(this.selectedChannelSubject.value, channel)) {
          this.selectedChannelSubject.next(channel);
        }
      });
  }

  get currentChannel(): IChannel | null {
    return this.selectedChannelSubject.value;
  }

  listChannels(serverId: string): Observable<any[]> {
    return this.http
      .get<any[]>(`${this.baseUrl}/${serverId}/channels`, {
        withCredentials: true
      })
      .pipe(catchError(handleApiError));
  }

  createChannel(serverId: string, payload: any): Observable<any> {
    return this.http
      .post(`${this.baseUrl}/${serverId}/channels`, payload, {
        withCredentials: true
      })
      .pipe(catchError(handleApiError));
  }

  updateChannel(
    serverId: string,
    channelId: string,
    payload: any
  ): Observable<any> {
    return this.http
      .patch(
        `${this.baseUrl}/${serverId}/channels/${channelId}`,
        payload,
        { withCredentials: true }
      )
      .pipe(catchError(handleApiError));
  }

  deleteChannel(serverId: string, channelId: string): Observable<any> {
    return this.http
      .delete(
        `${this.baseUrl}/${serverId}/channels/${channelId}`,
        { withCredentials: true }
      )
      .pipe(catchError(handleApiError));
  }



  getChannelObservable(){
    return this.currentChannel$;
  }

  setChannelObservable(channel: IChannel){
    this.selectedChannelSubject.next(channel);
    this.sharedWindowState.publish(ChannelService.selectedChannelStateKey, channel);
  }

  private isSameChannel(first: IChannel | null, second: IChannel | null): boolean {
    return (first?._id ?? null) === (second?._id ?? null) &&
      JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
  }
}

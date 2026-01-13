import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import {Observable, Subject} from 'rxjs';

import {environment} from '../../../../environments/environment';
import {handleApiError} from '../../utils/api-error.util';
import {IChannel} from '../../models/server/channel.model';
@Injectable({
  providedIn: 'root',
})
export class ChannelService {

  private baseUrl = environment.apiURL+'server';

  private selectedChannelObservable = new Subject<IChannel | null>();
  constructor(private http: HttpClient) {}

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
      .put(
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
    return this.selectedChannelObservable;
  }

  setChannelObservable(channel: IChannel){
    this.selectedChannelObservable.next(channel);
  }

}

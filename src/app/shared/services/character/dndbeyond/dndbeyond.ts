import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {lastValueFrom, Observable} from 'rxjs';
import {environment} from '../../../../../environments/environment';

@Injectable({
  providedIn: 'root',
})

export class dndbeyond {
  // Accessing the base URL from your environment file
  private readonly baseUrl = `${environment.apiURL}ddb`;

  constructor(private http: HttpClient) {}

  getCharacterIdFromLink(link: string): string | null {
    if (!link) return null;
    const match = link.match(/\/characters\/(\d+)/);
    return match ? match[1] : null;
  }

  getLinkFromCharacterId(id: string | number): string {
    return `https://www.dndbeyond.com/characters/${id}`;
  }

  getSurfaceInformation(query: string): Observable<any> {
    const encodedQuery = encodeURIComponent(query);
    return this.http.get<any>(`${this.baseUrl}/${encodedQuery}`);
  }

}

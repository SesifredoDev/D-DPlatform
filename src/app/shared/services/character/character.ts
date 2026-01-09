import { Injectable } from '@angular/core';
import {Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../../../environments/environment';
import {Character} from '../../models/user/character.model';

@Injectable({
  providedIn: 'root',
})
export class CharacterService {
  private readonly apiUrl = `${environment.apiURL}character`;

  constructor(private http: HttpClient) {}

  getMyCharacters(): Observable<Character[]> {
    return this.http.get<Character[]>(this.apiUrl);
  }


  saveCharacter(
    characterData: Partial<Character>,
    iconFile?: File,
    pdfFile?: File,
    serverId?: string
  ): Observable<Character> {
    const formData = new FormData();

    // Append the basic fields
    formData.append('name', characterData.name || '');
    formData.append('race', characterData.race || '');
    formData.append('ac', (characterData.ac || 10).toString());

    if (characterData.ddbId) formData.append('ddbId', characterData.ddbId.toString());
    if (serverId) formData.append('serverId', serverId);

    formData.append('baseStats', JSON.stringify(characterData.baseStats));
    formData.append('classes', JSON.stringify(characterData.classes));

    if (iconFile) {
      formData.append('icon', iconFile);
    } else if (characterData.icon) {
      formData.append('icon', characterData.icon);
    }

    if (pdfFile) {
      formData.append('pdf', pdfFile);
    } else if (characterData.pdfLink) {
      formData.append('pdfLink', characterData.pdfLink);
    }

    return this.http.post<Character>(this.apiUrl, formData);
  }
}

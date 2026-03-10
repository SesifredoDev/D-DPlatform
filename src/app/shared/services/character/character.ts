import { Injectable } from '@angular/core';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../../../environments/environment';
import {ICharacter} from '../../models/user/character.model';

@Injectable({
  providedIn: 'root',
})
export class CharacterService {
  activeCharacter = new BehaviorSubject<ICharacter | null>(null);
  private readonly apiUrl = `${environment.apiURL}character`;

  constructor(private http: HttpClient) {}

  getMyCharacters(): Observable<ICharacter[]> {
    return this.http.get<ICharacter[]>(this.apiUrl);
  }


  saveCharacter(
    characterData: Partial<ICharacter>,
    iconFile?: File,
    pdfFile?: File,
  ): Observable<ICharacter> {
    const formData = new FormData();

    // Append the basic fields
    formData.append('name', characterData.name || '');
    formData.append('race', characterData.race || '');
    formData.append('ac', (characterData.ac || 10).toString());

    if (characterData.ddbId) formData.append('ddbId', characterData.ddbId.toString());

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

    return this.http.post<ICharacter>(this.apiUrl, formData);
  }

  updateCharacter(
    id: string,
    characterData: Partial<ICharacter>,
    iconFile?: File,
    pdfFile?: File
  ): Observable<any> {
    const formData = new FormData();

    if (characterData.name) formData.append('name', characterData.name);

    if (characterData.servers) {
      formData.append('servers', JSON.stringify(characterData.servers));
    }

    if (characterData.baseStats) {
      formData.append('baseStats', JSON.stringify(characterData.baseStats));
    }
    if (characterData.classes) {
      formData.append('classes', JSON.stringify(characterData.classes));
    }
    if(characterData.ddbUsername){
      formData.append('ddbUsername', characterData.ddbUsername);

    }
    if (iconFile) formData.append('icon', iconFile);
    if (pdfFile) formData.append('pdf', pdfFile);



    return this.http.put(`${this.apiUrl}/${id}`, formData);
  }

  setActiveCharacter(characterData: ICharacter) {
    this.activeCharacter.next(characterData);
    return characterData;
  }
  getActiveCharacterObservable(){
    return this.activeCharacter;
  }
}

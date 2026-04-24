import { Injectable } from '@angular/core';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../../../environments/environment';
import {ICharacter} from '../../models/user/character.model';
import { FileService } from '../file/file';

@Injectable({
  providedIn: 'root',
})
export class CharacterService {
  activeCharacter = new BehaviorSubject<ICharacter | null>(null);
  private readonly apiUrl = `${environment.apiURL}character`;

  constructor(
    private http: HttpClient,
    private fileService: FileService
  ) {}

  getMyCharacters(): Observable<ICharacter[]> {
    return this.http.get<ICharacter[]>(this.apiUrl, { withCredentials: true });
  }

  async uploadCharacterAsset(file: File) {
    return this.fileService.uploadFileInChunks(file);
  }

  saveCharacter(
    characterData: Partial<ICharacter>
  ): Observable<ICharacter> {
    const formData = new FormData();

    // Append the basic fields
    formData.append('name', characterData.name || '');
    formData.append('race', characterData.race || '');
    formData.append('ac', (characterData.ac || 10).toString());

    if (characterData.ddbId) formData.append('ddbId', characterData.ddbId.toString());

    formData.append('baseStats', JSON.stringify(characterData.baseStats));
    formData.append('classes', JSON.stringify(characterData.classes));

    if (characterData.icon) {
      formData.append('icon', characterData.icon);
    }

    if (characterData.pdfLink) {
      formData.append('pdfLink', characterData.pdfLink);
    }

    return this.http.post<ICharacter>(this.apiUrl, formData, { withCredentials: true });
  }

  updateCharacter(
    id: string,
    characterData: Partial<ICharacter>
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
    if (characterData.race !== undefined) {
      formData.append('race', characterData.race || '');
    }
    if (characterData.ac !== undefined) {
      formData.append('ac', characterData.ac.toString());
    }
    if (characterData.icon !== undefined) {
      formData.append('icon', characterData.icon || '');
    }
    if (characterData.pdfLink !== undefined) {
      formData.append('pdfLink', characterData.pdfLink || '');
    }



    return this.http.put(`${this.apiUrl}/${id}`, formData, { withCredentials: true });
  }

  deleteCharacter(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`, { withCredentials: true });
  }

  setActiveCharacter(characterData: ICharacter) {
    this.activeCharacter.next(characterData);
    return characterData;
  }
  getActiveCharacterObservable(){
    return this.activeCharacter;
  }
}

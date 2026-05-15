import { Injectable } from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../../../environments/environment';
import {ICharacter} from '../../models/user/character.model';
import { SharedWindowStateService } from '../window-state/shared-window-state.service';

@Injectable({
  providedIn: 'root',
})
export class CharacterService {
  private static readonly activeCharacterStateKey = 'character:active';

  activeCharacter = new BehaviorSubject<ICharacter | null>(null);
  private readonly apiUrl = `${environment.apiURL}character`;

  constructor(
    private http: HttpClient,
    private sharedWindowState: SharedWindowStateService
  ) {
    this.activeCharacter.next(
      this.sharedWindowState.getSnapshot<ICharacter>(CharacterService.activeCharacterStateKey, null)
    );

    this.sharedWindowState.observe<ICharacter>(CharacterService.activeCharacterStateKey, null)
      .subscribe(character => {
        if (!this.isSameCharacter(this.activeCharacter.value, character)) {
          this.activeCharacter.next(character);
        }
      });
  }

  getMyCharacters(): Observable<ICharacter[]> {
    return this.http.get<ICharacter[]>(this.apiUrl, { withCredentials: true });
  }

  private buildCharacterFormData(
    characterData: Partial<ICharacter>,
    assets?: { icon?: File | null; pdf?: File | null }
  ): FormData {
    const formData = new FormData();

    if (characterData.name !== undefined) {
      formData.append('name', characterData.name || '');
    }

    if (characterData.race !== undefined) {
      formData.append('race', characterData.race || '');
    }

    if (characterData.ac !== undefined) {
      formData.append('ac', characterData.ac.toString());
    }

    if (characterData.ddbId !== undefined && characterData.ddbId !== null) {
      formData.append('ddbId', characterData.ddbId.toString());
    }

    if (characterData.ddbUsername !== undefined && characterData.ddbUsername !== null) {
      formData.append('ddbUsername', characterData.ddbUsername);
    }

    if (characterData.servers !== undefined) {
      formData.append('servers', JSON.stringify(characterData.servers));
    }

    if (characterData.baseStats !== undefined) {
      formData.append('baseStats', JSON.stringify(characterData.baseStats));
    }

    if (characterData.classes !== undefined) {
      formData.append('classes', JSON.stringify(characterData.classes));
    }

    if (assets?.icon) {
      formData.append('icon', assets.icon, assets.icon.name);
    } else if (characterData.icon !== undefined) {
      formData.append('icon', characterData.icon || '');
    }

    if (assets?.pdf) {
      formData.append('pdf', assets.pdf, assets.pdf.name);
    } else if (characterData.pdfLink !== undefined) {
      formData.append('pdfLink', characterData.pdfLink || '');
    }

    return formData;
  }

  saveCharacter(
    characterData: Partial<ICharacter>,
    assets?: { icon?: File | null; pdf?: File | null }
  ): Observable<ICharacter> {
    const formData = this.buildCharacterFormData(characterData, assets);
    return this.http.post<ICharacter>(this.apiUrl, formData, { withCredentials: true });
  }

  updateCharacter(
    id: string,
    characterData: Partial<ICharacter>,
    assets?: { icon?: File | null; pdf?: File | null }
  ): Observable<any> {
    const formData = this.buildCharacterFormData(characterData, assets);
    return this.http.put(`${this.apiUrl}/${id}`, formData, { withCredentials: true });
  }

  deleteCharacter(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`, { withCredentials: true });
  }

  setActiveCharacter(characterData: ICharacter) {
    this.activeCharacter.next(characterData);
    this.sharedWindowState.publish(CharacterService.activeCharacterStateKey, characterData);
    return characterData;
  }
  getActiveCharacterObservable(){
    return this.activeCharacter;
  }

  private isSameCharacter(first: ICharacter | null, second: ICharacter | null): boolean {
    return (first?._id ?? null) === (second?._id ?? null) &&
      JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
  }
}

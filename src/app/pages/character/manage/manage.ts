import { Component } from '@angular/core';


import {  OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { CharacterService } from '../../../shared/services/character/character';
import {ICharacter} from '../../../shared/models/user/character.model';
import {CreateCharacterComponent} from '../create/create';
import {MatMenuModule} from '@angular/material/menu';
import {MatDividerModule} from '@angular/material/divider';
import { Edit } from '../edit/edit';
import {dndbeyond} from '../../../shared/services/character/dndbeyond/dndbeyond';
import {Validators} from '@angular/forms';
import {ServerService} from '../../../shared/services/server/server';
import {IServer} from '../../../shared/models/server/server.model';
import {RouterLink} from '@angular/router';

@Component({
  selector: 'app-manage',
  imports: [CommonModule, MatButtonModule, MatCardModule, MatIconModule, MatChipsModule, MatMenuModule, MatDividerModule, RouterLink],
  templateUrl: './manage.html',
  styleUrl: './manage.scss'
})
export class Manage implements OnInit {
  characters: ICharacter[] = [];
  selectedCharacterId: string | undefined = undefined;


  // Temporary Server Management Mock
  availableServers: IServer[] = [
  ];

  constructor(
    private charService: CharacterService,
    private serverService: ServerService,
    private ddbService: dndbeyond,
    private dialog: MatDialog
  ) {}

  ngOnInit(): void {
    this.loadCharacters();
    this.charService.getActiveCharacterObservable().subscribe(char => {
      if (char) this.selectedCharacterId = char._id;
    });
    this.serverService.getMyServersObservable().subscribe(servers => {
      this.availableServers   = servers;
    })
    this.serverService.getMyServers();
  }

  loadCharacters() {
    this.charService.getMyCharacters().subscribe(data => {
      this.characters = data;
    });
  }

  openCreateDialog() {
    const dialogRef = this.dialog.open(CreateCharacterComponent, {
      width: '600px',
      maxHeight: '90vh'
    });

    dialogRef.afterClosed().subscribe(() => this.loadCharacters());
  }

  selectCharacter(char: ICharacter) {
    this.charService.setActiveCharacter(char);
    this.selectedCharacterId = char._id;
  }

  editCharacter(char: ICharacter) {
    const dialogRef = this.dialog.open(Edit, {
      width: '60vw',
      maxHeight: '90vh',
      data: char, // Pass the character object to the dialog
      // panelClass: 'resizable-dialog'
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.loadCharacters(); // Refresh the list if an update occurred
      }
    });
  }

  isAssigned(char: ICharacter, serverId: string): boolean {
    return char.servers?.includes(serverId) || false;
  }

  toggleServer(char: ICharacter, serverId: string) {
    if (!char._id) return;

    let updatedServers = char.servers ? [...char.servers] : [];

    if (updatedServers.includes(serverId)) {
      updatedServers = updatedServers.filter(id => id !== serverId);
    } else {
      updatedServers.push(serverId);
    }
    const update: Partial<ICharacter> = {
      _id: char._id,
      servers: updatedServers
    };

    this.charService.updateCharacter(char._id, update).subscribe({
      next: () => {
        console.log(`Server list updated for ${char.name}`);
        this.loadCharacters();
      },
      error: (err) => console.error("Failed to update servers", err)
    });
  }

  syncWithDdb(char: ICharacter) {
    if (!char.ddbId) return;

    this.ddbService.getSurfaceInformation(char.ddbId.toString()).subscribe({
      next: (data) => {
        const updatedData: Partial<ICharacter> = {
          _id: char._id,
          name: data.name,
          race: data.race,
          ac: data.ac,
          ddbId: data.id,
          icon: data.icon,
          baseStats: data.baseStats,
          classes: data.classes.map((c: any) => ({
            className: c.className,
            subclassName: c.subclassName || '',
            level: c.level
          }))
        };

        if(!updatedData._id) return
        this.charService.updateCharacter(updatedData._id, updatedData).subscribe(() => {
          this.loadCharacters(); // Refresh UI
          console.log(`${char.name} synchronized successfully.`);
        });
      }
    });
  }



}

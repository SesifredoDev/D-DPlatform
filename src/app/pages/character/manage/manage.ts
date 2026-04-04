import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { CharacterService } from '../../../shared/services/character/character';
import { ICharacter } from '../../../shared/models/user/character.model';
import { CreateCharacterComponent } from '../create/create';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { Edit } from '../edit/edit';
import { dndbeyond } from '../../../shared/services/character/dndbeyond/dndbeyond';
import { ServerService } from '../../../shared/services/server/server';
import { IServer } from '../../../shared/models/server/server.model';
import { Router, RouterLink } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-manage',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatChipsModule,
    MatMenuModule,
    MatDividerModule,
    RouterLink,
    MatTooltipModule,
    MatDialogModule
  ],
  templateUrl: './manage.html',
  styleUrl: './manage.scss'
})
export class Manage implements OnInit {
  characters: ICharacter[] = [];
  selectedCharacterId: string | undefined = undefined;
  availableServers: IServer[] = [];

  constructor(
    private charService: CharacterService,
    private serverService: ServerService,
    private ddbService: dndbeyond,
    private dialog: MatDialog,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.loadCharacters();
    this.charService.getActiveCharacterObservable().subscribe(char => {
      if (char) this.selectedCharacterId = char._id;
    });
    this.serverService.getMyServersObservable().subscribe(servers => {
      this.availableServers = servers;
    });
    this.serverService.getMyServers();
  }

  loadCharacters() {
    this.charService.getMyCharacters().subscribe(data => {
      this.characters = data;
    });
  }

  getTotalLevel(char: ICharacter): number {
    return char.classes?.reduce((acc, c) => acc + (c.level || 0), 0) || 0;
  }

  openCreateDialog() {
    const dialogRef = this.dialog.open(CreateCharacterComponent, {
      width: '800px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      panelClass: 'glass-dialog-container'
    });

    dialogRef.afterClosed().subscribe(() => this.loadCharacters());
  }

  editCharacter(char: ICharacter) {
    const dialogRef = this.dialog.open(Edit, {
      width: '800px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      data: char,
      panelClass: 'glass-dialog-container'
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.loadCharacters();
      }
    });
  }

  deleteCharacter(char: ICharacter) {
    if (confirm(`Are you sure you want to permanently delete ${char.name}?`)) {
      if (!char._id) return;
      this.charService.deleteCharacter(char._id).subscribe({
        next: () => {
          this.loadCharacters();
        },
        error: (err: any) => console.error("Failed to delete character", err)
      });
    }
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
          ddbUsername: data.username,
          icon: data.icon,
          baseStats: data.baseStats,
          classes: data.classes.map((c: any) => ({
            className: c.className,
            subclassName: c.subclassName || '',
            level: c.level
          }))
        };

        if (!updatedData._id) return;
        this.charService.updateCharacter(updatedData._id, updatedData).subscribe(() => {
          this.loadCharacters();
          console.log(`${char.name} synchronized successfully.`);
        });
      }
    });
  }

  closeManager() {
    this.router.navigate(['']);
  }
}

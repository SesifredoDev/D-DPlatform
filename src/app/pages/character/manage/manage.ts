import { Component, OnDestroy, OnInit } from '@angular/core';
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
import { Router } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { finalize, Subscription } from 'rxjs';
import { UserService } from '../../../shared/services/user/user';
import { IUser } from '../../../shared/models/user/user.model';

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
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatDialogModule
  ],
  templateUrl: './manage.html',
  styleUrl: './manage.scss'
})
export class Manage implements OnInit, OnDestroy {
  private readonly subscriptions = new Subscription();
  readonly maxProfileIconSizeMb = 10;

  characters: ICharacter[] = [];
  selectedCharacterId: string | undefined = undefined;
  availableServers: IServer[] = [];
  currentUser: IUser | null = null;
  profileLoading = true;
  profileUploading = false;
  profileIconPreview: string | null = null;

  constructor(
    private charService: CharacterService,
    private serverService: ServerService,
    private ddbService: dndbeyond,
    private userService: UserService,
    private dialog: MatDialog,
    private router: Router,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.loadProfile();
    this.loadCharacters();
    this.subscriptions.add(
      this.charService.getActiveCharacterObservable().subscribe(char => {
        this.selectedCharacterId = char?._id;
      })
    );
    this.subscriptions.add(
      this.serverService.getMyServersObservable().subscribe(servers => {
        this.availableServers = servers;
      })
    );
    this.serverService.getMyServers();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  loadProfile() {
    this.profileLoading = true;
    this.userService.getMe()
      .pipe(finalize(() => this.profileLoading = false))
      .subscribe({
        next: user => {
          this.currentUser = user;
        },
        error: err => {
          console.warn('Failed to load profile', err);
        }
      });
  }

  loadCharacters() {
    this.charService.getMyCharacters().subscribe(data => {
      this.characters = data;
    });
  }

  get profileDisplayName(): string {
    return this.currentUser?.username || 'Player Profile';
  }

  get profileSubtitle(): string {
    return this.currentUser?.email || 'Profile identity for chat, whispers, and default table presence.';
  }

  get profileId(): string {
    return this.currentUser?._id || this.currentUser?.id || 'profile';
  }

  get profileAvatarSrc(): string {
    return this.profileIconPreview ||
      this.currentUser?.profileIconUrl ||
      this.currentUser?.profileIcon ||
      `https://www.gravatar.com/avatar/${this.profileId}?d=identicon`;
  }

  getTotalLevel(char: ICharacter): number {
    return char.classes?.reduce((acc, c) => acc + (c.level || 0), 0) || 0;
  }

  onProfileIconSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.snackBar.open('Choose an image file for your profile icon.', 'Close', { duration: 3000 });
      return;
    }

    if (file.size > this.maxProfileIconSizeMb * 1024 * 1024) {
      this.snackBar.open(`Profile images must be ${this.maxProfileIconSizeMb}MB or smaller.`, 'Close', { duration: 3000 });
      return;
    }

    this.previewProfileIcon(file);
    this.profileUploading = true;
    this.userService.uploadProfileIcon(file)
      .pipe(finalize(() => this.profileUploading = false))
      .subscribe({
        next: response => {
          this.currentUser = response.user;
          this.profileIconPreview = null;
          this.snackBar.open('Profile icon updated.', 'OK', { duration: 2000 });
        },
        error: err => {
          console.error('Failed to update profile icon', err);
          this.profileIconPreview = null;
          this.snackBar.open('Profile icon update failed.', 'Close', { duration: 3000 });
        }
      });
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
        const ddbPdfLink = data.ddbPdfLink || data.pdfLink ||
          this.ddbService.getPdfLinkFromCharacterId(data.id, data.username);
        const shouldUseDdbPdf = !char.pdfLink || char.pdfLink === char.ddbPdfLink;
        const updatedData: Partial<ICharacter> = {
          _id: char._id,
          name: data.name,
          race: data.race,
          ac: data.ac,
          ddbId: data.id,
          ddbUsername: data.username,
          ddbPdfLink,
          pdfLink: shouldUseDdbPdf ? ddbPdfLink : char.pdfLink,
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

  private previewProfileIcon(file: File) {
    const reader = new FileReader();
    reader.onload = event => {
      this.profileIconPreview = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  }
}

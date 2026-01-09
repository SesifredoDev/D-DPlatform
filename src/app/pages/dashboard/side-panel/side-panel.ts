import {AfterViewInit, Component, OnInit} from '@angular/core';
import {MatCardModule} from '@angular/material/card';
import {Character} from '../../../shared/models/user/character.model';
import {CharacterService} from '../../../shared/services/character/character';
import {CommonModule} from '@angular/common';
import {MatSelectModule} from '@angular/material/select';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatListModule} from '@angular/material/list';
import {MatIconModule} from '@angular/material/icon';
import {MatButtonModule} from '@angular/material/button';
import {MatDividerModule} from '@angular/material/divider';
import {Router} from '@angular/router';
import {MatMenuModule} from '@angular/material/menu';
import {UserService} from '../../../shared/services/user/user';

@Component({
  selector: 'app-side-panel',
  imports: [CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatMenuModule
  ],
  templateUrl: './side-panel.html',
  styleUrl: './side-panel.scss',
})
export class SidePanel implements OnInit, AfterViewInit {
  characters: Character[] = [];
  selectedCharacter: Character | null = null;

  channels = [
    {name: 'stats', label: 'General', icon: 'message'},
    {name: 'inventory', label: 'Session Channel', icon: 'mic'},
    {name: 'spells', label: 'Lore Channel', icon: 'auto_stories'},
    {name: 'notes', label: 'Hero Forge', icon: 'image'}
  ];

  servers = [
    { id: '101', name: 'The Forgotten Realms' },
    { id: '102', name: 'Curse of Strahd Group' },
    { id: '103', name: 'Homebrew Campaign' },
    { id: '104', name: 'Testing Server' }
  ];

  selectedServer = this.servers[0];

  constructor(private charService: CharacterService, private userService: UserService, private router: Router) {}

  ngOnInit(): void {
    this.charService.getMyCharacters().subscribe((chars) =>{
      this.characters = chars;
    });
    this.userService.getMe().subscribe((user) =>{
      console.log(user);
      this.characters.push({
        ac: 0,
        baseStats: {
          strength: 0,
          dexterity: 0,
          constitution: 0,
          intelligence: 0,
          wisdom: 0,
          charisma: 0
        },
        classes: [],
        ownerId: '',
        race: 'Human? Maybe...',
        servers: [],
        name:user.username, icon: user.profileIcon})
    })
  }
  ngAfterViewInit(): void {

    if (this.characters.length > 0) this.selectedCharacter = this.characters[0];
  }

  onCharacterChange(char: Character) {
    this.selectedCharacter = char;
  }


  goToManageCharacters() {
    // Logic to open your character management popover or navigate to a page
    console.log('Navigating to Character Management');
    // this.router.navigate(['/characters']);
  }

  selectServer(server: any) {
    this.selectedServer = server;
    console.log('Switched to server:', server.name);
    // Here you would typically filter characters or channels based on server ID
  }

  goToSettings() {
    console.log('Opening Personal Settings');
    // this.router.navigate(['/settings']);
  }
}

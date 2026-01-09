import {Component} from '@angular/core';
import {MatButtonModule} from '@angular/material/button';
import { UserService} from '../../shared/services/user/user';
import {AuthService} from '../../shared/services/auth/auth';

import {dndbeyond} from '../../shared/services/character/dndbeyond/dndbeyond';
import {CreateCharacterComponent} from '../character/create/create';
import {MatDialog} from '@angular/material/dialog';
import {CharacterService} from '../../shared/services/character/character';
import {SidePanel} from './side-panel/side-panel';

@Component({
  selector: 'app-dashboard',
  imports: [MatButtonModule, SidePanel],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  constructor(private userService: UserService, private authService: AuthService, private dndbeyondService: dndbeyond, public dialog: MatDialog, private characterService: CharacterService) {
  }


  getMe = () =>{
    this.userService.getMe().subscribe(user => {
      console.log(user);
    })
  }

  logout = () => {
    this.authService.logout();
  }


  convertLink = () =>{
    console.log(this.dndbeyondService.getCharacterIdFromLink("https://www.dndbeyond.com/characters/94599937"))
  }

  getdndbeyondInfo=()=>{
    this.dndbeyondService.getSurfaceInformation("94599937").subscribe(data=>{
      console.log(data);
    })
  }

  openAddCharacter() {
    const dialogRef = this.dialog.open(CreateCharacterComponent, {
      width: '600px',
      maxHeight: '90vh',
      data: { mode: 'create' } // You can pass data here
    });

    dialogRef.afterClosed().subscribe(result => {
      console.log('The dialog was closed', result);
      // Refresh list if result is success
    });

  }


  getCharacters(){
    this.characterService.getMyCharacters().subscribe(data=>{
      console.log(data);
    })
  }
}

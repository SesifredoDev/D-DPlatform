import {Component, Input, OnChanges, OnInit, SimpleChanges} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {ICharacter} from '../../../shared/models/user/character.model';
import {CommonModule, KeyValuePipe, TitleCasePipe} from '@angular/common';
import {MatCardModule} from '@angular/material/card';
import {MatTabsModule} from '@angular/material/tabs';
import { PdfViewerModule } from 'ng2-pdf-viewer';
import {MatIconButton} from '@angular/material/button';
@Component({
  selector: 'app-character-viewer',
  templateUrl: './character-viewer.html',
  styleUrls: ['./character-viewer.scss'],
  standalone: true,
  imports: [

    CommonModule,
    TitleCasePipe,
    KeyValuePipe,
    MatCardModule,
    MatTabsModule,

    PdfViewerModule,
    MatIconButton
  ]
})
export class CharacterViewer  implements OnInit, OnChanges{
  @Input() character!: ICharacter | undefined;

  zoom = 1;
  page = 1;
  ddbUrl: SafeResourceUrl ="";
  pdfUrl: string | null | undefined = "";
  constructor(private sanitizer: DomSanitizer) {}
  ngOnInit() {
    if(!this.character)return;
    this.ddbUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.dndbeyond.com/characters/${this.character.ddbId}`
    );

    this.pdfUrl = this.character.pdfLink;
  }
  ngOnChanges(changes: SimpleChanges) {
    if(changes["character"].currentValue) this.ngOnInit();
  }



  get modifier(): (stat: number) => string {
    return (stat: number) => {
      const mod = Math.floor((stat - 10) / 2);
      return mod >= 0 ? `+${mod}` : `${mod}`;
    };
  }
}

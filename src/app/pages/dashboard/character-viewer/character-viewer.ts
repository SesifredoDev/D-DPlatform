import {Component, Input, OnChanges, OnInit, SimpleChanges} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import {ICharacter} from '../../../shared/models/user/character.model';
import {CommonModule, KeyValuePipe, TitleCasePipe} from '@angular/common';
import {MatCardModule} from '@angular/material/card';
import {MatTabsModule} from '@angular/material/tabs';
import { PdfViewerModule } from 'ng2-pdf-viewer';
import {MatIconButton} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatTooltipModule} from '@angular/material/tooltip';
import { FileService } from '../../../shared/services/file/file';

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
    MatIconModule,
    MatTooltipModule,
    PdfViewerModule,
    MatIconButton
  ]
})
export class CharacterViewer implements OnInit, OnChanges {
  @Input() character!: ICharacter | undefined;

  zoom = 1.0;
  page = 1;
  ddbUrl: SafeResourceUrl = "";
  pdfUrl: string | null | undefined = "";

  constructor(
    private sanitizer: DomSanitizer,
    private fileService: FileService,
  ) {}

  ngOnInit() {
    if (!this.character) return;

    if (this.character.ddbId) {
      this.ddbUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.dndbeyond.com/characters/${this.character.ddbId}`
      );
    }

    this.pdfUrl = this.character.pdfLink
      ? this.fileService.resolveFileUrl(this.character.pdfLink)
      : null;
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes["character"] && changes["character"].currentValue) {
      this.ngOnInit();
    }
  }

  modifierValue(stat: number): number {
    return Math.floor((stat - 10) / 2);
  }

  modifier(stat: number): string {
    const mod = this.modifierValue(stat);
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }
}

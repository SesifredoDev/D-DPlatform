import { Component, OnInit } from '@angular/core';
import {FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators} from '@angular/forms';
import {dndbeyond} from '../../../shared/services/character/dndbeyond/dndbeyond';
import {CharacterService} from '../../../shared/services/character/character';
import {CommonModule} from '@angular/common';
import {MatCardModule} from '@angular/material/card';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatButtonModule} from '@angular/material/button';
import {MatInputModule} from '@angular/material/input';
import {MatIconModule} from '@angular/material/icon';
import {MatDividerModule} from '@angular/material/divider';
import {MatDialog, MatDialogModule, MatDialogRef} from '@angular/material/dialog';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatTabsModule} from '@angular/material/tabs';
import {MatTooltipModule} from '@angular/material/tooltip';

@Component({
  selector: 'app-create',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatDialogModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  templateUrl: './create.html',
  styleUrl: './create.scss',
})
export class CreateCharacterComponent implements OnInit {
  charForm: FormGroup;
  selectedIcon: File | null = null;
  selectedPdf: File | null = null;
  isImporting = false;
  isSaving = false;

  constructor(
    private fb: FormBuilder,
    private ddbService: dndbeyond,
    private charService: CharacterService,
    private matDialog: MatDialog,
    private dialogRef: MatDialogRef<CreateCharacterComponent>,
  ) {
    this.charForm = this.fb.group({
      ddbUrl: [''],
      name: ['', Validators.required],
      race: ['', Validators.required],
      ac: [10, [Validators.required, Validators.min(0)]],
      ddbId: [null],
      ddbUsername: [null],
      iconUrl: [''],
      strength: [10], dexterity: [10], constitution: [10],
      intelligence: [10], wisdom: [10], charisma: [10],
      classes: this.fb.array([])
    });
  }

  ngOnInit(): void {}

  get classArray() {
    return this.charForm.get('classes') as FormArray;
  }

  addClass(className = '', subclassName = '', level = 1) {
    const classGroup = this.fb.group({
      className: [className, Validators.required],
      subclassName: [subclassName],
      level: [level, [Validators.required, Validators.min(1)]]
    });
    this.classArray.push(classGroup);
  }

  removeClass(index: number) {
    this.classArray.removeAt(index);
  }

  modifier(stat: number): string {
    const mod = Math.floor((stat - 10) / 2);
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  importFromDdb() {
    const url = this.charForm.get('ddbUrl')?.value;
    const id = this.ddbService.getCharacterIdFromLink(url);

    if (id) {
      this.isImporting = true;
      this.ddbService.getSurfaceInformation(id).subscribe({
        next: (data) => {
          while (this.classArray.length) { this.classArray.removeAt(0); }

          this.charForm.patchValue({
            name: data.name,
            race: data.race,
            ac: data.ac,
            ddbId: data.id,
            ddbUsername: data.username,
            iconUrl: data.icon,
            strength: data.baseStats.strength,
            dexterity: data.baseStats.dexterity,
            constitution: data.baseStats.constitution,
            intelligence: data.baseStats.intelligence,
            wisdom: data.baseStats.wisdom,
            charisma: data.baseStats.charisma,
          });

          data.classes.forEach((c: any) => {
            this.addClass(c.className, c.subclassName, c.level);
          });

          this.isImporting = false;
        },
        error: () => { this.isImporting = false; }
      });
    }
  }

  onFileSelected(event: any, type: 'icon' | 'pdf') {
    const file = event.target.files[0];
    if (type === 'icon') {
      this.selectedIcon = file;
      // Show local preview
      const reader = new FileReader();
      reader.onload = (e: any) => this.charForm.patchValue({ iconUrl: e.target.result });
      reader.readAsDataURL(file);
    }
    if (type === 'pdf') this.selectedPdf = file;
  }

  async submitForm() {
    if (!this.charForm.valid || this.isSaving) {
      return;
    }

    this.isSaving = true;

    try {
      const formVal = this.charForm.value;
      const uploadedIcon = this.selectedIcon
        ? await this.charService.uploadCharacterAsset(this.selectedIcon)
        : null;
      const uploadedPdf = this.selectedPdf
        ? await this.charService.uploadCharacterAsset(this.selectedPdf)
        : null;

      const characterData = {
        name: formVal.name,
        race: formVal.race,
        ac: formVal.ac,
        ddbId: formVal.ddbId,
        ddbUsername: formVal.ddbUsername,
        icon: uploadedIcon?.url || formVal.iconUrl,
        pdfLink: uploadedPdf?.url || null,
        baseStats: {
          strength: formVal.strength,
          dexterity: formVal.dexterity,
          constitution: formVal.constitution,
          intelligence: formVal.intelligence,
          wisdom: formVal.wisdom,
          charisma: formVal.charisma
        },
        classes: formVal.classes
      };

      this.charService.saveCharacter(characterData)
        .subscribe({
          next: (res) => {
            this.charForm.reset();
            this.selectedIcon = null;
            this.selectedPdf = null;
            this.dialogRef.close(res);
          },
          error: (error) => {
            console.error('Failed to save character', error);
            this.isSaving = false;
          },
          complete: () => {
            this.isSaving = false;
          }
        });
    } catch (error) {
      console.error('Failed to upload character assets', error);
      this.isSaving = false;
    }
  }

  close = () => {
    this.dialogRef.close();
  }
}

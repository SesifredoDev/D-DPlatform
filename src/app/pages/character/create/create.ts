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
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatTabsModule} from '@angular/material/tabs';

@Component({
  selector: 'app-create',
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
  ],
  templateUrl: './create.html',
  styleUrl: './create.scss',
})
export class CreateCharacterComponent implements OnInit {
  charForm: FormGroup;
  selectedIcon: File | null = null;
  selectedPdf: File | null = null;
  isImporting = false;

  constructor(
    private fb: FormBuilder,
    private ddbService: dndbeyond,
    private charService: CharacterService,
    private matDialog: MatDialog,
  ) {
    this.charForm = this.fb.group({
      ddbUrl: [''],
      name: ['', Validators.required],
      race: ['', Validators.required],
      ac: [10, [Validators.required, Validators.min(0)]],
      ddbId: [null],
      iconUrl: [''], // Holds the DDB icon URL if no file is uploaded
      // Stats
      strength: [10], dexterity: [10], constitution: [10],
      intelligence: [10], wisdom: [10], charisma: [10],
      classes: this.fb.array([])
    });
  }

  ngOnInit(): void {}

  // Getter for easy access in HTML
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

  importFromDdb() {
    const url = this.charForm.get('ddbUrl')?.value;
    const id = this.ddbService.getCharacterIdFromLink(url);

    if (id) {
      this.isImporting = true;
      this.ddbService.getSurfaceInformation(id).subscribe({
        next: (data) => {
          // Clear existing classes
          while (this.classArray.length) { this.classArray.removeAt(0); }

          // Patch basic info
          this.charForm.patchValue({
            name: data.name,
            race: data.race,
            ac: data.ac,
            ddbId: data.id,
            iconUrl: data.icon,
            strength: data.baseStats.strength,
            dexterity: data.baseStats.dexterity,
            constitution: data.baseStats.constitution,
            intelligence: data.baseStats.intelligence,
            wisdom: data.baseStats.wisdom,
            charisma: data.baseStats.charisma
          });

          // Add classes from DDB
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
    if (type === 'icon') this.selectedIcon = file;
    if (type === 'pdf') this.selectedPdf = file;
  }

  submitForm() {
    if (this.charForm.valid) {
      const formVal = this.charForm.value;

      const characterData = {
        name: formVal.name,
        race: formVal.race,
        ac: formVal.ac,
        ddbId: formVal.ddbId,
        icon: formVal.iconUrl, // This will be used if selectedIcon is null
        baseStats: {
          strength: formVal.strength,
          dexterity: formVal.dexterity,
          constitution: formVal.constitution,
          intelligence: formVal.intelligence,
          wisdom: formVal.wisdom,
          charisma: formVal.charisma
        },
        classes: [] // You can extend the form to handle class arrays similarly
      };

      this.charService.saveCharacter(characterData, this.selectedIcon!, this.selectedPdf!)
        .subscribe(res =>{
          console.log('Character Saved!', res)
          this.charForm.reset();
          this.selectedIcon = null;
          this.selectedPdf = null;
        });
    }
  }

  close=()=>{
    this.charForm.reset();
    this.matDialog.closeAll()
  }
}

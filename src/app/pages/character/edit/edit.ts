import { Component, Inject, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { CharacterService } from '../../../shared/services/character/character';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule, MatIconButton } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { ICharacter } from '../../../shared/models/user/character.model';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-edit',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, MatDialogModule,
    MatFormFieldModule, MatInputModule, MatButtonModule, MatIconButton,
    MatIconModule, MatTabsModule, MatDividerModule, MatTooltipModule
  ],
  templateUrl: './edit.html',
  styleUrl: './edit.scss'
})
export class Edit implements OnInit {
  charForm: FormGroup;
  selectedIcon: File | null = null;
  selectedPdf: File | null = null;
  isSaving = false;

  constructor(
    private fb: FormBuilder,
    private charService: CharacterService,
    private dialogRef: MatDialogRef<Edit>,
    @Inject(MAT_DIALOG_DATA) public data: ICharacter
  ) {
    this.charForm = this.fb.group({
      _id: [data._id],
      name: [data.name, Validators.required],
      race: [data.race, Validators.required],
      ac: [data.ac, [Validators.required, Validators.min(0)]],
      ddbId: [data.ddbId],
      iconUrl: [data.icon],
      strength: [data.baseStats?.strength || 10],
      dexterity: [data.baseStats?.dexterity || 10],
      constitution: [data.baseStats?.constitution || 10],
      intelligence: [data.baseStats?.intelligence || 10],
      wisdom: [data.baseStats?.wisdom || 10],
      charisma: [data.baseStats?.charisma || 10],
      classes: this.fb.array([])
    });
  }

  ngOnInit(): void {
    if (this.data.classes) {
      this.data.classes.forEach(c => this.addClass(c.className, c.subclassName, c.level));
    }
  }

  get classArray() { return this.charForm.get('classes') as FormArray; }

  addClass(className = '', subclassName = '', level = 1) {
    const classGroup = this.fb.group({
      className: [className, Validators.required],
      subclassName: [subclassName],
      level: [level, [Validators.required, Validators.min(1)]]
    });
    this.classArray.push(classGroup);
  }

  removeClass(index: number) { this.classArray.removeAt(index); }

  modifier(stat: number): string {
    const mod = Math.floor((stat - 10) / 2);
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  onFileSelected(event: any, type: 'icon' | 'pdf') {
    const file = event.target.files[0];
    if (!file) return;

    if (type === 'icon') {
      this.selectedIcon = file;
      const reader = new FileReader();
      reader.onload = (e: any) => this.charForm.patchValue({ iconUrl: e.target.result });
      reader.readAsDataURL(file);
    }
    if (type === 'pdf') {
      this.selectedPdf = file;
    }
  }

  submitForm() {
    if (!this.charForm.valid || this.isSaving) {
      return;
    }

    this.isSaving = true;

    const formVal = this.charForm.value;
    const characterUpdate: Partial<ICharacter> = {
      _id: formVal._id,
      name: formVal.name,
      race: formVal.race,
      ac: formVal.ac,
      ddbId: formVal.ddbId,
      icon: this.selectedIcon ? null : formVal.iconUrl,
      pdfLink: this.selectedPdf ? null : this.data.pdfLink || null,
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

    if (!characterUpdate._id) {
      this.isSaving = false;
      return;
    }

    this.charService.updateCharacter(characterUpdate._id, characterUpdate, {
      icon: this.selectedIcon,
      pdf: this.selectedPdf
    }).subscribe({
      next: (res) => {
        this.dialogRef.close(res);
      },
      error: (error) => {
        console.error('Failed to update character', error);
        this.isSaving = false;
      },
      complete: () => {
        this.isSaving = false;
      }
    });
  }

  close() { this.dialogRef.close(); }
}

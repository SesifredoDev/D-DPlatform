import {Component, Inject} from '@angular/core';
import {MAT_DIALOG_DATA, MatDialogModule, MatDialogRef} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatButtonModule} from '@angular/material/button';
import {FormsModule} from '@angular/forms';

@Component({
  selector: 'app-save-map',
  imports: [MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule , FormsModule],
  templateUrl: './save-map.html',
  styleUrl: './save-map.scss',
})
export class SaveMapDialog {
  constructor(
    public dialogRef: MatDialogRef<SaveMapDialog>,
    @Inject(MAT_DIALOG_DATA) public data: { name: string }
  ) {}
  onNoClick(): void { this.dialogRef.close(); }
}

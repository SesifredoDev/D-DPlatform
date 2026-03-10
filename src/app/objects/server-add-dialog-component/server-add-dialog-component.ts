import { Component } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { ServerService } from '../../shared/services/server/server';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { CommonModule } from '@angular/common';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

@Component({
  selector: 'app-server-add-dialog',
  // standalone: true,
  templateUrl: './server-add-dialog-component.html',
  styleUrls: ['./server-add-dialog-component.scss'],
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSnackBarModule,
    MatProgressBarModule
  ]
})
export class ServerAddDialogComponent {

  createForm: FormGroup;
  joinForm: FormGroup;

  selectedFile: File | null = null;
  iconPreview: string | null = null;

  isLoading = false;
  selectedIndex = 0;

  constructor(
    private fb: FormBuilder,
    private serverService: ServerService,
    private dialogRef: MatDialogRef<ServerAddDialogComponent>,
    private snackBar: MatSnackBar
  ) {

    this.createForm = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(3)]]
    });

    this.joinForm = this.fb.group({
      code: ['', [Validators.required]]
    });
  }

  onTabChange(index: number) {
    this.selectedIndex = index;
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;

    if (!input.files?.length) return;

    const file = input.files[0];

    this.selectedFile = file;

    const reader = new FileReader();
    reader.onload = () => {
      this.iconPreview = reader.result as string;
    };

    reader.readAsDataURL(file);
  }

  async onCreate() {

    if (this.createForm.invalid) return;

    this.isLoading = true;

    try {

      await this.serverService.createServer(
        this.createForm.value.name,
        this.selectedFile
      );

      this.snackBar.open('Server created successfully', 'Close', { duration: 2500 });

      this.dialogRef.close(true);

    } catch (err) {

      this.snackBar.open('Failed to create server', 'Close', { duration: 3000 });

    } finally {
      this.isLoading = false;
    }
  }

  async onJoin() {

    if (this.joinForm.invalid) return;

    this.isLoading = true;

    try {

      await this.serverService.joinServer(
        this.joinForm.value.code
      );

      this.snackBar.open('Joined server successfully', 'Close', { duration: 2500 });

      this.dialogRef.close(true);

    } catch (err) {

      this.snackBar.open('Invalid invite code', 'Close', { duration: 3000 });

    } finally {
      this.isLoading = false;
    }
  }

}

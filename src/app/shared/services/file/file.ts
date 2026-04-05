import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FileService {
  private baseUrl = `${environment.apiURL}files`;

  constructor(private http: HttpClient) {}

  async uploadFile(file: File): Promise<{ url: string, name: string, contentType: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/upload`, formData, { withCredentials: true })
    );

    // Assuming the backend returns the file ID or URL
    // Based on files.routes.js, it's fileController.uploadFile
    // We might need to construct the full URL if it only returns the ID
    return {
      url: `${this.baseUrl}/${response.fileId || response._id || response.id}`,
      name: file.name,
      contentType: file.type
    };
  }
}

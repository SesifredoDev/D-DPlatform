import { Injectable } from '@angular/core';
import { HttpClient, HttpEventType, HttpEvent } from '@angular/common/http';
import { firstValueFrom, Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

interface UploadedFileResponse {
  id: string;
  filename: string;
  name: string; // Added to match Attachment interface
  contentType: string;
  url: string;
}

@Injectable({ providedIn: 'root' })
export class FileService {
  private baseUrl = `${environment.apiURL}files`;
  private CHUNK_SIZE = 512 * 1024; // 512KB chunks to be extremely safe

  constructor(private http: HttpClient) {}

  // Existing method for direct file upload (can still be used for smaller files)
  async uploadFile(file: File): Promise<UploadedFileResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/upload`, formData, { withCredentials: true })
    );

    return {
      id: response.id,
      filename: response.filename,
      name: response.filename || file.name,
      contentType: response.contentType,
      url: response.url
    };
  }

  async uploadFileInChunks(file: File, onProgress?: (progress: number) => void): Promise<UploadedFileResponse> {
    const fileSize = file.size;
    const numberOfChunks = Math.ceil(fileSize / this.CHUNK_SIZE);
    const fileId = crypto.randomUUID(); // Unique ID for this entire file upload

    for (let i = 0; i < numberOfChunks; i++) {
      const offset = i * this.CHUNK_SIZE;
      const chunk = file.slice(offset, Math.min(offset + this.CHUNK_SIZE, fileSize));

      const formData = new FormData();
      formData.append('fileId', fileId);
      formData.append('chunkIndex', i.toString());
      formData.append('totalChunks', numberOfChunks.toString());
      formData.append('fileName', file.name);
      formData.append('fileType', file.type);
      formData.append('chunk', chunk, file.name); // 'chunk' is the field name the backend expects

      // Send chunk to a new endpoint
      await firstValueFrom(
        this.http.post<any>(`${this.baseUrl}/upload-chunk`, formData, { withCredentials: true })
      );

      if (onProgress) {
        // Approximate progress based on chunks sent
        onProgress(Math.round(((i + 1) / numberOfChunks) * 100));
      }
    }

    // After all chunks are uploaded, finalize the upload on the backend
    const finalResponse = await firstValueFrom(
      this.http.post<any>(
        `${this.baseUrl}/finalize-upload`,
        { fileId, fileName: file.name, fileType: file.type },
        { withCredentials: true }
      )
    );

    return {
      id: finalResponse.id,
      filename: finalResponse.filename,
      name: finalResponse.filename || file.name,
      contentType: finalResponse.contentType,
      url: environment.backendURL+finalResponse.url
    };
  }
}

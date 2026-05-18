import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import type { UploadedFileResponse } from '../../models/file/file.model';
@Injectable({ providedIn: 'root' })
export class FileService {
  private baseUrl = `${environment.apiURL}files`;
  private CHUNK_SIZE = 512 * 1024; // 512KB chunks to be extremely safe
  private DIRECT_UPLOAD_THRESHOLD = 8 * 1024 * 1024; // Keep normal image uploads off the finalize endpoint
  private readonly ASTRAL_CONTENT_TYPE = 'application/vnd.ddplatform.astral';

  constructor(private http: HttpClient) {}

  /**
   * Resolves URLs:
   * 1. If absolute URL (like an external link), return as is.
   * 2. If relative (like /api/files/key), prefix with backend base URL.
   */
  resolveFileUrl(url: string): string {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;
    return new URL(url, environment.backendURL).toString();
  }

  // Direct upload for smaller files
  async uploadFile(file: File): Promise<UploadedFileResponse> {
    console.log(`[FileService] Starting direct upload for: ${file.name} (${file.size} bytes)`);
    const uploadFile = this.withUploadContentType(file);
    const formData = new FormData();
    formData.append('file', uploadFile);

    const response = await firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/upload`, formData, { withCredentials: true })
    );

    console.log(`[FileService] Direct upload complete. Proxy URL: ${response.url}`);
    return {
      id: response.id,
      filename: response.filename,
      name: response.filename || file.name,
      contentType: response.contentType,
      url: this.resolveFileUrl(response.url),
      size: response.size ?? file.size
    };
  }

  // Chunked upload for larger files
  async uploadFileInChunks(file: File, onProgress?: (progress: number) => void): Promise<UploadedFileResponse> {
    if (!this.isAstralFile(file) && file.size <= this.DIRECT_UPLOAD_THRESHOLD) {
      return await this.uploadFile(file);
    }

    console.log(`[FileService] Starting chunked upload for: ${file.name} (${file.size} bytes)`);
    const fileSize = file.size;
    const numberOfChunks = Math.ceil(fileSize / this.CHUNK_SIZE);
    const fileId = crypto.randomUUID();
    const uploadContentType = this.getUploadContentType(file);

    for (let i = 0; i < numberOfChunks; i++) {
      const offset = i * this.CHUNK_SIZE;
      const chunk = file.slice(offset, Math.min(offset + this.CHUNK_SIZE, fileSize));

      const formData = new FormData();
      formData.append('fileId', fileId);
      formData.append('chunkIndex', i.toString());
      formData.append('totalChunks', numberOfChunks.toString());
      formData.append('fileName', file.name);
      formData.append('fileType', uploadContentType);
      formData.append('chunk', chunk, file.name);

      await firstValueFrom(
        this.http.post<any>(`${this.baseUrl}/upload-chunk`, formData, { withCredentials: true })
      );

      if (onProgress) onProgress(Math.round(((i + 1) / numberOfChunks) * 100));
    }

    console.log(`[FileService] Finalizing chunked upload for fileId: ${fileId}`);
    const finalResponse = await firstValueFrom(
      this.http.post<any>(
        `${this.baseUrl}/finalize-upload`,
        { fileId, fileName: file.name, fileType: uploadContentType, fileSize },
        { withCredentials: true }
      )
    );

    console.log(`[FileService] Chunked upload complete. Proxy URL: ${finalResponse.url}`);
    return {
      id: finalResponse.id,
      filename: finalResponse.filename,
      name: finalResponse.filename || file.name,
      contentType: finalResponse.contentType,
      url: this.resolveFileUrl(finalResponse.url),
      size: finalResponse.size ?? file.size
    };
  }

  private withUploadContentType(file: File): File {
    const contentType = this.getUploadContentType(file);
    return contentType === file.type ? file : new File([file], file.name, { type: contentType });
  }

  private getUploadContentType(file: File): string {
    return this.isAstralFile(file)
      ? this.ASTRAL_CONTENT_TYPE
      : file.type || 'application/octet-stream';
  }

  private isAstralFile(file: File): boolean {
    return file.name.toLowerCase().endsWith('.astral');
  }
}

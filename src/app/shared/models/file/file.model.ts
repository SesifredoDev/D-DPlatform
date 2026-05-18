export interface UploadedFileResponse {
  id: string;
  filename: string;
  name: string; // Added to match Attachment interface
  contentType: string;
  url: string;
  size?: number;
}

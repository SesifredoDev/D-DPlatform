import type { Attachment } from '../../message/message.model';

export interface BroadcastData {
  file?: File;
  text?: string;
  htmlContent?: string;
  imageUrl?: string;
  source?: string;
  filename?: string;
  embeddedFiles?: BroadcastEmbeddedFile[];
  preferTextForBroadcast?: boolean;
  composeMode?: boolean;
}

export interface BroadcastEmbeddedFile {
  tokenUrl: string;
  file: File;
}

export interface UploadedBroadcastAsset {
  url: string;
  filename: string;
  contentType: string;
}

export interface BroadcastProcessingContext {
  standaloneImageForCallVtt?: string;
  embeddedImageForVtt?: string;
  textForCall?: string;
  attachments: Attachment[];
  embeddedFileMap: Map<string, File>;
  uploadedEmbeddedFiles: Map<string, UploadedBroadcastAsset>;
  uploadedBlobImageIndex: number;
}

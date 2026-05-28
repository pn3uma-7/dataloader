export interface ActiveUpload {
  uploadId: string;
  filename: string;
  startedAt: Date;
  startedBy: string;
  phase: 'uploading' | 'saving' | 'done' | 'error';
  bytesUploaded: number;
  totalBytes: number;
  skippedRows?: number;
}

export const activeUploads = new Map<string, ActiveUpload>();

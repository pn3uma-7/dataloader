export type ColumnType = 'VARCHAR' | 'INTEGER' | 'NUMERIC' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'JSONB';

export interface Column {
  name: string;
  type: ColumnType;
  primary_key: boolean;
  nullable: boolean;
}

export interface Upload {
  upload_id: number | string | null;
  filename: string;
  s3_key: string | null;
  uploaded_by: string;
  uploaded_at: string;
  size_bytes: number;
  skipped_rows?: number;
  status?: 'in_progress';
}

export interface S3File {
  key: string;
  filename: string;
  size_bytes: number;
  last_modified: string;
}

export interface UploadResponse {
  upload_id: number;
  s3_key: string;
  filename: string;
  size_bytes: number;
  skipped_rows?: number;
}

export interface InjectResponse {
  status: 'success' | 'error';
  table_name?: string;
  row_count?: number;
  inject_id?: number;
  duration_ms?: number;
  code?: string;
  message?: string;
}

export interface InjectHistoryEntry {
  inject_id: number | string;
  table_name: string;
  status: 'success' | 'failed' | 'in_progress';
  row_count: number | null;
  injected_by: string;
  injected_at: string;
  progress?: {
    phase: string;
    bytesStreamed: number;
    totalBytes: number;
  };
}

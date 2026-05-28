export interface ActiveJob {
  jobId: string;
  tableName: string;
  startedAt: Date;
  startedBy: string;
  phase: string;
  bytesStreamed: number;
  totalBytes: number;
  columnCount: number;
}

export const activeJobs = new Map<string, ActiveJob>();

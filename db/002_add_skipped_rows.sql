-- Migration 002 — add skipped_rows to upload_log
-- Run against dataloader_dev and dataloader_qa before first deploy.
-- Safe to re-run (IF NOT EXISTS check via DO block).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'upload_log' AND column_name = 'skipped_rows'
  ) THEN
    ALTER TABLE upload_log ADD COLUMN skipped_rows INTEGER DEFAULT 0;
  END IF;
END
$$;

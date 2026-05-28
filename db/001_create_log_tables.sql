-- Run this once against your RDS PostgreSQL instance before starting the backend.
-- Connect via psql or any SQL client, then execute this file.

CREATE TABLE IF NOT EXISTS upload_log (
  id           SERIAL PRIMARY KEY,
  s3_key       TEXT        NOT NULL,
  filename     TEXT        NOT NULL,
  uploaded_by  TEXT        NOT NULL,           -- Cognito email from JWT claim
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  size_bytes   BIGINT
);

CREATE TABLE IF NOT EXISTS inject_log (
  id           SERIAL PRIMARY KEY,
  upload_id    INTEGER     REFERENCES upload_log(id),
  table_name   TEXT        NOT NULL,
  schema_json  JSONB       NOT NULL,           -- full column definitions as sent to /api/inject
  status       TEXT        NOT NULL CHECK (status IN ('success', 'failed')),
  error_msg    TEXT,
  row_count    INTEGER,
  duration_ms  INTEGER,
  injected_by  TEXT        NOT NULL,           -- Cognito email
  injected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

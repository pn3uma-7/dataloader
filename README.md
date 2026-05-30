# DataLoader

Internal web application for loading CSV files into RDS PostgreSQL tables — without SSH, scripts, or direct database access.

**Replaces:** SSH → Bastion → S3 upload → shell script → RDS  
**Replaced with:** Browser → upload CSV → preview → inject → done

---

## What it does

| Stage | What happens |
|---|---|
| **Upload** | Drag & drop a CSV → client-side validation → trimmed file uploaded to private S3 |
| **Preview** | Scans the S3 file, validates column types, shows row count and any type errors |
| **Inject** | Creates a new PostgreSQL table and streams the S3 file directly into it |
| **History** | Unified log of all uploads and injects with live progress for in-flight operations |

## Data flow

**Upload:**
```
Browser RAM
  → buildTrimmedCsv()     re-parse + trim all values in browser (delay before progress bar)
  → HTTP POST             file sent to backend
  → EC2 RAM (multer)      held in memory — never written to EC2 disk
  → S3                    streamed from EC2 RAM to private S3 bucket
  → RDS                   upload_log entry written
```

**Inject:**
```
S3
  → EC2 RAM (streaming)   S3 file streamed through — never stored on EC2 disk
  → RDS                   streamed directly via COPY FROM STDIN (pg-copy-streams)
```

The file is **never written to EC2 disk** at any stage. During upload it lives briefly in EC2 RAM (~500 MB RAM needed for a 500 MB file — fits within t3.micro's 1 GB). During inject it is pure streaming with minimal memory footprint.

The delay between clicking "Upload to S3" and the progress bar appearing is client-side trim processing (Papa Parse re-parsing the file in the browser), not a network or server delay. Once the progress bar appears, the file is at the backend and you can safely close the tab — the upload continues on the server.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS, Papa Parse, AWS Amplify v6 |
| Backend | Node.js 20, Express, TypeScript |
| Auth | AWS Cognito (Hosted UI, PKCE) — JWT validated via JWKS in Express |
| Storage | AWS S3 (private bucket, backend proxy only) |
| Database | AWS RDS PostgreSQL |
| Progress | Server-Sent Events (SSE) for upload and inject |
| Deployment | Docker Compose — nginx (frontend + `/api` proxy) + Node backend |
| CDN / HTTPS | AWS CloudFront (required for Cognito PKCE callback URLs) |

---

## Local development

### Prerequisites
- Node.js 20
- AWS account with S3 bucket, RDS PostgreSQL, Cognito User Pool

### Setup

```bash
# Install dependencies
cd backend && npm install
cd ../frontend && npm install

# Configure backend
cp backend/.env.example backend/.env
# Fill in: AWS_REGION, S3_BUCKET, COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID,
#          DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

# Configure frontend
cp frontend/.env.local.example frontend/.env.local
# Fill in: VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_APP_CLIENT_ID, VITE_COGNITO_DOMAIN
```

### Run DB migrations (once)

```bash
psql -h <rds-host> -U postgres -d postgres -f db/001_create_log_tables.sql
psql -h <rds-host> -U postgres -d postgres -f db/002_add_skipped_rows.sql
```

### Start

```bash
# Terminal 1 — backend (port 3000)
cd backend && npm run dev

# Terminal 2 — frontend (port 5173, proxies /api → localhost:3000)
cd frontend && npm run dev
```

Open `http://localhost:5173` → Cognito login → full app.

> **Cognito callback URL:** Add `http://localhost:5173/` to your App Client's allowed callback and sign-out URLs.

---

## AWS deployment (Docker Compose)

### Infrastructure required per environment

| Resource | Notes |
|---|---|
| EC2 (Amazon Linux 2023, t3.micro) | Public subnet; security group: port 22 + 8080 open |
| IAM role | S3 read/write/list — attach to EC2 |
| S3 bucket | One per environment |
| RDS PostgreSQL | Existing instance; create `dataloader_dev` / `dataloader_qa` databases |
| Cognito User Pool | One pool, one App Client per environment |
| CloudFront | Points to EC2 DNS:8080; required for HTTPS (Cognito mandates it) |

> **CloudFront is mandatory.** Cognito PKCE rejects `http://` callback URLs for non-localhost. Use the free `*.cloudfront.net` domain — no custom domain needed for dev/QA.

### Quick deploy

```bash
# 1. Bootstrap EC2 (installs Docker, Docker Compose, clones repo)
curl -s https://raw.githubusercontent.com/aqilliz-dev/data-uploader-application/master/infra/04-ec2-bootstrap.sh | sudo bash

# 2. Fill env file
cd ~/dataloader
cp .env.dev.example .env.dev
nano .env.dev   # fill in real values

# 3. Start
sudo docker compose --env-file .env.dev -p dataloader-dev up -d --build
```

Access at `https://<cloudfront-domain>/`

### Env file reference

| Variable | Description |
|---|---|
| `AWS_REGION` | e.g. `ap-south-1` |
| `S3_BUCKET` | Name of the private S3 bucket |
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID |
| `COGNITO_APP_CLIENT_ID` | Cognito App Client ID (same for backend + frontend) |
| `DB_HOST` | RDS endpoint |
| `DB_PORT` | `5432` |
| `DB_NAME` | Database name (e.g. `dataloader_dev`) |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `VITE_COGNITO_USER_POOL_ID` | Same as `COGNITO_USER_POOL_ID` |
| `VITE_COGNITO_APP_CLIENT_ID` | Same as `COGNITO_APP_CLIENT_ID` |
| `VITE_COGNITO_DOMAIN` | Cognito Hosted UI domain |
| `APP_PORT` | Host port nginx binds to (e.g. `8080` for dev, `8081` for QA) |

---

## Infra setup scripts

All scripts are in `infra/`:

| Script | Purpose |
|---|---|
| `01-cognito-setup.sh` | Creates User Pool, Hosted UI domain, App Clients, groups |
| `02-cognito-add-user.sh` | Adds a user and assigns to `data-loader-dev` or `data-loader-business` |
| `03-iam-policy.json` | IAM policy for EC2 role (S3 access) |
| `04-ec2-bootstrap.sh` | EC2 bootstrap — installs Docker, clones repo |

---

## User groups

| Group | Permissions |
|---|---|
| `data-loader-dev` | Upload, inject any table name, view all history, browse all S3 files |
| `data-loader-business` | Upload, inject (table name must start with `biz_`), view own history only |

---

## CSV requirements

- **First column** — hashed ID: must be SHA-256 (64-char hex) or UUID (if column name contains "device")
- **Other columns** — any value allowed except `,` `"` and newlines (these break CSV structure)
- **Leading/trailing whitespace** — auto-trimmed before S3 upload
- **Blank cells, null-like values, duplicate rows** — flagged as errors at upload

---

## Database schema

```sql
-- Tracks every CSV uploaded to S3
CREATE TABLE upload_log (
  id           SERIAL PRIMARY KEY,
  s3_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ DEFAULT now(),
  size_bytes   BIGINT,
  skipped_rows INTEGER DEFAULT 0
);

-- Tracks every inject into RDS
CREATE TABLE inject_log (
  id           SERIAL PRIMARY KEY,
  upload_id    INTEGER REFERENCES upload_log(id),  -- nullable for S3-direct injects
  table_name   TEXT NOT NULL,
  schema_json  JSONB NOT NULL,
  status       TEXT CHECK (status IN ('success', 'failed')),
  error_msg    TEXT,
  row_count    INTEGER,
  duration_ms  INTEGER,
  injected_by  TEXT NOT NULL,
  injected_at  TIMESTAMPTZ DEFAULT now()
);
```

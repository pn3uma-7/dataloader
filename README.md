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
| Deployment | Docker — single container; Express serves frontend static files + API |
| CDN / HTTPS | AWS CloudFront (required for Cognito PKCE callback URLs) |

---

## Ways to run

The app supports four modes — no code changes needed between them, driven entirely by environment variables.

| Mode | How | When to use |
|---|---|---|
| **npm local dev** | Two terminals: `npm run dev` in backend + frontend | Day-to-day development |
| **Local Docker** | `docker compose --env-file .env.dev up --build` on laptop | Testing the Docker setup before deploying to EC2 |
| **EC2 + Docker** | Single `docker run` on EC2, CloudFront in front | Dev / QA / Production |
| **EC2 without Docker** | `npm build` + nginx + PM2 on EC2 | If Docker is unavailable |

> **Mock auth (no Cognito needed):** If `COGNITO_USER_POOL_ID` is not set **and** `NODE_ENV=development`, the backend injects a mock `data-loader-dev` user automatically. S3 and RDS are still required.

---

## Local development (npm)

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

## Local Docker

Useful for testing the container setup before pushing to EC2. Requires Docker Desktop.

```bash
cp .env.dev.example .env.dev   # fill in real AWS values
docker compose --env-file .env.dev -p dataloader-dev up --build
```

App runs at `http://localhost:8080`. Containers connect to real AWS (S3, RDS, Cognito).

> **Cognito callback URL:** Add `http://localhost:8080/` to your App Client's allowed callback and sign-out URLs.

---

## AWS deployment (Docker — single container)

### Architecture

```
Browser → CloudFront → EC2:3000 → Express (serves React SPA + /api/*)
                                         ↓              ↓
                                       S3 (data)    RDS PostgreSQL
```

The React frontend and Express API are bundled into one Docker image. Express serves the React build from `/public` and handles all `/api/*` routes. No nginx, no separate frontend bucket.

### Infrastructure required

| Resource | Notes |
|---|---|
| EC2 (Amazon Linux 2023, t3.micro) | Public subnet; security group: port 22 + 3000 inbound |
| IAM role | S3 read/write/list — attach to EC2 instance |
| S3 bucket | One private bucket for CSV data |
| RDS PostgreSQL | Security group must allow port 5432 from EC2 |
| Cognito User Pool | One pool + App Client; callback URLs must include CloudFront domain |
| CloudFront | Single origin: EC2 DNS on port 3000; required for HTTPS (Cognito mandates it) |

> **CloudFront is mandatory.** Cognito PKCE rejects `http://` callback URLs for non-localhost.

### First-time EC2 setup

```bash
# 1. Bootstrap EC2 (installs Docker + git, clones repo)
curl -s https://raw.githubusercontent.com/pn3uma-7/dataloader/master/infra/04-ec2-bootstrap.sh | sudo bash

# Re-login so docker group takes effect
exit  # then SSH back in

# 2. Create .env with real values (only needed once — not in git)
cd ~/dataloader
cat > backend/.env << 'EOF'
AWS_REGION=ap-south-1
S3_BUCKET=<your-bucket>
COGNITO_USER_POOL_ID=<pool-id>
COGNITO_APP_CLIENT_ID=<client-id>
DB_HOST=<rds-endpoint>
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<password>
PORT=3000
NODE_ENV=production
EOF

# 3. Build and start
docker build -t dataloader-backend -f backend/Dockerfile .
docker run -d --name dataloader --restart unless-stopped \
  -p 3000:3000 --env-file ./backend/.env dataloader-backend
```

### Redeploy after a code push

```bash
cd ~/dataloader && git pull && \
docker build -t dataloader-backend -f backend/Dockerfile . && \
(docker stop dataloader && docker rm dataloader; true) && \
docker run -d --name dataloader --restart unless-stopped \
  -p 3000:3000 --env-file ./backend/.env dataloader-backend && \
docker logs dataloader --tail 20
```

### .env reference

| Variable | Description |
|---|---|
| `AWS_REGION` | e.g. `ap-south-1` |
| `S3_BUCKET` | Name of the private S3 data bucket |
| `COGNITO_USER_POOL_ID` | Cognito User Pool ID |
| `COGNITO_APP_CLIENT_ID` | Cognito App Client ID |
| `DB_HOST` | RDS endpoint |
| `DB_PORT` | `5432` |
| `DB_NAME` | Database name |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `PORT` | `3000` |
| `NODE_ENV` | `production` |

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
- **Blank/empty cells** (`,, ` or `, ,`) — flagged as errors at upload
- **Null-like programming values** — `null`, `none`, `nan`, `nil`, `undefined` flagged as errors; `NA`, `N/A`, `Not Applicable` are **allowed**
- **Duplicate rows** — flagged as errors at upload

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

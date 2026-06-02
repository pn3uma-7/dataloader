# DataLoader — Deployment Notes
**Last updated:** 2026-06-02  
**Environment:** Personal AWS (pn3uma account) — ap-south-1  
**Status:** Running and verified end-to-end

---

## Current live setup

| Resource | Value |
|---|---|
| CloudFront domain | `d2dae177d6cpkj.cloudfront.net` |
| CloudFront distribution ID | `E2PO4X794WAGFR` |
| EC2 public DNS | `ec2-3-110-143-218.ap-south-1.compute.amazonaws.com` |
| EC2 private IP | `172.31.34.51` |
| EC2 instance type | t3.micro — Amazon Linux 2023 |
| S3 data bucket | `dataloader-dev-pn3uma` |
| RDS endpoint | `dataloader-db.cfooo4wegvu1.ap-south-1.rds.amazonaws.com` |
| Docker container name | `dataloader` |
| App port | `3000` (EC2 security group must allow inbound 3000) |

---

## Architecture

```
Browser
  → CloudFront (d2dae177d6cpkj.cloudfront.net)
    → EC2:3000  [single Docker container]
      → Express
          /api/*     → backend routes (upload, inject, history, s3files)
          /*         → React SPA (served from /public inside container)
          ↓
        S3 (dataloader-dev-pn3uma)   — CSV data files
        RDS PostgreSQL               — upload_log + inject_log + injected tables
```

**No nginx. No Docker Compose. No separate frontend S3 bucket.**  
Frontend and backend are bundled in one Docker image. Express serves the React build from `./public`.

---

## Docker image build

Build context is the **project root** (not the `backend/` folder):

```bash
# From ~/dataloader on EC2
docker build -t dataloader-backend -f backend/Dockerfile .
```

The Dockerfile has three stages:
1. **frontend-builder** — `npm ci` + `npm run build` in `frontend/`
2. **backend-builder** — `npm ci` + `tsc` in `backend/`
3. **final** — production node_modules + backend `dist/` + frontend `dist/` as `public/`

---

## .env file (on EC2 — never in git)

Location: `~/dataloader/backend/.env`

```
AWS_REGION=ap-south-1
S3_BUCKET=dataloader-dev-pn3uma
COGNITO_USER_POOL_ID=ap-south-1_1JuBUegOL
COGNITO_APP_CLIENT_ID=41uuvfosmt2l38tu2dh2f8qolr
DB_HOST=dataloader-db.cfooo4wegvu1.ap-south-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=<see password manager>
PORT=3000
NODE_ENV=production
```

This file lives only on the EC2 instance. It is gitignored. Create it once manually after first SSH.

---

## Deploy commands

### First-time setup on a new EC2
```bash
# Install Docker + git, clone repo
curl -s https://raw.githubusercontent.com/pn3uma-7/dataloader/master/infra/04-ec2-bootstrap.sh | sudo bash

# Re-login (docker group)
exit   # then SSH back in

# Create .env (fill in real values)
cat > ~/dataloader/backend/.env << 'EOF'
... (see above)
EOF

# Build and start
cd ~/dataloader
docker build -t dataloader-backend -f backend/Dockerfile .
docker run -d --name dataloader --restart unless-stopped \
  -p 3000:3000 --env-file ./backend/.env dataloader-backend
```

### Redeploy after a code push (one-liner)
```bash
cd ~/dataloader && git pull && docker build -t dataloader-backend -f backend/Dockerfile . && (docker stop dataloader && docker rm dataloader; true) && docker run -d --name dataloader --restart unless-stopped -p 3000:3000 --env-file ./backend/.env dataloader-backend && docker logs dataloader --tail 20
```

### Check container status
```bash
docker ps
docker logs dataloader --tail 50
curl http://localhost:3000/api/health
```

---

## CloudFront configuration

| Setting | Value |
|---|---|
| Origin | EC2 public DNS, port 3000 |
| Origin protocol | HTTP only (CloudFront handles HTTPS termination) |
| Viewer protocol | Redirect HTTP → HTTPS |
| Cache | Disabled for `/api/*` (separate behavior); default TTL for static assets |
| Error pages | 403 + 404 → `/index.html` (required for React Router) |

> **Why CloudFront is required:** Cognito PKCE rejects `http://` callback URLs for non-localhost. CloudFront provides free HTTPS via `*.cloudfront.net` — no custom domain or ACM cert needed.

---

## Cognito callback URLs

The Cognito App Client must have the CloudFront domain in both:
- **Allowed callback URLs:** `https://d2dae177d6cpkj.cloudfront.net/`
- **Allowed sign-out URLs:** `https://d2dae177d6cpkj.cloudfront.net/`

For local dev, also add: `http://localhost:5173/`

---

## Security group rules

**EC2 security group:**
| Port | Source | Purpose |
|---|---|---|
| 22 | Your IP (or 0.0.0.0/0 for EC2 Instance Connect) | SSH |
| 3000 | CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`) | App traffic from CloudFront only |

**RDS security group:**
| Port | Source | Purpose |
|---|---|---|
| 5432 | EC2 security group ID (not IP) | PostgreSQL — use SG reference so it survives EC2 restarts |

> Use the EC2 **security group ID** (not the IP address) as the RDS inbound source. EC2 IPs change on restart; SG references do not.

---

## IAM role (attached to EC2)

Inline policy permissions needed:
```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::dataloader-dev-pn3uma",
    "arn:aws:s3:::dataloader-dev-pn3uma/*"
  ]
}
```

No explicit AWS credentials in `.env` — the IAM role handles it via instance metadata.

---

## Known issues / gotchas

| Issue | Root cause | Fix |
|---|---|---|
| RDS connection hangs (ETIMEDOUT) | EC2 IP changed; RDS SG rule was IP-based | Use SG reference as RDS source (not IP) |
| `docker build` fails — can't find `frontend/` | Wrong build context — used `./backend` | Build context must be project root: `docker build -f backend/Dockerfile .` |
| `.env` file not found on `docker run` | `.env` not in git (gitignored) | Create manually on EC2 after each new instance |
| Progress bar shows 0% then done | `httpUploadProgress` fires once for <5MB files | Fixed: PassThrough stream with chunked writes |
| `NA` / `N/A` flagged as errors | Were in null-like blocklist | Fixed: removed from blocklist; only `null`, `none`, `nan`, `nil`, `undefined` blocked |

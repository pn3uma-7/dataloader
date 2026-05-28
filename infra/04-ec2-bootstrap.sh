#!/bin/bash
# DataLoader — EC2 bootstrap
# Paste this as EC2 User Data when launching the instance,
# OR run it manually after SSH-ing in as ec2-user.
#
# What this does:
#   1. Installs Docker + Docker Compose v2
#   2. Clones the app repo
#   3. Prints next steps
#
# Security group requirements (configure in AWS Console):
#   Inbound:  port 22   (SSH)   — your office / VPN IP only
#             port 8080 (dev)   — your office / VPN IP only
#             port 8081 (QA)    — your office / VPN IP only
#   Outbound: all (default) — needed to reach S3, RDS, Cognito
#
# RDS security group must allow inbound 5432 from this EC2's security group.

set -e

# ── 1. Install Docker ────────────────────────────────────────────────────────
yum update -y
yum install -y docker git
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# ── 2. Install Docker Compose v2 ─────────────────────────────────────────────
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# ── 3. Clone repo ────────────────────────────────────────────────────────────
cd /home/ec2-user
git clone https://github.com/aqilliz-dev/data-uploader-application.git dataloader
chown -R ec2-user:ec2-user dataloader

# ── 4. Print next steps ───────────────────────────────────────────────────────
echo ""
echo "========================================================="
echo "Bootstrap complete. Next steps (as ec2-user):"
echo ""
echo "  cd ~/dataloader"
echo "  cp .env.dev.example .env.dev   # fill in real values"
echo "  cp .env.qa.example  .env.qa    # fill in real values"
echo ""
echo "  # Run DB migrations (once per database)"
echo "  psql -h <rds-host> -U <user> -d dataloader_dev -f db/001_create_log_tables.sql"
echo "  psql -h <rds-host> -U <user> -d dataloader_dev -f db/002_add_skipped_rows.sql"
echo "  psql -h <rds-host> -U <user> -d dataloader_qa  -f db/001_create_log_tables.sql"
echo "  psql -h <rds-host> -U <user> -d dataloader_qa  -f db/002_add_skipped_rows.sql"
echo ""
echo "  # Start both environments"
echo "  docker compose --env-file .env.dev -p dataloader-dev up -d --build"
echo "  docker compose --env-file .env.qa  -p dataloader-qa  up -d --build"
echo ""
echo "  # Access"
echo "  DEV: http://<this-ec2-ip>:8080"
echo "  QA:  http://<this-ec2-ip>:8081"
echo "========================================================="

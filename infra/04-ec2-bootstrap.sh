#!/bin/bash
# DataLoader — EC2 bootstrap (Amazon Linux 2023)
# Run manually after connecting via EC2 Instance Connect.
# Tested: Amazon Linux 2023, t3.micro, ap-south-1, May 2026.
#
# Pre-requisites (done in AWS Console before running this):
#   - EC2 security group: inbound 22 (SSH) + 3000 (app) from 0.0.0.0/0
#   - IAM role with S3 read/write/list + delete attached to EC2
#   - RDS security group: inbound 5432 from EC2 *security group* (not IP)
#   - CloudFront distribution pointing to ec2-<ip>.<region>.compute.amazonaws.com:3000
#   - Cognito callback URLs updated with https://<cloudfront-domain>/

set -e

# ── 1. Install Docker (Amazon Linux 2023 native package) ─────────────────────
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# ── 2. Install Docker Compose v2 (pinned version — latest URL is unreliable) ──
sudo mkdir -p /usr/local/lib/docker/cli-plugins

sudo curl -SL "https://github.com/docker/compose/releases/download/v2.29.0/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# ── 3. Install Docker Buildx (pinned version) ────────────────────────────────
sudo curl -SL "https://github.com/docker/buildx/releases/download/v0.16.2/buildx-v0.16.2.linux-amd64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

# ── 4. Clone repo ────────────────────────────────────────────────────────────
cd /home/ec2-user
git clone https://github.com/pn3uma-7/dataloader.git dataloader
sudo chown -R ec2-user:ec2-user dataloader

# ── 5. Print next steps ───────────────────────────────────────────────────────
echo ""
echo "========================================================="
echo "Bootstrap complete. Next steps (as ec2-user):"
echo ""
echo "  cd ~/dataloader"
echo ""
echo "  # Create backend/.env with real values (see infra/05-deployment-notes.md)"
echo "  nano backend/.env"
echo ""
echo "  # Build Docker image (build context = project root)"
echo "  docker build -t dataloader-backend -f backend/Dockerfile ."
echo ""
echo "  # Start container"
echo "  docker run -d --name dataloader --restart unless-stopped \\"
echo "    -p 3000:3000 --env-file ./backend/.env dataloader-backend"
echo ""
echo "  # Verify"
echo "  docker logs dataloader --tail 20"
echo "  curl http://localhost:3000/api/health"
echo ""
echo "  # Access via CloudFront HTTPS domain (required for Cognito)"
echo "  https://<cloudfront-domain>/"
echo "========================================================="

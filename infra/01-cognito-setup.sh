#!/bin/bash
# DataLoader — Cognito setup
# Run ONCE. Creates: User Pool, Hosted UI domain, Dev + QA App Clients, Groups.
# Prereq: AWS CLI configured with credentials that have Cognito admin permissions.
#
# BEFORE RUNNING:
#   1. Set REGION to match where your RDS + S3 live
#   2. Set EC2_IP to the Elastic IP of the EC2 that will run the app
#   3. Set DOMAIN_PREFIX to something unique within your AWS account
#
# AFTER RUNNING:
#   Copy the printed values into .env.dev and .env.qa

set -e

REGION="ap-south-1"
EC2_IP="<your-ec2-elastic-ip>"
DOMAIN_PREFIX="dataloader-aqilliz"   # must be globally unique in Cognito

# ── 1. Create User Pool ──────────────────────────────────────────────────────
POOL_ID=$(aws cognito-idp create-user-pool \
  --pool-name "dataloader-pool" \
  --region "$REGION" \
  --policies '{
    "PasswordPolicy": {
      "MinimumLength": 8,
      "RequireUppercase": true,
      "RequireLowercase": true,
      "RequireNumbers": true,
      "RequireSymbols": false
    }
  }' \
  --auto-verified-attributes email \
  --username-attributes email \
  --query 'UserPool.Id' --output text)

echo "Created User Pool: $POOL_ID"

# ── 2. Hosted UI domain ──────────────────────────────────────────────────────
aws cognito-idp create-user-pool-domain \
  --domain "$DOMAIN_PREFIX" \
  --user-pool-id "$POOL_ID" \
  --region "$REGION"

COGNITO_DOMAIN="${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"
echo "Hosted UI domain: $COGNITO_DOMAIN"

# ── 3. App Client — DEV (port 8080) ─────────────────────────────────────────
DEV_CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "dataloader-dev" \
  --region "$REGION" \
  --no-generate-secret \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes email openid profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "http://${EC2_IP}:8080/" \
  --logout-urls  "http://${EC2_IP}:8080/" \
  --supported-identity-providers COGNITO \
  --query 'UserPoolClient.ClientId' --output text)

echo "Dev App Client: $DEV_CLIENT_ID"

# ── 4. App Client — QA (port 8081) ──────────────────────────────────────────
QA_CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "dataloader-qa" \
  --region "$REGION" \
  --no-generate-secret \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes email openid profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "http://${EC2_IP}:8081/" \
  --logout-urls  "http://${EC2_IP}:8081/" \
  --supported-identity-providers COGNITO \
  --query 'UserPoolClient.ClientId' --output text)

echo "QA App Client:  $QA_CLIENT_ID"

# ── 5. Groups ────────────────────────────────────────────────────────────────
aws cognito-idp create-group \
  --group-name data-loader-dev \
  --user-pool-id "$POOL_ID" \
  --region "$REGION"

aws cognito-idp create-group \
  --group-name data-loader-business \
  --user-pool-id "$POOL_ID" \
  --region "$REGION"

echo "Created groups: data-loader-dev, data-loader-business"

# ── Output — copy into .env files ────────────────────────────────────────────
echo ""
echo "========================================================="
echo "Copy these into .env.dev and .env.qa"
echo "========================================================="
echo ""
echo "# Shared (both envs)"
echo "COGNITO_USER_POOL_ID=$POOL_ID"
echo "VITE_COGNITO_USER_POOL_ID=$POOL_ID"
echo "VITE_COGNITO_DOMAIN=$COGNITO_DOMAIN"
echo ""
echo "# DEV (.env.dev)"
echo "COGNITO_APP_CLIENT_ID=$DEV_CLIENT_ID"
echo "VITE_COGNITO_APP_CLIENT_ID=$DEV_CLIENT_ID"
echo ""
echo "# QA (.env.qa)"
echo "COGNITO_APP_CLIENT_ID=$QA_CLIENT_ID"
echo "VITE_COGNITO_APP_CLIENT_ID=$QA_CLIENT_ID"
echo "========================================================="

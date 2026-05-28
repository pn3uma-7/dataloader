#!/bin/bash
# DataLoader — Add a user to Cognito and assign to a group
# Run this for each person who needs access.
#
# Usage:
#   ./02-cognito-add-user.sh <email> <group>
#
# Groups: data-loader-dev | data-loader-business
#
# Example:
#   ./02-cognito-add-user.sh john@aqilliz.com data-loader-dev
#   ./02-cognito-add-user.sh jane@aqilliz.com data-loader-business

set -e

REGION="ap-south-1"
POOL_ID="<your-cognito-pool-id>"   # from 01-cognito-setup.sh output

EMAIL="$1"
GROUP="$2"

if [[ -z "$EMAIL" || -z "$GROUP" ]]; then
  echo "Usage: $0 <email> <group>"
  echo "Groups: data-loader-dev | data-loader-business"
  exit 1
fi

if [[ "$GROUP" != "data-loader-dev" && "$GROUP" != "data-loader-business" ]]; then
  echo "Invalid group. Must be: data-loader-dev or data-loader-business"
  exit 1
fi

# Create user — Cognito sends a temporary password email automatically
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region "$REGION"

# Add to group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --group-name "$GROUP" \
  --region "$REGION"

echo "Created $EMAIL and added to $GROUP"
echo "User will receive a temporary password by email and must change it on first login."

#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0


set -e  # Exit on any error
set -u  # Exit on undefined variables

PRIMARY_REGION="us-east-1"
SECONDARY_REGION="us-west-2"
STACK_NAME="websocket-counter"

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo "Error: AWS CLI not configured. Run 'aws configure' first."
    exit 1
fi

# Check if template file exists
if [[ ! -f "cloudformation/counter-template.yaml" ]]; then
    echo "Error: CloudFormation template not found at cloudformation/counter-template.yaml"
    exit 1
fi

echo "Deploying counter app to primary region: $PRIMARY_REGION"
if ! aws cloudformation deploy \
  --template-file cloudformation/counter-template.yaml \
  --stack-name $STACK_NAME-primary \
  --parameter-overrides \
    PrimaryRegion=$PRIMARY_REGION \
    SecondaryRegion=$SECONDARY_REGION \
    IsPrimary=true \
  --capabilities CAPABILITY_IAM \
  --region $PRIMARY_REGION; then
    echo "Error: Failed to deploy to primary region"
    exit 1
fi

echo "Deploying counter app to secondary region: $SECONDARY_REGION"
if ! aws cloudformation deploy \
  --template-file cloudformation/counter-template.yaml \
  --stack-name $STACK_NAME-secondary \
  --parameter-overrides \
    PrimaryRegion=$PRIMARY_REGION \
    SecondaryRegion=$SECONDARY_REGION \
    IsPrimary=false \
  --capabilities CAPABILITY_IAM \
  --region $SECONDARY_REGION; then
    echo "Error: Failed to deploy to secondary region"
    exit 1
fi

# Get WebSocket URLs
echo "Retrieving WebSocket URLs..."
PRIMARY_URL=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME-primary \
  --region $PRIMARY_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`WebSocketURL`].OutputValue' \
  --output text)

SECONDARY_URL=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME-secondary \
  --region $SECONDARY_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`WebSocketURL`].OutputValue' \
  --output text)

# Deploy health check canary (primary region only)
echo "Deploying health check canary to primary region..."
if ! aws cloudformation deploy \
  --template-file cloudformation/health-check.yaml \
  --stack-name websocket-health-check \
  --parameter-overrides WebSocketUrl=$PRIMARY_URL \
  --capabilities CAPABILITY_IAM \
  --region $PRIMARY_REGION; then
    echo "Error: Failed to deploy health check"
    exit 1
fi

HEALTH_CHECK_ID=$(aws cloudformation describe-stacks \
  --stack-name websocket-health-check \
  --region $PRIMARY_REGION \
  --query 'Stacks[0].Outputs[?OutputKey==`HealthCheckId`].OutputValue' \
  --output text)

echo ""
echo "✅ Deployment complete!"
echo "Primary WebSocket URL: $PRIMARY_URL"
echo "Secondary WebSocket URL: $SECONDARY_URL"
echo "Health Check ID: $HEALTH_CHECK_ID"
echo ""
echo "Attach the Health Check ID to your primary Route 53 failover record."

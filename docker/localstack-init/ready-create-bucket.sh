#!/bin/sh
# Runs inside the LocalStack container on every start (mounted into /etc/localstack/init/ready.d).
# LocalStack keeps buckets in memory only, so the bucket is gone after a container restart — this
# recreates it every time, same as create-queues.sh does for SQS. Public GetObject is set so local
# presigned/proxy GETs behave like a real bucket without needing read credentials (see
# src/utils/s3.ts's AWS_S3_ENDPOINT override).
set -eu

REGION="${DEFAULT_REGION:-ap-southeast-1}"
BUCKET="${AWS_S3_BUCKET:-ilovelawyer-local}"

awslocal s3 mb --region "$REGION" "s3://$BUCKET" 2>/dev/null || true
awslocal s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/*\"
  }]
}"

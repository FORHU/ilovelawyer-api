#!/bin/sh
# Runs inside the LocalStack container on every start (mounted into /etc/localstack/init/ready.d).
# LocalStack keeps queues in memory only, so they're gone after a container restart, and the
# one-shot sqs-init service doesn't run again on its own. Keep the queue list in sync with
# create-queues.sh.
#
# The region has to match the API's (AWS_REGION in .env, and DEFAULT_REGION in docker-compose.yml):
# LocalStack keeps queues per region, and awslocal on its own creates them in us-east-1, where the
# API never looks. That left every queue "missing" after a plain container restart, so the API fell
# back to running jobs in memory, and a job lost to an API restart was never redelivered.
set -eu

REGION="${DEFAULT_REGION:-ap-southeast-1}"

for q in \
  document-extraction \
  citation-extraction \
  audio-overview \
  case-reconstruction-audio \
  ai-generation \
  message-persistence \
  case-graph-promotion
do
  awslocal sqs create-queue --region "$REGION" --queue-name "$q" --output text
done

#!/bin/sh
# Runs inside the LocalStack container on every start (mounted into /etc/localstack/init/ready.d).
# LocalStack keeps queues in memory only, so they're gone after a container restart, and the
# one-shot sqs-init service doesn't run again on its own. Keep the queue list in sync with
# create-queues.sh.
set -eu

for q in \
  document-extraction \
  citation-extraction \
  audio-overview \
  case-reconstruction-audio \
  ai-generation \
  message-persistence \
  case-graph-promotion
do
  # --region: the API's AWS_REGION. Without it awslocal uses us-east-1, and the API — looking in
  # ap-southeast-1 — finds no queues at all (see src/lib/sqs.ts).
  awslocal sqs create-queue --region ap-southeast-1 --queue-name "$q" --output text
done

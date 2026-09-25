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
  awslocal sqs create-queue --queue-name "$q" --output text
done

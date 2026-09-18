#!/bin/sh
set -eu

ENDPOINT="http://localstack:4566"

for q in \
  document-extraction \
  citation-extraction \
  audio-overview \
  case-reconstruction-audio \
  ai-generation \
  message-persistence \
  case-graph-promotion
do
  echo "Creating queue: $q"
  aws --endpoint-url="$ENDPOINT" sqs create-queue --queue-name "$q" --output text
done

echo "All queues ready."

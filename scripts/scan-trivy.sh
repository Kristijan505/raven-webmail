#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "Usage: $0 <image-ref>"
  exit 1
fi

if ! command -v trivy >/dev/null 2>&1; then
  echo "trivy is required: https://trivy.dev/latest/getting-started/installation/"
  exit 1
fi

SEVERITY="${TRIVY_SEVERITY:-HIGH,CRITICAL}"
EXIT_CODE="${TRIVY_EXIT_CODE:-1}"
FORMAT="${TRIVY_FORMAT:-table}"
OUTPUT="${TRIVY_OUTPUT:-}"

CMD=(trivy image --ignore-unfixed --severity "$SEVERITY" --exit-code "$EXIT_CODE" --format "$FORMAT")
if [[ -n "$OUTPUT" ]]; then
  CMD+=(--output "$OUTPUT")
fi
CMD+=("$IMAGE")

"${CMD[@]}"

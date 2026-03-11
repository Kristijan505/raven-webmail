#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "Usage: $0 <image-ref>"
  exit 1
fi

OUT_DIR="${SNAPSHOT_DIR:-release-snapshots}"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${OUT_DIR}/${TS}.txt"

{
  echo "timestamp_utc=${TS}"
  echo "git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo n/a)"
  echo "git_commit=$(git rev-parse HEAD 2>/dev/null || echo n/a)"
  echo "image=${IMAGE}"

  if command -v docker >/dev/null 2>&1; then
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "image_id=$(docker image inspect -f '{{.Id}}' "$IMAGE")"
      echo "image_created=$(docker image inspect -f '{{.Created}}' "$IMAGE")"
      DIGEST="$(docker image inspect -f '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)"
      if [[ -n "$DIGEST" && "$DIGEST" != "<no value>" ]]; then
        echo "image_digest=${DIGEST}"
      fi
    else
      echo "image_present_locally=false"
    fi
  else
    echo "docker_available=false"
  fi

  if [[ -f "deploy/config.toml.example" ]]; then
    echo "config_example_sha256=$(shasum -a 256 deploy/config.toml.example | awk '{print $1}')"
  fi
} > "$OUT_FILE"

echo "$OUT_FILE"

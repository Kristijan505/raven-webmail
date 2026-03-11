#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${RAVEN_BASE_URL:-http://127.0.0.1:8635}"
COOKIE_JAR="$(mktemp)"
LOGIN_BODY="$(mktemp)"

cleanup() {
  rm -f "$COOKIE_JAR" "$LOGIN_BODY"
}
trap cleanup EXIT

echo "> smoke: checking ${BASE_URL}/api/healthz"
HEALTH_JSON="$(curl -fsS "${BASE_URL}/api/healthz")"
printf '%s' "$HEALTH_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(!d || d.ok!==true){console.error("healthz is not ok");process.exit(1);}';

echo "> smoke: checking ${BASE_URL}/api/locale"
LOCALE_JSON="$(curl -fsS "${BASE_URL}/api/locale")"
printf '%s' "$LOCALE_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(typeof d?.lang!=="string"||typeof d?.locale!=="object"||d.locale===null){console.error("invalid locale payload");process.exit(1);}';

if [[ -n "${RAVEN_SMOKE_USER:-}" || -n "${RAVEN_SMOKE_PASS:-}" ]]; then
  if [[ -z "${RAVEN_SMOKE_USER:-}" || -z "${RAVEN_SMOKE_PASS:-}" ]]; then
    echo "RAVEN_SMOKE_USER and RAVEN_SMOKE_PASS must both be set"
    exit 1
  fi

  echo "> smoke: checking login"
  LOGIN_STATUS="$(curl -sS -o "$LOGIN_BODY" -w '%{http_code}' -c "$COOKIE_JAR" \
    -H 'content-type: application/json' \
    --data "{\"username\":\"${RAVEN_SMOKE_USER}\",\"password\":\"${RAVEN_SMOKE_PASS}\"}" \
    "${BASE_URL}/api/login")"

  if [[ "$LOGIN_STATUS" != "200" ]]; then
    echo "login failed, status=${LOGIN_STATUS}"
    cat "$LOGIN_BODY"
    exit 1
  fi

  echo "> smoke: checking authenticated /api/mailboxes"
  MAILBOXES_JSON="$(curl -fsS -b "$COOKIE_JAR" "${BASE_URL}/api/mailboxes")"
  printf '%s' "$MAILBOXES_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(!Array.isArray(d?.results)){console.error("invalid mailboxes payload");process.exit(1);}';

  echo "> smoke: checking authenticated /api/pages/layout"
  LAYOUT_JSON="$(curl -fsS -b "$COOKIE_JAR" "${BASE_URL}/api/pages/layout")"
  printf '%s' "$LAYOUT_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(typeof d?.props!=="object"||d.props==null||typeof d.props.user!=="object"||!Array.isArray(d.props.mailboxes)){console.error("invalid layout payload");process.exit(1);}';

  FIRST_MAILBOX_ID="$(printf '%s' "$MAILBOXES_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));const b=(d?.results||[])[0]||null;const id=String(b?.id||b?._id||"");if(id)process.stdout.write(id);')"
  if [[ -n "$FIRST_MAILBOX_ID" ]]; then
    echo "> smoke: checking authenticated /api/mailboxes/${FIRST_MAILBOX_ID}/messages?limit=1"
    MESSAGES_JSON="$(curl -fsS -b "$COOKIE_JAR" "${BASE_URL}/api/mailboxes/${FIRST_MAILBOX_ID}/messages?limit=1")"
    printf '%s' "$MESSAGES_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(!Array.isArray(d?.results)){console.error("invalid messages payload");process.exit(1);}';

    FIRST_MESSAGE_ID="$(printf '%s' "$MESSAGES_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));const m=(d?.results||[])[0]||null;const id=String(m?.id||m?._id||"");if(id)process.stdout.write(id);')"
    if [[ -n "$FIRST_MESSAGE_ID" ]]; then
      echo "> smoke: checking authenticated /api/mailboxes/${FIRST_MAILBOX_ID}/messages/${FIRST_MESSAGE_ID}"
      MESSAGE_JSON="$(curl -fsS -b "$COOKIE_JAR" "${BASE_URL}/api/mailboxes/${FIRST_MAILBOX_ID}/messages/${FIRST_MESSAGE_ID}")"
      printf '%s' "$MESSAGE_JSON" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(typeof d!=="object"||d==null){console.error("invalid message payload");process.exit(1);}';
    fi
  fi

  echo "> smoke: checking logout"
  curl -fsS -b "$COOKIE_JAR" -H 'content-type: application/json' -X POST "${BASE_URL}/api/logout" >/dev/null
fi

echo "> smoke: OK"

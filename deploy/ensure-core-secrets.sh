#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no esta instal lat." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-}"
FIREBASE_API_KEY="${FIREBASE_API_KEY:-}"
SESSION_SECRET_VALUE="${SESSION_SECRET_VALUE:-}"
WORKER_TICK_TOKEN_VALUE="${WORKER_TICK_TOKEN_VALUE:-}"
META_APP_ID_VALUE="${META_APP_ID_VALUE:-}"
META_APP_SECRET_VALUE="${META_APP_SECRET_VALUE:-}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Cal PROJECT_ID" >&2
  exit 1
fi
if [[ -z "${FIREBASE_API_KEY}" ]]; then
  echo "Cal FIREBASE_API_KEY" >&2
  exit 1
fi

if [[ -z "${SESSION_SECRET_VALUE}" ]]; then
  SESSION_SECRET_VALUE="$(openssl rand -hex 32)"
fi
if [[ -z "${WORKER_TICK_TOKEN_VALUE}" ]]; then
  WORKER_TICK_TOKEN_VALUE="$(openssl rand -hex 32)"
fi

gcloud config set project "${PROJECT_ID}" >/dev/null

upsert_secret() {
  local key="$1"
  local value="$2"
  if ! gcloud secrets describe "${key}" >/dev/null 2>&1; then
    gcloud secrets create "${key}" --replication-policy="automatic" >/dev/null
  fi
  printf "%s" "${value}" | gcloud secrets versions add "${key}" --data-file=- >/dev/null
  echo "[secret] ${PROJECT_ID}: ${key} actualitzat"
}

upsert_secret "FIREBASE_API_KEY" "${FIREBASE_API_KEY}"
upsert_secret "SESSION_SECRET" "${SESSION_SECRET_VALUE}"
upsert_secret "WORKER_TICK_TOKEN" "${WORKER_TICK_TOKEN_VALUE}"
if [[ -n "${META_APP_ID_VALUE}" ]]; then
  upsert_secret "META_APP_ID" "${META_APP_ID_VALUE}"
fi
if [[ -n "${META_APP_SECRET_VALUE}" ]]; then
  upsert_secret "META_APP_SECRET" "${META_APP_SECRET_VALUE}"
fi

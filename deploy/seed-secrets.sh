#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no està instal·lat." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-}"
ENV_FILE="${ENV_FILE:-.env}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Cal PROJECT_ID." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "No existeix ${ENV_FILE}" >&2
  exit 1
fi

gcloud config set project "${PROJECT_ID}" >/dev/null

secrets=(
  FIREBASE_API_KEY
  SESSION_SECRET
  WORKER_TICK_TOKEN
  GEMINI_API_KEY
  META_APP_ID
  META_APP_SECRET
  FACEBOOK_PAGE_ID
  FACEBOOK_PAGE_ACCESS_TOKEN
  INSTAGRAM_BUSINESS_ACCOUNT_ID
  INSTAGRAM_ACCESS_TOKEN
  INSTAGRAM_DEFAULT_IMAGE_URL
  WHATSAPP_PHONE_NUMBER_ID
  WHATSAPP_ACCESS_TOKEN
  WHATSAPP_RECIPIENTS
)

for key in "${secrets[@]}"; do
  value="$(grep -E "^${key}=" "${ENV_FILE}" | sed "s/^${key}=//" || true)"
  if [[ -z "${value}" ]]; then
    echo "[skip] ${key} buit"
    continue
  fi

  if ! gcloud secrets describe "${key}" >/dev/null 2>&1; then
    gcloud secrets create "${key}" --replication-policy="automatic" >/dev/null
    echo "[create] ${key}"
  fi

  printf "%s" "${value}" | gcloud secrets versions add "${key}" --data-file=- >/dev/null
  echo "[version] ${key}"
done

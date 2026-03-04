#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no esta instal lat." >&2
  exit 1
fi

REGION="${REGION:-europe-west1}"
PROJECT_IDS_CSV="${PROJECT_IDS_CSV:-summa-publica-dev-260304,summa-publica-stg-260304,summa-publica-260304-799}"
META_APP_ID_VALUE="${META_APP_ID_VALUE:-}"
META_APP_SECRET_VALUE="${META_APP_SECRET_VALUE:-}"

if [[ -z "${META_APP_ID_VALUE}" ]]; then
  read -r -p "Introdueix META_APP_ID: " META_APP_ID_VALUE
fi
if [[ -z "${META_APP_SECRET_VALUE}" ]]; then
  read -r -s -p "Introdueix META_APP_SECRET (no es mostra): " META_APP_SECRET_VALUE
  echo
fi

if [[ -z "${META_APP_ID_VALUE}" || -z "${META_APP_SECRET_VALUE}" ]]; then
  echo "Cal META_APP_ID i META_APP_SECRET." >&2
  exit 1
fi

IFS=',' read -r -a PROJECT_IDS <<< "${PROJECT_IDS_CSV}"
if [[ ${#PROJECT_IDS[@]} -eq 0 ]]; then
  echo "PROJECT_IDS_CSV buit." >&2
  exit 1
fi

upsert_secret() {
  local project_id="$1"
  local key="$2"
  local value="$3"

  if ! gcloud secrets describe "${key}" --project "${project_id}" >/dev/null 2>&1; then
    gcloud secrets create "${key}" --project "${project_id}" --replication-policy="automatic" >/dev/null
    echo "[${project_id}] creat secret ${key}"
  fi

  printf "%s" "${value}" | gcloud secrets versions add "${key}" --project "${project_id}" --data-file=- >/dev/null
  echo "[${project_id}] nova versio ${key}"
}

update_runtime_service() {
  local project_id="$1"
  local service_name="$2"

  gcloud run services update "${service_name}" \
    --project "${project_id}" \
    --region "${REGION}" \
    --update-secrets "META_APP_ID=META_APP_ID:latest,META_APP_SECRET=META_APP_SECRET:latest" >/dev/null

  echo "[${project_id}] ${service_name} actualitzat"
}

for project_id in "${PROJECT_IDS[@]}"; do
  clean_project_id="$(echo "${project_id}" | xargs)"
  if [[ -z "${clean_project_id}" ]]; then
    continue
  fi

  echo "=== ${clean_project_id} ==="
  upsert_secret "${clean_project_id}" "META_APP_ID" "${META_APP_ID_VALUE}"
  upsert_secret "${clean_project_id}" "META_APP_SECRET" "${META_APP_SECRET_VALUE}"

  update_runtime_service "${clean_project_id}" "summa-publica-api"
  update_runtime_service "${clean_project_id}" "summa-publica-worker"
done

echo "OK: META_APP_ID i META_APP_SECRET actualitzats i aplicats als serveis."

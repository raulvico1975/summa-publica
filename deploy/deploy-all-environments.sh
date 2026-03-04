#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STACK_SCRIPT="${ROOT_DIR}/deploy/deploy-cloudrun-stack.sh"
ENV_DIR="${ROOT_DIR}/deploy/environments"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-https://summapublica.app}"
REGION_DEFAULT="${REGION:-europe-west1}"

if [[ ! -x "${STACK_SCRIPT}" ]]; then
  echo "No trobo ${STACK_SCRIPT}" >&2
  exit 1
fi

for env_name in dev staging prod; do
  env_file="${ENV_DIR}/${env_name}.env"
  if [[ ! -f "${env_file}" ]]; then
    echo "Falta ${env_file}" >&2
    exit 1
  fi

  project_id="$(grep '^PROJECT_ID=' "${env_file}" | cut -d= -f2-)"
  region="$(grep '^REGION=' "${env_file}" | cut -d= -f2-)"
  if [[ -z "${region}" ]]; then
    region="${REGION_DEFAULT}"
  fi

  echo ""
  echo "[DEPLOY:${env_name}] PROJECT_ID=${project_id} REGION=${region}"
  PROJECT_ID="${project_id}" \
  REGION="${region}" \
  APP_PUBLIC_URL="${APP_PUBLIC_URL}" \
  API_SERVICE_NAME="summa-publica-api" \
  WORKER_SERVICE_NAME="summa-publica-worker" \
  "${STACK_SCRIPT}"
done

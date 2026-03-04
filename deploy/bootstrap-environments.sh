#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_SCRIPT="${ROOT_DIR}/deploy/bootstrap-separate-project.sh"
OUT_DIR="${ROOT_DIR}/deploy/environments"

if [[ ! -x "${BOOTSTRAP_SCRIPT}" ]]; then
  echo "No trobo ${BOOTSTRAP_SCRIPT}" >&2
  exit 1
fi

BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-eur3}"
REGION="${REGION:-europe-west1}"
SUFFIX="${SUFFIX:-$(date +%y%m%d)}"
DEPLOY_FIRESTORE_RULES="${DEPLOY_FIRESTORE_RULES:-true}"

if [[ -z "${BILLING_ACCOUNT_ID}" ]]; then
  echo "Cal BILLING_ACCOUNT_ID per crear projectes separats." >&2
  exit 1
fi

DEV_PROJECT_ID="${DEV_PROJECT_ID:-summa-publica-dev-${SUFFIX}}"
STAGING_PROJECT_ID="${STAGING_PROJECT_ID:-summa-publica-stg-${SUFFIX}}"
PROD_PROJECT_ID="${PROD_PROJECT_ID:-summa-publica-prod-${SUFFIX}}"

run_env() {
  local env_name="$1"
  local project_id="$2"
  local project_name="$3"
  local output_file="${OUT_DIR}/${env_name}.env"

  echo ""
  echo "[ENV:${env_name}] Bootstrap projecte ${project_id}"
  PROJECT_ID="${project_id}" \
  PROJECT_NAME="${project_name}" \
  BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID}" \
  FIRESTORE_LOCATION="${FIRESTORE_LOCATION}" \
  REGION="${REGION}" \
  API_KEY_DISPLAY_NAME="summa-publica-${env_name}-web-key" \
  OUTPUT_ENV_FILE="${output_file}" \
  "${BOOTSTRAP_SCRIPT}"

  if [[ "${DEPLOY_FIRESTORE_RULES}" == "true" ]]; then
    echo "[ENV:${env_name}] Publicant regles Firestore"
    firebase deploy --only firestore:rules --project "${project_id}" --config "${ROOT_DIR}/firebase.json"
  fi
}

mkdir -p "${OUT_DIR}"
run_env "dev" "${DEV_PROJECT_ID}" "Summa Publica DEV"
run_env "staging" "${STAGING_PROJECT_ID}" "Summa Publica STAGING"
run_env "prod" "${PROD_PROJECT_ID}" "Summa Publica PROD"

cat <<EOF_SUMMARY

Bootstrap complet.
Fitxers d'entorn generats:
- ${OUT_DIR}/dev.env
- ${OUT_DIR}/staging.env
- ${OUT_DIR}/prod.env

Revisa els IDs/projectes i usa'ls als scripts de deploy per entorn.
EOF_SUMMARY

#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no esta instal lat." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-}"
PROJECT_NAME="${PROJECT_NAME:-Summa Publica}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-eur3}"
REGION="${REGION:-europe-west1}"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"
API_KEY_DISPLAY_NAME="${API_KEY_DISPLAY_NAME:-summa-publica-web-key}"
OUTPUT_ENV_FILE="${OUTPUT_ENV_FILE:-}"

if [[ -z "${PROJECT_ID}" ]]; then
  PROJECT_ID="summa-publica-$(date +%y%m%d)-$((RANDOM % 900 + 100))"
fi

echo "[BOOTSTRAP] Projecte objectiu: ${PROJECT_ID}"

if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "[BOOTSTRAP] Projecte ja existent: ${PROJECT_ID}"
else
  echo "[BOOTSTRAP] Creant projecte..."
  gcloud projects create "${PROJECT_ID}" --name="${PROJECT_NAME}" >/dev/null
fi

gcloud config set project "${PROJECT_ID}" >/dev/null

if [[ -n "${BILLING_ACCOUNT_ID}" ]]; then
  echo "[BOOTSTRAP] Enllacant billing account ${BILLING_ACCOUNT_ID}"
  if ! gcloud beta billing projects link "${PROJECT_ID}" --billing-account "${BILLING_ACCOUNT_ID}" >/dev/null 2>&1; then
    echo "[BOOTSTRAP] No s ha pogut enllacar billing (pot estar ja enllacat o quota temporal). Es continua."
  fi
else
  echo "[BOOTSTRAP] BILLING_ACCOUNT_ID no informat. Si aquest projecte no te billing, algun pas pot fallar."
fi

echo "[BOOTSTRAP] Activant APIs"
gcloud services enable \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  apikeys.googleapis.com >/dev/null

echo "[BOOTSTRAP] Afegint Firebase al projecte"
if ! gcloud firebase projects:addfirebase "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "[BOOTSTRAP] Firebase ja habilitat o no cal repetir."
fi

echo "[BOOTSTRAP] Creant Firestore Native (${FIRESTORE_LOCATION}) si no existeix"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' --location="${FIRESTORE_LOCATION}" --type=firestore-native >/dev/null
else
  echo "[BOOTSTRAP] Firestore (default) ja existeix."
fi

echo "[BOOTSTRAP] Resolent API key Firebase Auth"
API_KEY=""
existing_key_name="$(gcloud services api-keys list --format='value(name,displayName)' | awk -v n="${API_KEY_DISPLAY_NAME}" '$2==n {print $1; exit}')"
if [[ -n "${existing_key_name}" ]]; then
  API_KEY="$(gcloud services api-keys get-key-string "${existing_key_name}" --format='value(keyString)')"
else
  gcloud services api-keys create --display-name="${API_KEY_DISPLAY_NAME}" >/dev/null
  sleep 2
  existing_key_name="$(gcloud services api-keys list --format='value(name,displayName)' | awk -v n="${API_KEY_DISPLAY_NAME}" '$2==n {print $1; exit}')"
  if [[ -n "${existing_key_name}" ]]; then
    API_KEY="$(gcloud services api-keys get-key-string "${existing_key_name}" --format='value(keyString)')"
  fi
fi

if [[ -z "${API_KEY}" ]]; then
  echo "[BOOTSTRAP] No s'ha pogut obtenir API key." >&2
  exit 1
fi

if [[ -n "${OUTPUT_ENV_FILE}" ]]; then
  cat > "${OUTPUT_ENV_FILE}" <<EOFVARS
PROJECT_ID=${PROJECT_ID}
FIRESTORE_PROJECT_ID=${PROJECT_ID}
FIREBASE_PROJECT_ID=${PROJECT_ID}
FIRESTORE_DATABASE=(default)
FIRESTORE_COLLECTION_PREFIX=summa_publica
APP_BASE_URL=https://summapublica.app
FIREBASE_API_KEY=${API_KEY}
REGION=${REGION}
EOFVARS
  echo "[BOOTSTRAP] Fitxer d'entorn escrit a ${OUTPUT_ENV_FILE}"
fi

cat <<ENVVARS

[BOOTSTRAP] Projecte separat preparat.

Fes servir aquests valors a .env:
FIRESTORE_PROJECT_ID=${PROJECT_ID}
FIREBASE_PROJECT_ID=${PROJECT_ID}
FIRESTORE_DATABASE=(default)
FIRESTORE_COLLECTION_PREFIX=summa_publica
APP_BASE_URL=https://summapublica.app
FIREBASE_API_KEY=${API_KEY}

Deploy recomanat:
PROJECT_ID=${PROJECT_ID} REGION=${REGION} SERVICE_NAME=summa-publica-app APP_PUBLIC_URL=https://summapublica.app ./deploy/deploy-cloudrun.sh
ENVVARS

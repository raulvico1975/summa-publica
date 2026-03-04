#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no esta instal lat." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-europe-west1}"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-https://summapublica.app}"
API_SERVICE_NAME="${API_SERVICE_NAME:-summa-publica-api}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-summa-publica-worker}"
IMAGE="${IMAGE:-gcr.io/${PROJECT_ID}/summa-publica-app:$(date +%Y%m%d-%H%M%S)}"
BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-summa-publica-media}"
REQUIRE_ALL_SECRETS="${REQUIRE_ALL_SECRETS:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Cal PROJECT_ID" >&2
  exit 1
fi

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "[1/7] Activant APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com storage.googleapis.com --project "${PROJECT_ID}" >/dev/null

echo "[2/7] Preparant bucket ${BUCKET_NAME}"
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" --project "${PROJECT_ID}" --location="${REGION}" --uniform-bucket-level-access >/dev/null
fi

if [[ "${SKIP_BUILD}" == "true" ]]; then
  echo "[3/7] SKIP_BUILD=true, s'omet build"
else
  echo "[3/7] Build imatge ${IMAGE}"
  gcloud builds submit --project "${PROJECT_ID}" --tag "${IMAGE}" .
fi

secret_keys=(
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

secret_bindings=()
for key in "${secret_keys[@]}"; do
  if gcloud secrets describe "${key}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    secret_bindings+=("${key}=${key}:latest")
  elif [[ "${REQUIRE_ALL_SECRETS}" == "true" ]]; then
    echo "Falta el secret requerit: ${key}" >&2
    exit 1
  else
    echo "[warn] Secret no trobat, s'omet: ${key}"
  fi
done

base_env_file="$(mktemp)"
trap 'rm -f "${base_env_file}" "${api_env_file:-}" "${worker_env_file:-}"' EXIT

project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
default_runtime_sa="${project_number}-compute@developer.gserviceaccount.com"
echo "[3b/7] Donant accés a secrets al runtime SA ${default_runtime_sa}"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${default_runtime_sa}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

cat > "${base_env_file}" <<YAML
APP_BASE_URL: "${APP_PUBLIC_URL}"
DATA_STORE: "firestore"
FIRESTORE_PROJECT_ID: "${PROJECT_ID}"
FIREBASE_PROJECT_ID: "${PROJECT_ID}"
FIRESTORE_DATABASE: "(default)"
FIRESTORE_COLLECTION_PREFIX: "summa_publica"
DEFAULT_ORG_ID: "org_default"
FIREBASE_AUTH_BASE_URL: "https://identitytoolkit.googleapis.com/v1"
FIREBASE_SECURE_TOKEN_BASE_URL: "https://securetoken.googleapis.com/v1"
AUTH_RATE_LIMIT_WINDOW_MS: "900000"
AUTH_RATE_LIMIT_MAX_ATTEMPTS: "10"
AUTH_RATE_LIMIT_DISTRIBUTED: "true"
AUTH_REVOCATION_CHECK_ENABLED: "true"
AUTH_REVOCATION_CACHE_SEC: "60"
REQUIRE_EMAIL_VERIFIED: "true"
ENFORCE_MFA_FOR_PRIVILEGED_ROLES: "false"
POSTS_PAGE_DEFAULT_LIMIT: "50"
POSTS_PAGE_MAX_LIMIT: "200"
QUOTES_SHEET_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRKxv-dpVXZLAuhRDj_mQrxdMlnir4kLze6IsvfUwm7kA_Q_5fN_IK-IBEjthLLJr0ZVCCu-Y_6cIvE/pub?output=csv"
QUOTES_SHEET_GIDS: "1335524648,1883032053,1388745196"
QUOTES_SYNC_INTERVAL_MS: "604800000"
REQUIRE_REFERENCED_QUOTES: "true"
QUOTES_MIN_CONFIDENCE: "MITJA"
GEMINI_MODEL: "gemini-2.5-flash"
MAX_UPLOAD_BYTES: "5000000"
UPLOADS_MODE: "gcs"
GCS_UPLOAD_BUCKET: "${BUCKET_NAME}"
GCS_UPLOAD_PREFIX: "uploads"
ALLOW_WHATSAPP_AUTOPUBLISH: "false"
PUBLISH_INTERVAL_MS: "60000"
MAX_POSTS_PER_CYCLE: "10"
YAML

api_env_file="$(mktemp)"
worker_env_file="$(mktemp)"
cp "${base_env_file}" "${api_env_file}"
cp "${base_env_file}" "${worker_env_file}"
echo "APP_ROLE: \"api\"" >> "${api_env_file}"
echo "APP_ROLE: \"worker\"" >> "${worker_env_file}"

echo "[4/7] Deploy API ${API_SERVICE_NAME}"
api_args=(
  run deploy "${API_SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --image "${IMAGE}"
  --region "${REGION}"
  --platform managed
  --allow-unauthenticated
  --port 8080
  --env-vars-file "${api_env_file}"
)
if [[ ${#secret_bindings[@]} -gt 0 ]]; then
  api_args+=(--set-secrets "$(IFS=,; echo "${secret_bindings[*]}")")
fi
gcloud "${api_args[@]}"

echo "[5/7] Deploy Worker ${WORKER_SERVICE_NAME}"
worker_args=(
  run deploy "${WORKER_SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --image "${IMAGE}"
  --region "${REGION}"
  --platform managed
  --no-allow-unauthenticated
  --port 8080
  --min-instances 1
  --env-vars-file "${worker_env_file}"
)
if [[ ${#secret_bindings[@]} -gt 0 ]]; then
  worker_args+=(--set-secrets "$(IFS=,; echo "${secret_bindings[*]}")")
fi
gcloud "${worker_args[@]}"

echo "[6/7] Donant permisos bucket als runtime service accounts"
for service in "${API_SERVICE_NAME}" "${WORKER_SERVICE_NAME}"; do
  runtime_sa="$(gcloud run services describe "${service}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(spec.template.spec.serviceAccountName)')"
  if [[ -z "${runtime_sa}" ]]; then
    project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
    runtime_sa="${project_number}-compute@developer.gserviceaccount.com"
  fi
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
    --member="serviceAccount:${runtime_sa}" \
    --role="roles/storage.objectAdmin" >/dev/null || true
done

echo "[7/7] URLs finals"
api_url="$(gcloud run services describe "${API_SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
worker_url="$(gcloud run services describe "${WORKER_SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
echo "API URL: ${api_url}"
echo "WORKER URL: ${worker_url}"

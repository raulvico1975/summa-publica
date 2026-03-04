#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud no està instal·lat." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker no està instal·lat." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-summa-publica-app}"
REPO_NAME="${REPO_NAME:-summa-apps}"
IMAGE_NAME="${IMAGE_NAME:-summa-publica-app}"
BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-summa-publica-media}"
APP_PUBLIC_URL="${APP_PUBLIC_URL:-https://summapublica.app}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
REQUIRE_ALL_SECRETS="${REQUIRE_ALL_SECRETS:-false}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Cal PROJECT_ID. Exemple: PROJECT_ID=publicafpc ./deploy/deploy-cloudrun-local.sh" >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:${TAG}"

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "[1/8] Activant APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com storage.googleapis.com >/dev/null

echo "[2/8] Preparant repositori Artifact Registry"
if ! gcloud artifacts repositories describe "${REPO_NAME}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPO_NAME}" --repository-format=docker --location="${REGION}" --description="Summa Publica images" >/dev/null
fi

echo "[3/8] Preparant bucket de media persistent (${BUCKET_NAME})"
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}" --uniform-bucket-level-access >/dev/null
fi

echo "[4/8] Autenticant Docker"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null

echo "[5/8] Build+push local (linux/amd64) ${IMAGE}"
docker buildx build --platform linux/amd64 -t "${IMAGE}" --push .

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
  if gcloud secrets describe "${key}" >/dev/null 2>&1; then
    secret_bindings+=("${key}=${key}:latest")
  elif [[ "${REQUIRE_ALL_SECRETS}" == "true" ]]; then
    echo "Falta el secret requerit: ${key}" >&2
    exit 1
  else
    echo "[warn] Secret no trobat, s'omet: ${key}"
  fi
done

echo "[6/8] Deploy Cloud Run ${SERVICE_NAME}"
env_file="$(mktemp)"
trap 'rm -f "${env_file}"' EXIT
cat > "${env_file}" <<YAML
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
APP_ROLE: "all"
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

deploy_args=(
  run deploy "${SERVICE_NAME}"
  --image "${IMAGE}"
  --region "${REGION}"
  --platform managed
  --allow-unauthenticated
  --port 8080
  --env-vars-file "${env_file}"
)

if [[ ${#secret_bindings[@]} -gt 0 ]]; then
  deploy_args+=(--set-secrets "$(IFS=,; echo "${secret_bindings[*]}")")
fi

gcloud "${deploy_args[@]}"

echo "[7/8] Donant permisos de bucket al runtime service account"
RUNTIME_SA="$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(spec.template.spec.serviceAccountName)')"
if [[ -z "${RUNTIME_SA}" ]]; then
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectAdmin" >/dev/null

echo "[8/8] URL final"
echo "URL final:"
gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(status.url)'

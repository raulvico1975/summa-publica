# Deploy a Cloud Run (Summa Publica SaaS)

## Objectiu

Desplegar en mode comercial:

- `api` public (`summa-publica-api`)
- `worker` privat (`summa-publica-worker`)
- Firestore multi-tenant (`summa_publica_*`)

## 0) Crear projectes separats (dev/staging/prod)

```bash
BILLING_ACCOUNT_ID=<billing-id> npm run bootstrap:envs
```

Això genera:

- `deploy/environments/dev.env`
- `deploy/environments/staging.env`
- `deploy/environments/prod.env`

## 1) Carregar secrets

```bash
PROJECT_ID=<projecte-entorn> ./deploy/seed-secrets.sh
```

Secrets mínims recomanats:

- `FIREBASE_API_KEY`
- `SESSION_SECRET`
- `WORKER_TICK_TOKEN`
- `META_APP_ID` (si voleu OAuth de Facebook/Instagram per entitat)
- `META_APP_SECRET` (si voleu OAuth de Facebook/Instagram per entitat)

Per actualitzar/rotar només els secrets de Meta (dev/staging/prod) i aplicar-los a Cloud Run:

```bash
bash deploy/update-meta-secrets.sh
```

## 2) Deploy stack (api + worker)

```bash
PROJECT_ID=<projecte-entorn> REGION=europe-west1 APP_PUBLIC_URL=https://summapublica.app ./deploy/deploy-cloudrun-stack.sh
```

El script desplega:

- `summa-publica-api` (`APP_ROLE=api`, públic)
- `summa-publica-worker` (`APP_ROLE=worker`, privat, min instances 1)

Per desplegar els 3 entorns en cadena (si ja tens `deploy/environments/*.env`):

```bash
npm run deploy:all
```

## 3) Variables clau de runtime

- `FIRESTORE_PROJECT_ID=<projecte-entorn>`
- `FIREBASE_PROJECT_ID=<projecte-entorn>`
- `FIRESTORE_COLLECTION_PREFIX=summa_publica`
- `AUTH_RATE_LIMIT_DISTRIBUTED=true`
- `AUTH_REVOCATION_CHECK_ENABLED=true`
- `REQUIRE_EMAIL_VERIFIED=true`

## 4) Regles Firestore

```bash
firebase deploy --only firestore:rules --project <projecte-entorn>
```

## 5) Verificacio post-deploy

- `/api/health` retorna `role=api` al servei API
- signup/login funcionen amb verificacio d email
- no hi ha accessos cross-tenant
- worker processa cicles de publicacio (logs)

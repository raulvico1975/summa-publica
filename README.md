# Summa Publica

Projecte separat inspirat en l'app de Fundacio, amb el mateix flux funcional de negoci i dos canvis de fase:

- nou disseny visual (tokens Summa)
- arquitectura multi-entitat amb Firebase Auth + Firestore
- preparat per operacio SaaS (`api` + `worker`) i entorns separats

## Objectiu d'aquesta fase

- No canviar calculs ni regles de negoci.
- Si canviar autenticacio, segregacio de dades per `orgId` i look & feel.

## Stack

- Backend Node.js (sense deps noves)
- Frontend web static (`web/`)
- Firebase Auth (email/password)
- Firestore (`DATA_STORE=firestore`)
- Cloud Run en dos serveis (`api`, `worker`)

## Model multi-entitat

Colleccions (prefix per defecte `summa_publica`):

- `summa_publica_orgs`
- `summa_publica_users`
- `summa_publica_memberships`
- `summa_publica_posts` (amb `orgId`)
- `summa_publica_audit` (amb `orgId`)
- `summa_publica_meta` (quotes catalog)
- `summa_publica_social_integrations` (tokens OAuth xifrats per `orgId`)
- `summa_publica_oauth_states` (state OAuth one-shot amb expiracio)

Sessio backend en cookie `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS.

## Seguretat auth (nivell produccio)

- Verificacio criptografica de Firebase ID token (certificats publics Google).
- Check de revocacio/desactivacio d usuari via Firebase.
- Refresh automatic de token amb `refresh_token` dins sessio segura.
- `emailVerified` obligatori (`REQUIRE_EMAIL_VERIFIED=true`).
- MFA per rols privilegiats opcional (`ENFORCE_MFA_FOR_PRIVILEGED_ROLES=true`).

## Variables d'entorn

Copia `.env.example` a `.env` i omple com a minim:

- `APP_BASE_URL=https://summapublica.app` (prod)
- `DATA_STORE=firestore`
- `FIRESTORE_PROJECT_ID=...`
- `FIREBASE_PROJECT_ID=...`
- `FIREBASE_API_KEY=...`
- `SESSION_SECRET=...`
- `WORKER_TICK_TOKEN=...`
- `META_APP_ID=...`
- `META_APP_SECRET=...`

Per connexio real de xarxes socials:

- El connect de Facebook/Instagram es fa via OAuth (`/api/integrations/meta/connect`).
- La contrasenya de la xarxa social no passa per Summa Publica.
- Tokens de publicacio es guarden xifrats al backend.

Per rotar `META_APP_ID`/`META_APP_SECRET` de forma segura als 3 entorns:

```bash
bash deploy/update-meta-secrets.sh
```

## Projecte GCP/Firebase separat

Per crear un projecte completament separat (project id, Firestore i API key propis):

```bash
PROJECT_ID=summa-publica-<sufix> BILLING_ACCOUNT_ID=<billing-id> ./deploy/bootstrap-separate-project.sh
```

Aquest repositori ja te configurat el projecte separat creat:

- `FIRESTORE_PROJECT_ID=summa-publica-260304-799`
- Firestore `(default)` creat en mode Native
- Regles publicades amb `firebase deploy --only firestore:rules`

## Entorns separats (dev/staging/prod)

Script per crear 3 projectes GCP/Firebase separats:

```bash
BILLING_ACCOUNT_ID=<billing-id> npm run bootstrap:envs
```

Genera:

- `deploy/environments/dev.env`
- `deploy/environments/staging.env`
- `deploy/environments/prod.env`
- `deploy/environments/services.md` (quan es fa deploy)

## Execucio local

```bash
npm run start
```

## Migracio no destructiva

1. Crea org per defecte (`DEFAULT_ORG_ID`, per defecte `org_default`).
2. Backfill `orgId` a dades historiques (`posts`, `audit`) sense eliminar res.

```bash
npm run migrate:orgs
```

Opcional dry-run:

```bash
node backend/migrate-orgs.mjs --dry-run
```

## Test minim de segregacio

```bash
npm run test:tenancy
```

El test valida que una org no pot llegir, editar ni eliminar dades d'una altra.

## Seguretat

- Rate limit distribuït a `/api/signup` i `/api/login` (Firestore).
- Autoritzacio backend per `orgId` a totes les rutes de negoci.
- Regles Firestore de referencia: `deploy/firestore.rules`.

## Fitxers principals

- `backend/server.mjs`: API, auth, scheduler, autoritzacio per org
- `backend/auth.mjs`: Firebase Auth REST + sessio signada
- `backend/db.mjs`: persistencia local/firestore multi-tenant
- `backend/migrate-orgs.mjs`: migracio no destructiva
- `backend/selftest-tenancy.mjs`: test minim de segregacio
- `deploy/deploy-cloudrun-stack.sh`: deploy SaaS (api + worker)
- `deploy/bootstrap-environments.sh`: bootstrap dev/staging/prod
- `web/index.html`, `web/app.js`, `web/styles.css`: UI Summa

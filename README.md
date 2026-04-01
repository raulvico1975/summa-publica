# Summa Publica

Plataforma de gestio i publicacio per a entitats socials amb integracio de xarxes socials.

**Produccio:** [summapublica.app](https://summapublica.app)

## Que fa

- Gestio multi-entitat amb autenticacio segura (Firebase Auth)
- Publicacio automatitzada a xarxes socials (Facebook/Instagram via OAuth)
- Operacio SaaS amb API + Worker separats
- Segregacio de dades per organitzacio
- Verificacio d'email obligatoria i MFA opcional per rols privilegiats

## Stack

| Capa | Tecnologia |
|------|------------|
| Backend | Node.js |
| Frontend | Web estatic (`web/`) |
| Auth | Firebase Auth (email/password) |
| Dades | Firestore |
| Xarxes socials | Meta Graph API (OAuth) |
| Hosting | Cloud Run (2 serveis: `api` + `worker`) |

## Execucio local

```bash
# Copiar configuracio
cp .env.example .env

# Arrancar
npm start
```

Variables minimes a `.env`:

```bash
APP_BASE_URL=http://localhost:3000
DATA_STORE=firestore
FIRESTORE_PROJECT_ID=...
FIREBASE_PROJECT_ID=...
FIREBASE_API_KEY=...
SESSION_SECRET=...
WORKER_TICK_TOKEN=...
```

## Entorns

El projecte suporta tres entorns separats (dev/staging/prod), cadascun amb el seu propi projecte GCP/Firebase:

```bash
# Crear els 3 entorns
BILLING_ACCOUNT_ID=<billing-id> npm run bootstrap:envs
```

## Seguretat

- Verificacio criptografica de Firebase ID tokens
- Check de revocacio d'usuari via Firebase
- Refresh automatic de tokens
- Sessions en cookie `HttpOnly`, `SameSite=Strict`, `Secure`
- Tokens OAuth de xarxes socials xifrats al backend
- Rotacio segura de secrets Meta:

```bash
bash deploy/update-meta-secrets.sh
```

## Estructura

```
api/            Endpoints i logica de servidor
web/            Frontend estatic
deploy/         Scripts de deploy i bootstrap d'entorns
```

## Model de dades

Colleccions Firestore (prefix `summa_publica`):

- `_orgs` — Organitzacions
- `_users` — Usuaris
- `_memberships` — Relacio usuari-org amb rols
- `_posts` — Continguts per publicar
- `_audit` — Registre d'auditoria
- `_social_integrations` — Tokens OAuth xifrats

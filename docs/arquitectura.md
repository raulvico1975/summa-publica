# Arquitectura tecnica (fase Summa Publica SaaS)

## Scope de fase

- Mateixa funcionalitat de negoci que l'app original.
- Nou disseny visual.
- Multi-entitat (`orgId`) amb aillament estricte.
- Operacio preparada per volum (api + worker separats).

## Components

1. Frontend (`web/`)
- login email/password
- signup de nova entitat
- mateix flux funcional de publicacio

2. API service (`APP_ROLE=api`)
- autenticacio, sessio, autoritzacio per `orgId`
- operacions de negoci
- uploads/media

3. Worker service (`APP_ROLE=worker`)
- cicles de publicacio automatics
- sync de quotes
- endpoint intern `POST /api/internal/worker/tick`

4. Persistencia
- Firestore multi-tenant:
  - `summa_publica_orgs`
  - `summa_publica_users`
  - `summa_publica_memberships`
  - `summa_publica_posts`
  - `summa_publica_audit`
  - `summa_publica_rate_limits`
  - `summa_publica_meta`

## Autenticacio i sessio

- login/signup amb Firebase Auth REST.
- backend emmagatzema sessio signada `HttpOnly` amb `idToken` + `refreshToken`.
- validacio de sessio en cada request:
  - verificacio criptografica del JWT Firebase
  - check revocacio/desactivacio usuari
  - refresh automatic de token quan toca
- `emailVerified` obligatori per defecte.

## Segregacio tenant

- cada operacio usa `orgId` de la sessio (mai del client).
- backend filtra totes les lectures/escriptures per `orgId`.
- regles Firestore bloquegen acces cross-tenant.

## Escalabilitat aplicada

- rate limit distribuït (Firestore) per login/signup.
- paginacio a `GET /api/posts` (`limit`, `cursor`).
- separacio de rols de runtime (`api` vs `worker`).

## Migracio

`backend/migrate-orgs.mjs`:

- crea org per defecte
- backfill `orgId` a dades historiques
- no destructiu

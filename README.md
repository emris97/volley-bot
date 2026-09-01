# Volley Bot

Volley Bot is a Telegram-first volleyball attendance and settlement service. PostgreSQL is the authoritative store for groups, games, registrations, attendance, settlements, audit events, the transactional outbox, and scheduled-job intent. Redis contains only reconstructible delivery work. Losing Redis must not lose or change business state; the worker reconciles Redis jobs from PostgreSQL.

The API and worker are stateless, provider-neutral Node.js services. They do not contain cloud-provider deployment logic or payment-provider integration. Payment records represent administrator-controlled bookkeeping only.

## Local configuration

Copy `.env.example` to `.env` for local development and replace every placeholder. Production secrets must be injected through environment variables or the platform's secret store; never bake `.env` files or credentials into an image.

Required settings are `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, and `LOG_LEVEL`. `PORT` controls the API listener and defaults to `3000`.

Install and verify:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## Runtime and deployment

Build the provider-neutral Node 24 images with:

```sh
docker compose build api worker
```

Database migration is an explicit, one-shot deployment step:

```sh
docker compose run --rm db-migrate
```

The normal `api` and `worker` entrypoints never run migrations. This keeps horizontally scaled API startup safe. Compose expresses the same ordering by requiring the one-shot `db-migrate` service to complete before starting API or worker processes.

Start the stack:

```sh
docker compose up -d postgres redis
docker compose run --rm db-migrate
docker compose up -d api worker
```

Only PostgreSQL has a durable application volume. Redis is deliberately ephemeral. Both application images use multi-stage builds, production dependencies and compiled output only, a non-root runtime user, read-only filesystems in Compose, and signal-aware `exec` entrypoints. Nest shutdown hooks drain workers and close process resources on termination.

## Operations

The API exposes:

- `GET /health/live` for process liveness;
- `GET /health/ready` for PostgreSQL and Redis readiness;
- `GET /metrics` in Prometheus text format.

Metrics cover webhook outcomes and latency, queue depth, job retries, outbox lag, notification failures, and transaction conflicts. Logs are structured JSON and redact configured bot/webhook secrets, database and Redis credentials, authorization headers, raw Mini App `initData`, and sensitive Telegram message content. Avoid adding unstructured stdout logging or user message bodies.

The outbox worker also performs bounded cleanup of expired payment drafts and private input sessions. Scheduled job reconciliation repairs delivery work after Redis loss. These maintenance paths are safe to repeat and keep PostgreSQL authoritative.

## Retention baseline

Use the following conservative, finite defaults for the first private deployment:

| Data | Default retention | Operational intent |
| --- | ---: | --- |
| Guest display names | 180 days after game completion | Allow short-lived roster and settlement support, then anonymize or delete |
| Notification delivery attempts | 30 days | Diagnose delivery failures and retries |
| Application logs | 14 days | Incident investigation without accumulating message metadata |
| Business audit events | 2 years | Administrator action traceability |
| Payment and settlement records | 5 years | Bookkeeping history and corrections |

These periods are deployment defaults, not legal advice. Before any public launch, obtain jurisdiction-specific legal, privacy, tax, and accounting review; document the resulting lawful basis, deletion/anonymization jobs, backup expiry, data-subject request process, and any required changes to these periods. Backups and exported observability data must not silently outlive the approved policy.

## Architecture constraints

- PostgreSQL is authoritative; Redis is a recoverable delivery accelerator.
- The transactional outbox bridges committed business changes to workers.
- Group identifiers scope every application and repository lookup.
- Money is stored and split in integer minor units; only administrators change payment status.
- Telegram Mini App requests use signed, fresh `initData` and the same authorization/application services as Telegram flows.
- Containers depend only on environment configuration and standard PostgreSQL/Redis protocols.

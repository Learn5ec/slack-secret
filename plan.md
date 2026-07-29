# Implementation Plan: secret-bot (Slack View-once Secrets)

## Context

This is a greenfield project — the repo at `/home/web-h-034/Sync/slack-secret/` is empty. The goal is to build a Slack app that lets users share text secrets and files privately with view-once, download-once, and auto-delete behavior. This plan implements **Sprint 1 (MVP: text-only, single-viewer DM)** as defined in the technical spec, with clear extension points for Sprint 2–4.

Deployment target: fully self-hosted on a Kali Linux box using Socket Mode (no public IP needed).

---

## Sprint 0: Project Scaffolding

**Files to create:**
- `package.json` — dependencies and scripts
- `tsconfig.json` — TypeScript config (strict mode, ES2022)
- `.env.example` — template for required env vars
- `.gitignore` — `node_modules/`, `dist/`, `.env`, `src/crypto/keys/`, `*.key`
- `src/config.ts` — zod-validated env loading (the first file everything else depends on)

**Key dependencies (production):**
```
@slack/bolt              # Slack app framework (Socket Mode)
@slack/web-api           # low-level client for chat.update, views.update
pg                       # PostgreSQL client
bullmq                   # job queue (delayed jobs for deletion timers)
ioredis                  # Redis client (BullMQ dependency)
libsodium-wrappers       # crypto (XSalsa20-Poly1305, simpler than AES-GCM)
age-js                   # or use `age-cli` subprocess for master key encryption
pino                     # structured logging
zod                      # runtime env validation
node-pg-migrate          # SQL migration runner
```

**Key dependencies (dev):**
```
typescript, @types/pg, @types/bullmq, @types/ioredis
vitest                   # test runner
tsx                      # run TS directly
```

**`tsconfig.json`:** strict mode, ES2022 target, `moduleResolution: node`, `resolveJsonModule: true`.

**`.env` variables needed:**
```
SLACK_APP_TOKEN=xapp-...          # Socket Mode app token (connections:write scope)
SLACK_BOT_TOKEN=xoxb-...          # Bot user token (for chat/views API)
SLACK_SIGNING_SECRET=...          # for Socket Mode verification
SLACK_TEAM_ID=T00000000
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=secret_bot
POSTGRES_USER=secret_bot
POSTGRES_PASSWORD=...
REDIS_URL=redis://localhost:6379
MASTER_KEY_FILE=./src/crypto/keys/master.key.age
MASTER_KEY_PASSPHRASE=...         # for age decryption
LOG_LEVEL=info
```

---

## Phase 1: Database Layer

**Files:**
- `src/db/client.ts` — `pg.Pool` initialization, connection error handling, lifecycle (open on start, close on SIGTERM)
- `src/db/migrations/001_create_tables.sql` — both CREATE TABLE statements from the spec
- `bin/migrate.ts` — migration runner (execute SQL via `pg`)
- `src/db/secrets.ts` — `createSecret`, `getSecretById`, `updateSecretStatus`, `getPendingSecrets`, `hardDeleteSecret`, `hardDeleteSecretsForId`
- `src/db/views.ts` — `createView` (ON CONFLICT DO NOTHING), `getViewsBySecretId`, `markViewAsDelivered`, `markViewAsDeleted`, `deleteViewsForSecret`

**Key design point:** The `UNIQUE(secret_id, viewer_id)` constraint on `views` is the real double-view guard. `createView` uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` — check the row count to determine if the view was successful.

---

## Phase 2: Utilities (errors, logging)

**Files:**
- `src/utils/logger.ts` — pino instance (JSON in prod, pretty in dev)
- `src/utils/errors.ts` — domain error classes: `SecretNotFoundError`, `SecretAlreadyViewedError`, `UnauthorizedError`, `SecretExpiredError`, `SecretCancelledError`
- `src/utils/slack-ids.ts` — userId → displayName cache

**Error handling pattern:** Handlers catch domain errors and map to Slack user-facing messages. Unknown errors are logged + generic "Something went wrong." Crypto errors are fatal — they indicate tampering, so they bubble up without being caught.

---

## Phase 3: Encryption Module

**Files:**
- `src/crypto/constants.ts` — algorithm names, key sizes, nonce sizes, envelope schema types
- `src/crypto/master.ts` — master key loading from `.age` file, wrap/unwrap data key
- `src/crypto/secret.ts` — `encryptSecret(plaintext, dataKey)` → `{ciphertext, nonce, encryptedDataKey}`, `decryptSecret(envelope, masterKey)` → plaintext
- `src/crypto/keys/` — encrypted master key files (gitignored)

**Envelope encryption scheme:**
```
Plaintext
  → random 256-bit data key (DK)
  → XSalsa20-Poly1305 encrypt with DK + 24-byte random nonce
  → Ciphertext
  → Encrypt DK with master key (age)
  → Encrypted Data Key (EDK)
```

Store only `{ciphertext, nonce, encryptedDataKey}` in the DB. Decrypt only in-memory at delivery time. **Never log plaintext, ciphertext, or keys.**

**Test encryption manually:**
```bash
age-keygen > master.key
age -p -o master.key.age master.key
```

---

## Phase 4: Queue Layer

**Files:**
- `src/queue/client.ts` — BullMQ `Queue` instances: `delete-dm-message` and `purge-expired-secret`
- `src/queue/delete-job.ts` — processor: `chat.delete`, mark view as `deleted`, handle `message_not_found` gracefully
- `src/queue/expiry-job.ts` — processor: set secret status to `expired`, update placeholder message, hard-delete rows

**Job data shape:**
```typescript
type DeleteDmMessagePayload = { viewId: string; dmChannelId: string; dmTs: string; secretId: string };
type PurgeExpiredSecretPayload = { secretId: string; isConsumed: boolean };
```

Jobs survive process restarts (Redis-backed). Retry with exponential backoff on transient failures.

---

## Phase 5: Bolt.js App Wiring

**Files:**
- `src/slack/client.ts` — `@slack/web-api` client singleton with `SLACK_BOT_TOKEN`
- `src/slack/view-builder.ts` — constructs modal JSON and placeholder message block kit JSON
- `src/slack/types.ts` — custom Slack payload type augmentations for action callbacks

**Slack client capabilities used:**
- `conversations.open` (for DMs)
- `conversations.info` (for channel membership checks, §3.3)
- `chat.postMessage` (placeholder)
- `chat.update` (update placeholder on view/cancel)
- `chat.delete` (5-min auto-delete)
- `chat.postEphemeral` (sender-only responses)
- `files.uploadV2` (file reveal, Phase 2)
- `files.delete` (after upload to Slack, Phase 2)

---

## Phase 6: Bot Handlers (Core Flow)

**Files:**
- `src/bot/commands.ts` — `/secret` slash command → respond with modal
- `src/bot/modals.ts` — modal submission: validate text, encrypt, insert DB, schedule expiry, post placeholder
- `src/bot/actions.ts` — three button handlers (the core of the user experience)
- `src/bot/dm.ts` — helper to open/get DM channel, return `{channel_id, ts}`

### The 3-Button Action Flow

```
User clicks "View Secret"
  → app.action('secret:view')
  → Check: clicking_user.id === secret.sender_id?
    → YES: sender self-view (modal with decrypted text, no views row, no consumption, unlimited self-views)
    → NO:
      → Transaction: SELECT status FOR UPDATE on secrets
      → If status='expired'/'cancelled' → ephemeral "no longer available"
      → If visibility_mode='single' AND allowed_viewer_id set AND doesn't match → ephemeral "not sent to you"
      → ON CONFLICT INSERT into views → 0 rows = already viewed → ephemeral "already viewed"
      → 1 row: mark secret 'consumed' (single mode), decrypt text, chat.postMessage in viewer DM,
        record dm_channel_id/dm_ts/delete_at on views row, schedule delete-dm-message job (5 min),
        chat.update placeholder ("Secret viewed." / "viewed by N people so far")
  → ack()

User clicks "Viewed By"
  → app.action('secret:viewed-by')
  → Check: clicking_user.id === secret.sender_id → else ephemeral reject
  → Query views for secret_id, respond ephemeral with viewer list (display names + delivered_at)
  → ack()

User clicks "Cancel"
  → app.action('secret:cancel')
  → Check: clicking_user.id === secret.sender_id → else ephemeral reject
  → For each delivered view: chat.delete (tolerate message_not_found)
  → chat.delete origin placeholder
  → fs.unlink encrypted file (if file type)
  → Hard-delete secrets row + all views rows from Postgres
  → Remove all pending BullMQ jobs for this secret
  → ack()
```

**Critical pattern:** The sender-self-view flow is distinct from the recipient reveal flow — it doesn't touch the `views` table, doesn't consume a single-mode slot, and works for the full 1-hour window.

---

## Phase 7: Application Bootstrap

**Files:**
- `src/index.ts` — initialize config, logger, DB pool, queue clients, Bolt app, register all handlers, connect Socket Mode, start
- `systemd/secret-bot.service` — unit file for running as a service
- Smoke test: start app, run `/secret`, verify DB row, verify placeholder, trigger buttons

**Graceful shutdown:** SIGTERM handler that closes DB pool, disconnects queue workers, closes WebSocket connection.

**Health check (Phase 1b):** simple HTTP server on a local port (`/healthz`) checking Postgres + Redis liveness.

---

## Phase 8: Extension to Sprint 2-4 (Future)

**Sprint 2 (files):**
- Add `file_input` to modal, `file_path`/`file_name`/`file_size_bytes` columns to secrets table
- `encryptFile(buffer)` in crypto module, `fs.unlink` for local encrypted file cleanup
- `files.delete` on Slack-side copy after upload
- AV scan hook before encrypting/storing

**Sprint 3 (channel multi-viewer):**
- Modal adds `visibility_mode` selector (`single`/`multi`)
- `secret:view` handler branches on `visibility_mode` — single→DM, multi→channel
- Placeholder shows counter ("viewed by N people so far") instead of names

**Sprint 4 (hardening):**
- Rate limiting on `/secret`
- Alerting on failed deletes (Slack webhook to ops channel)
- Admin dashboard for stuck job visibility

---

## Key TypeScript Design Decisions

### Type Safety
- **Strict mode.** No `any`.
- Slack payload types augmented in `src/slack/types.ts`.
- Discriminated union for envelope schema:
```typescript
type SecretEnvelope = {
  version: 1;
  algorithm: 'xsalsa20poly1305';
  nonce: string;
  ciphertext: string;
  encryptedDataKey: string;
};
```
- DB rows mapped to typed interfaces in repo layer, never leaking raw rows into handlers.

### Logging
- `pino` with `{secretId, userId, action}` context on every line.
- Sensitive values (text, keys, ciphertext) **never** logged.

### Error Handling
- Domain errors (`SecretNotFoundError`, `SecretAlreadyViewedError`, etc.) extend `Error` with stable `code` property.
- Handlers map domain errors → Slack ephemeral messages. Unknown → logged + generic fallback.
- Crypto errors are fatal — bubble up, app logs and declines to respond.

---

## Testing Strategy

| Type | What | How |
|------|------|-----|
| Unit | crypto round-trip, error classes | vitest, in-memory |
| Unit | DB repo functions | vitest + mocked pg |
| Integration | Full flow (create → view → delete) | vitest + testcontainers Postgres |
| Integration | Queue processors | vitest + ioredis-mock or real Redis |
| E2E | Bolt handler flows | `app.receive()` with hand-crafted payloads |

---

## Implementation Order Summary

| Step | File(s) | Phase |
|------|---------|-------|
| 1 | `package.json`, `tsconfig.json`, `.gitignore`, `.env.example` | 0 |
| 2 | `src/config.ts` | 0 |
| 3 | `src/db/client.ts`, `src/db/migrations/001_create_tables.sql`, `bin/migrate.ts` | 1 |
| 4 | `src/db/secrets.ts`, `src/db/views.ts` | 1 |
| 5 | `src/utils/logger.ts`, `src/utils/errors.ts` | 2 |
| 6 | `src/crypto/constants.ts`, `src/crypto/master.ts`, `src/crypto/secret.ts` | 3 |
| 7 | `src/queue/client.ts`, `src/queue/delete-job.ts`, `src/queue/expiry-job.ts` | 4 |
| 8 | `src/slack/client.ts`, `src/slack/view-builder.ts`, `src/slack/types.ts` | 5 |
| 9 | `src/bot/commands.ts`, `src/bot/modals.ts`, `src/bot/actions.ts`, `src/bot/dm.ts` | 6 |
| 10 | `src/index.ts`, `systemd/secret-bot.service` | 7 |
| 11 | Tests in `src/__tests__/` | Phase 1b |

---

## Verification

1. Run `tsx bin/migrate.ts` → verify Postgres tables created correctly
2. Run `tsx src/index.ts` with real Socket Mode tokens → verify Bolt app connects
3. Run `/secret` in Slack → verify modal opens
4. Submit modal with text → verify DB row created, placeholder posted in DM
5. Click "View Secret" (as recipient) → verify text delivered in DM, placeholder updated, 5-min timer set
6. Wait 5 min → verify message auto-deleted
7. Click "Viewed By" → verify sender sees viewer list
8. Click "Cancel" → verify secret fully deleted everywhere
9. Run `npm test` → verify crypto + DB unit tests pass

# Secret Bot - Slack View-Once Secrets

A Slack bot that lets users share text, files, or both privately with per-viewer view-once, instant-hide, and auto-delete behavior.

## 🚀 Features

### Core Functionality

- **Slash Command**: `/secret` opens a modal to share secrets
- **Text Secrets**: Share encrypted text messages (up to 3000 characters)
- **File Secrets**: Share an encrypted file, AV-scanned before storage
- **Combined Secrets**: Text and a file together in one share
- **Single Viewer Mode**: Send secrets to one specific user via DM
- **Multi Viewer Mode**: Share with anyone who clicks (no recipient specified)

### Encryption & Security

- **Envelope Encryption**: Per-secret 256-bit data key encrypted with the master key, applied independently to text and file content (a combined secret has two separate envelopes on one row)
- **XSalsa20-Poly1305**: Sodium-based authenticated encryption
- **Master Key**: Raw 32-byte key stored at `src/crypto/keys/master.key` with 0600 permissions
- **Per-Viewer View-Once**: `UNIQUE(secret_id, viewer_id)` means the sender and the recipient each get their own independent one-time reveal — one viewing it doesn't consume or block the other's
- **Auto-Delete**: Each reveal is deleted 5 minutes after it was first opened (configurable), on a fixed per-viewer timer that isn't reset by hiding/re-opening
- **AV Scanning**: Uploaded files are scanned with ClamAV before being stored (if installed; fails open if not)

### User Experience

- **Sender's message**: "🔓 View Secret", "👁 Viewed By", "🗑 Revoke" — these three buttons stay as-is regardless of who has viewed; only Revoke removes the message
- **Recipient's message**: "🔓 View Secret" only
- **Viewing** opens a private DM (not a Slack "ephemeral" message — see below) containing the secret content and its own "🙈 Hide Secret" button. File-only secrets get a small companion message with that button right below the uploaded file, since Slack's file upload API has no way to attach interactive buttons to the file message itself
- **Hide Secret**: deletes the reveal instantly. Clicking "View Secret" again *within the original 5-minute window* re-opens it; after that window, it shows "🔒 Secret Expired" instead
- **Viewed By**: DMs the sender the list of who has viewed and the exact time (IST) they did
- **Revoke**: sender-only, immediately deletes every message this secret ever produced — its own placeholder, the recipient's placeholder, any open reveal(s) (text and/or file), and the Viewed By message — plus the encrypted file on disk and the database rows
- **Permanent Announcement**: a separate, permanent "X sent a secret to Y" message stays in the channel even after Revoke

Why real DMs instead of Slack's native "ephemeral" messages? Slack has no supported way to delete
an ephemeral message except via a live click on that exact message — not from a background timer,
not from a different button. A real bot-owned DM message can be deleted with `chat.delete` from
anywhere (a click, a timer, Revoke), so that's what every reveal uses, with an embedded button to
keep the "just for you" feel.

### Message Flow

```
1. Sender runs /secret, picks a recipient (optional), enters text and/or attaches a file
2. Secret is encrypted (text and file independently, if both present) and stored in PostgreSQL
3. Permanent announcement posted in the origin channel: "🔒 sender sent a secret to recipient"
4. Interactive placeholder posted there too: [View Secret] [Viewed By] [Revoke]
5. If a recipient was picked, they get a DM with [View Secret] only
6. Either party clicking View Secret opens a private DM reveal (their own, tracked independently)
   with an embedded [Hide Secret] button; a 5-minute auto-delete timer starts for that reveal
7. Hide Secret deletes it early; View Secret again before the 5 minutes are up re-opens it
8. Sender can click Viewed By any time to see who has viewed and when (IST)
9. Sender can click Revoke any time to tear down everything immediately
10. If nobody interacts with it at all, a background sweep purges it once it expires
```

### Architecture

- **Framework**: Bolt.js (Node/TypeScript) with Socket Mode
- **Database**: PostgreSQL for persistent state
- **Queue**: BullMQ + Redis for delayed jobs (per-viewer auto-delete)
- **Background sweeps**: two interval loops, independent of Redis/BullMQ, using Postgres as source of truth — one purges secrets that expired without ever being viewed or revoked, the other re-enqueues any view whose delete timer was lost (e.g. a Redis restart)
- **Crypto**: libsodium-wrappers for XSalsa20-Poly1305 encryption
- **AV scanning**: ClamAV via `clamscan`, optional
- **Logging**: Pino with sensitive data redaction

### Configuration

Dynamic config file at `config/secret-bot-config.json`, hot-reloaded (checked every 60s, picks up any content change - no need to restart):

```json
{
  "timing": {
    "secret_expiry_seconds": 3600,
    "delete_after_view_seconds": 300,
    "expiry_check_interval_seconds": 60,
    "delete_check_interval_seconds": 30
  },
  "security": {
    "max_secret_length": 3000,
    "max_recipients": 1,
    "allow_multi_viewer": true,
    "max_file_size_bytes": 10485760
  },
  "behavior": {
    "sender_sees_buttons": true,
    "recipient_sees_only_view": true,
    "auto_revoke_on_expiry": true,
    "notify_on_cancel": true
  }
}
```

> **This is the file that actually controls the upload size limit** (`security.max_file_size_bytes`).
> `.env` also has a `FILE_SIZE_MAX` variable that looks like it should do the same thing — it doesn't;
> it's parsed but never read anywhere. Edit the JSON file, not the env var.

### Database Schema

**secrets table** (`src/db/migrations/001`–`008`):
- `id` (UUID), `sender_id`, `origin_channel_id`, `origin_ts`
- `type` (`text` / `file` / `combined`)
- text envelope: `ciphertext`, `iv`, `encrypted_data_key`
- file envelope + metadata: `file_path` (ciphertext lives on disk, not in this column), `file_name`, `file_size_bytes`, `file_iv`, `file_encrypted_data_key`
- `allowed_viewer_id`, `visibility_mode` (`single`/`multi`)
- `status` (`pending`/`expired`/`cancelled` — `consumed` is a legacy value nothing sets anymore)
- `created_at`, `expires_at`
- message tracking for cleanup: `recipient_dm_channel_id`/`recipient_dm_ts`, `viewed_by_channel_id`/`viewed_by_ts`, `sender_placeholder_channel_id`/`sender_placeholder_ts`

**views table**:
- `id` (UUID), `secret_id` (FK), `viewer_id`
- `dm_channel_id`, `dm_ts` (text reveal), `file_dm_ts` + `file_upload_id` (file reveal, tracked separately so either can be deleted on its own)
- `delivered_at`, `delete_at` (fixed at first view, never extended by hide/re-open)
- `status` (`delivered`/`deleted`)
- `UNIQUE(secret_id, viewer_id)` — this is what makes view-once per-viewer instead of per-secret

### Deployment

**Systemd Service**: `systemd/secret-bot.service` (or let `install.sh` generate one for your actual user/paths — see below)

**Environment Variables** (`.env`, see `.env.example`):
```
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_TEAM_ID=T...
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=secret_bot
POSTGRES_USER=secret_bot
POSTGRES_PASSWORD=...
REDIS_URL=redis://localhost:6379
MASTER_KEY_FILE=./src/crypto/keys/master.key
```

**Setup** (automated):
```bash
./install.sh
```
Checks/installs prerequisites (Node, PostgreSQL, Redis, optionally ClamAV), installs npm
dependencies, walks you through Slack app credentials, creates the Postgres role/database,
runs migrations, generates the master key, and optionally installs a systemd service. Safe
to re-run - it never overwrites an existing `.env` or master key.

**Setup** (manual):
```bash
npm install
npm run migrate
npm run gen-key
npm run dev
```
You'll still need to create `.env` yourself (see `.env.example`) and have PostgreSQL/Redis
already running and reachable.

**Required Slack bot token scopes**: `commands`, `chat:write`, `chat:write.public`, `im:write`,
`files:write`, `channels:read`, `groups:read`, `files:read`, `users:read`. Socket Mode must be
enabled (that's where `SLACK_APP_TOKEN` comes from).

**Known limitation**: the *original* file a sender uploads through the modal's file picker is
Slack's own copy, owned by that user — a bot token can never delete another user's file,
regardless of scopes. The bot's own re-delivered copy (what the viewer actually sees) is fully
deletable and is cleaned up on Hide/Revoke/expiry; the sender's original upload persists in
Slack's storage under your workspace's own retention policy. Fixing that for real would need a
per-user OAuth `files:write` consent flow, which isn't built.

---

## 🔮 Future Scope

### Hardening & Admin

- [ ] Rate limiting on `/secret`
- [ ] Admin dashboard / audit log
- [ ] Alerting on failed deletes, job monitoring for stuck/failed BullMQ jobs
- [ ] Metrics (Prometheus)
- [ ] Per-user OAuth flow so a sender's own original file upload can also be deleted (see Known limitation above)
- [ ] Reconcile `.env`'s unused `FILE_SIZE_MAX`/`AV_ENABLED` with the config actually in effect

### Technical Improvements

- [ ] Testing — `vitest` is configured, nothing has been written yet
- [ ] Type Safety — remove remaining `any` casts, retire the unused `src/slack/types.ts` payload types
- [ ] CI/CD — GitHub Actions for lint, test, build, deploy
- [ ] Error Tracking — Sentry integration for production errors

---

## 📋 Changelog

### Unreleased

**Removed unimplemented/abandoned feature remnants**

`/secret @person` and `/secret #channel-name` (targeting a recipient or channel via slash-command
argument text, instead of picking one from the modal) were speced out and partially scaffolded but
never actually wired in, and are not coming — recipients/channels are always picked inside the
modal. Removed `src/bot/multi-viewer.ts` (the unwired scaffolding) entirely, and the README section
that described it as upcoming.

Also cleaned up two smaller abandoned-feature remnants that were actively misleading (present in
config/docs as if functional, doing nothing):
- Age-encrypted master key with a passphrase was never implemented (the key is a raw file) — removed
  the unused `MASTER_KEY_PASSPHRASE` env var and fixed `MASTER_KEY_FILE`'s default/example, which
  pointed at a `.age` path `generate-key.ts` never produces.
- Removed the `ephemeral_ts`/`response_url` fields from the `views` row type — leftover from the
  abandoned ephemeral-message delivery approach (see v1.1.0 below), never read or written by any
  live code.

🐛 **Fixed: file-only secrets had no Hide Secret button.** `files.uploadV2` has no way to attach
interactive blocks to a file-share message, so a secret with only a file (no text) produced a
reveal with zero buttons anywhere. Now sends a small companion message with the Hide Secret button
right below the file when there's no text message to carry it.

### v1.1.0 (2026-07-30)

**File support, cleanup-correctness overhaul, and deployment automation**

- ✅ File and combined (text+file) secrets — encryption, AV scanning, upload, and delivery
- ✅ Reveals moved from Slack "ephemeral" messages to real bot-owned DMs, so Hide/Revoke/auto-delete
  actually work (ephemeral messages can't be deleted outside a live click on them)
- ✅ View-once is now per-viewer (sender and recipient each get their own), not a global secret-level flag
- ✅ Hide-then-re-open within the original window, "Secret Expired" after it
- ✅ Revoke and natural expiry now run the exact same full teardown routine (`purgeSecret`)
- ✅ Background sweeps for secrets/views nobody ever interacted with
- ✅ Viewed By timestamps in IST, delivered as a trackable message instead of an untrackable ephemeral
- ✅ Delivered file copies are fully purged (`files.delete`), not just their sharing message
- ✅ `install.sh` — one-command setup for a fresh clone
- 🐛 Fixed: `bin/migrate.ts` only ever ran migration `001`; now runs all of them in order
- 🐛 Fixed: `src/index.ts` passed `null` repos into the background workers, crashing the auto-delete job on every run
- 🐛 Fixed: the modal's file picker had no `action_id`, so uploaded files were silently invisible to the handler

### v1.0.0 (2026-07-28)

**Initial MVP Release**

- ✅ Text-only secret sharing with single-viewer DM
- ✅ Envelope encryption with libsodium XSalsa20-Poly1305
- ✅ PostgreSQL for persistent state
- ✅ BullMQ + Redis for delayed jobs
- ✅ 3-button interface (View, Viewed By, Revoke)
- ✅ Hide Secret button for instant deletion
- ✅ Permanent channel announcement
- ✅ Auto-delete after 5 minutes (configurable)
- ✅ Hot-reload config without restart
- ✅ Double-view guard via UNIQUE constraint
- ✅ Hard-delete on revoke
- ✅ Viewed By list for sender
- ✅ Master key generation utility
- ✅ Database migration runner
- ✅ Systemd service template

---

## 🐛 Bug Tracker

See [bug-tracker.csv](./bug-tracker.csv) for full history of bugs and fixes.

---

## 📝 License

Private - All rights reserved.

---

## 🤝 Contributing

This is a private project. For questions or issues, contact the maintainer.

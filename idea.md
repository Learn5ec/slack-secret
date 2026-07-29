# Secret-Bot: Technical Plan
### Self-destructing secrets & files for Slack (view-once / download-once, per-user)

---

## 1. Product Summary

A Slack app that lets any user share a **text secret** or **file** privately and ephemerally:

- Sender: `/secret` slash command → modal with text field + file upload.
- Bot posts a **placeholder message** (no plaintext, no file) in the DM/group/channel.
- Each authorized viewer can reveal/download **once**.
- Delivered content **auto-deletes 5 minutes** after being revealed.
- Undelivered secrets **expire after 1 hour** and are purged.
- Works identically in 1:1 DMs, group DMs, and channels (with per-user tracking in the multi-viewer case).

**Explicit non-goal:** hiding content from Slack's own backend/compliance tooling (Discovery API, org exports) or from workspace admins. This system prevents *casual/permanent visibility to other members and the channel history* — it does not defeat Enterprise Grid compliance retention, which is outside any Slack app's control. This is a deliberate, agreed tradeoff (per your last message) — the audience for this tool is "keep secrets from lingering in channel history for years," not "keep secrets from admins."

**Deployment target (updated):** fully self-hosted on a local machine (Kali Linux box), no cloud provider (no AWS/GCS) required at all. All storage, encryption keys, and the app process itself live on your local system. Slack talks to your bot over an **outbound-only** WebSocket connection (Socket Mode — see §3.6), so you don't need a public IP, port forwarding, or a reverse proxy exposed to the internet. Practical implication: the bot is only reachable/functional while your Kali machine is powered on and the process is running — worth running it as a `systemd` service so it survives reboots (see §11.1).

**New recipient targeting:** in addition to `/secret @user`, support `/secret #channel-name` — sends the secret to a specific channel (bot must be a member of that channel, or you request the `chat:write.public` scope to post into public channels without being invited — see §3.2).

---

## 2. Architecture Overview

```
                     ┌─────────────────────┐
   Slack Workspace   │   Slack Platform     │
   (users)  ────────▶│  (Commands, Modals,  │
                     │   Interactivity)     │
                     └──────────┬───────────┘
                                │ Outbound WebSocket (Socket Mode)
                                │ — no inbound port, no public IP needed
                                ▼
              ┌───────────────────────────────┐
              │   Kali Linux box (local)       │
              │  ┌─────────────────────────┐  │
              │  │  App Backend (Bolt.js)   │  │
              │  │  - Slash command hdlr    │  │
              │  │  - Modal submit hdlr     │  │
              │  │  - Button click hdlr     │  │
              │  └──┬───────────┬───────────┘  │
              │     │           │              │
              │ ┌───▼───┐   ┌──▼──────┐        │
              │ │Postgres│   │ Redis   │        │
              │ │(local) │   │ (local) │        │
              │ └────────┘   └─────────┘        │
              │     │                           │
              │ ┌───▼─────────────────────┐     │
              │ │ Local encrypted storage  │     │
              │ │ dir (LUKS/gocryptfs      │     │
              │ │ volume) for files        │     │
              │ └──────────────────────────┘     │
              │     │                           │
              │ ┌───▼─────────────────────┐     │
              │ │ Local keyfile / age or   │     │
              │ │ gpg-encrypted master key │     │
              │ └──────────────────────────┘     │
              │     │                           │
              │ ┌───▼─────────────────────┐     │
              │ │ BullMQ worker (Redis-    │     │
              │ │ backed delete-at-T jobs) │     │
              │ └──────────────────────────┘     │
              │                                 │
              │  Run as a systemd service so     │
              │  it survives reboots             │
              └───────────────────────────────┘
```

**Why this stack (local-only, no AWS/GCP):**
- **Bolt.js + Socket Mode** — official Slack SDK; Socket Mode means your Kali box never needs to accept inbound connections, so no port forwarding, no ngrok, no public DNS/TLS cert to manage.
- **Postgres** (local install, e.g. `apt install postgresql`) — source of truth for who-viewed-what (needs real transactions to avoid double-reveal races).
- **Redis** (local install, e.g. `apt install redis-server`) — natural fit for the 1-hour "pending secret" TTL (native `EXPIRE`) and for a lightweight job queue (BullMQ) for the 5-minute delete timers.
- **Local encrypted storage directory** instead of S3/GCS — files never leave the machine. Recommended: a **LUKS-encrypted partition/volume** or a **gocryptfs**/**age**-encrypted directory mounted at rest, so even raw disk access doesn't expose plaintext files, on top of the application-layer envelope encryption in §6.

---

## 3. Slack App Configuration

### 3.1 App-level setup
- Create app at api.slack.com/apps → "From scratch."
- Enable **Socket Mode** for dev (no public URL needed) or standard **HTTP Request URL** for production (recommended for prod — lower latency, easier horizontal scaling).

### 3.2 OAuth Scopes (Bot Token)
| Scope | Purpose |
|---|---|
| `commands` | Register `/secret` slash command |
| `chat:write` | Post/update placeholder messages, post into channels the bot is already a member of |
| `chat:write.public` | **Resolved:** post into a **public** channel the bot hasn't been invited to yet, so `/secret #channel-name` works there without a manual invite step. Private channels are never covered by this scope — Slack has no scope that bypasses membership for private channels, by design, so those always require `/invite @secret-bot` first (see §3.3). |
| `im:write` | Open/DM the recipient the revealed content |
| `im:history` | Read DM context if needed |
| `channels:read`, `groups:read` | Resolve channel/group metadata, incl. `#channel-name` → channel ID and public/private status when parsing `/secret #channel ...` |
| `files:read` | Read uploaded file bytes via modal `file_input` |
| `files:write` | Re-upload files to a specific user's DM on reveal, and delete them after |
| `users:read` | Resolve display names for placeholder text |

### 3.3 Slash Command
- `/secret` — no args required (opens modal).
- `/secret @user <optional text>` — pre-fills a named recipient (DM-style, `single` visibility mode).
- `/secret #channel-name <optional text>` — pre-fills a target channel; posts the placeholder there instead of wherever the command was run from, with `multi` visibility mode (anyone in that channel can claim their own view) unless you also combine it with a named user.
- Parsing note: Slack sends channel mentions in slash command text as `<#C0123ABCD|channel-name>` — parse the channel ID out of that raw format rather than trying to resolve the display name yourself; same pattern for `<@U0123ABCD>` on user mentions.
- **Resolved bot-membership rule** for `/secret #channel-name`: call `conversations.info` on the resolved channel ID to check `is_private` and `is_member`:
  - **Public channel, bot not yet a member** → post the placeholder anyway via `chat:write.public` — no invite needed, works immediately.
  - **Private channel, bot not a member** → reject with an ephemeral message: "I need to be in that channel first — run `/invite @secret-bot` there, then try again." (No scope exists to bypass this for private channels, so this is a hard requirement, not a preference.)
  - Either type, bot already a member → post normally via `chat:write`.

### 3.4 Interactivity & Modals
- Enable **Interactivity & Shortcuts**. With Socket Mode (see §3.6), you do **not** set a public Request URL — Bolt receives interactivity payloads over the same WebSocket connection.
- Modal must include a `file_input` block (Slack Block Kit) — this is what lets users attach files directly in the modal, no separate upload step.

### 3.5 Event Subscriptions
- Not strictly required for the core flow (Option A avoids passive file-share events entirely), but subscribe to `app_uninstalled` and `tokens_revoked` at minimum for cleanup hygiene — still delivered over the Socket Mode connection, no public endpoint needed.

### 3.6 Socket Mode (for local-only hosting — no AWS, no public URL)
Since everything runs on your Kali box with no cloud infra, use **Socket Mode** instead of the classic HTTP Request URL approach:
- Enable Socket Mode in the app config, generate an **app-level token** (`xapp-...`, scope `connections:write`).
- Your Bolt app opens an **outbound** WebSocket connection to Slack — no inbound port needs to be open on your machine, no ngrok/Cloudflare Tunnel, no port forwarding on your router.
- This is genuinely the right fit for your setup: it works identically for slash commands, modals, `view_submission`, and `block_actions` interactivity — the only thing Socket Mode can't do is serve OAuth install redirects for a public multi-workspace install flow, which is irrelevant here since this is a single-workspace internal tool.
- Tradeoff: the bot is only live while your machine + process are up. No tradeoff regarding *functionality* — just availability, which you already flagged as acceptable.

---

## 4. Data Model

### Postgres — durable, transactional truth
```sql
CREATE TABLE secrets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id         TEXT NOT NULL,             -- Slack user ID
  origin_channel_id TEXT NOT NULL,             -- where placeholder was posted (resolved from @user DM, or #channel-name target)
  origin_ts         TEXT NOT NULL,             -- placeholder message ts (for chat.update)
  type              TEXT NOT NULL CHECK (type IN ('text','file')),
  ciphertext        BYTEA,                     -- for type='text'
  iv                BYTEA,
  file_path         TEXT,                      -- for type='file', path on local encrypted volume/dir
  file_name         TEXT,
  file_size_bytes   BIGINT,
  allowed_viewer_id TEXT,                      -- NULL = anyone in channel/DM except sender
  visibility_mode   TEXT NOT NULL DEFAULT 'single' CHECK (visibility_mode IN ('single','multi')),
                                                -- single = one viewer total; multi = one view per person
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','expired','cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL       -- created_at + 1 hour, undelivered TTL.
                                                -- NOTE: ciphertext/file is retained for the FULL 1-hour
                                                -- window even after a recipient has consumed it (status='consumed'),
                                                -- specifically so the sender can keep re-viewing their own
                                                -- sent secret until expires_at or cancellation. Only the
                                                -- expiry sweep (§9.4) or an explicit Cancel (§5.5) purge it early.
);

CREATE TABLE views (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id     UUID NOT NULL REFERENCES secrets(id),
  viewer_id     TEXT NOT NULL,
  dm_channel_id TEXT,                -- bot<->viewer DM channel
  dm_ts         TEXT,                -- delivered message ts (for chat.delete)
  delivered_at  TIMESTAMPTZ,
  delete_at     TIMESTAMPTZ,         -- delivered_at + 5 minutes
  status        TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','deleted','failed')),
  UNIQUE (secret_id, viewer_id)      -- hard DB-level guarantee: one view per (secret, viewer)
);

CREATE INDEX idx_views_delete_at ON views (delete_at) WHERE status = 'delivered';
CREATE INDEX idx_secrets_expiry ON secrets (expires_at) WHERE status = 'pending';
```

The `UNIQUE (secret_id, viewer_id)` constraint is your **real** double-view guard — enforce the "already viewed" check with an `INSERT ... ON CONFLICT DO NOTHING` and inspect the row count, not a prior `SELECT` (avoids the classic check-then-act race condition when two clicks land near-simultaneously).

### Redis — ephemeral/fast layer
- `secret:pending:{id}` → set with `EX 3600` mirroring the Postgres row, used for fast existence checks without hitting Postgres on every click.
- BullMQ queues: `delete-dm-message`, `purge-expired-secret` — durable, Redis-backed, survive process restarts (unlike in-memory `setTimeout`).

---

## 5. Core Flows

### 5.1 Sending (text or file)

1. User runs `/secret` (optionally `/secret @bob`).
2. Bolt opens a modal (`views.open`) with:
   - Optional recipient picker (`users_select`), pre-filled if `@bob` was passed.
   - `plain_text_input` (multiline) for a text secret.
   - `file_input` block for attachment(s).
3. On submit (`view_submission`):
   - Validate: at least one of {text, file} present; file size under your cap (e.g. 25MB); if file, run AV scan (see §7) before anything else.
   - **Text**: generate random 256-bit key via envelope encryption (see §6), encrypt, store ciphertext+IV in `secrets`.
   - **File**: download bytes via `files.info` → `url_private_download` (bot token auth header required), encrypt, write to the local encrypted storage directory, store the file path; then immediately call `files.delete` on the Slack-side copy that the modal upload created — this closes the "second undeleted copy sitting on Slack's file storage" gap.
   - Insert `secrets` row, `expires_at = now() + 1h`.
   - **Determine placeholder destination** (this is where the DM-routing rule matters):
     - If a single named recipient was given (`/secret @bob ...`, or `/secret #channel @bob ...`) → `visibility_mode = 'single'`, `allowed_viewer_id = bob`, and the placeholder is posted via `conversations.open` + `chat.postMessage` into the **bot↔Bob DM**, regardless of whether the command was run in a channel, group, or DM. The originating channel/group sees nothing at all — not even a placeholder — so non-recipients never learn a secret exists.
     - If no recipient was given (`/secret ...` in a channel/group, or `/secret #channel-name ...`) → `visibility_mode = 'multi'`, `allowed_viewer_id = NULL`, and the placeholder is posted into that **channel/group** as before, since it's intentionally visible to everyone there.
   - Post the placeholder to whichever destination was resolved above, with **three** Block Kit buttons (`value` = `secret.id` on all three):
     - **"🔓 View Secret"** — the reveal action, behavior depends on who clicks (see §5.2 for non-sender viewers, §5.5 for the sender's own click).
     - **"👁 Viewed By"** — sender-only; see §5.5.
     - **"🗑 Cancel"** — sender-only; see §5.5.
     Slack renders the same three buttons to everyone who can see the placeholder (there's no per-user message variant — see the earlier discussion on why channel messages can't differ per viewer), so the *access control* for the latter two happens in your action handler, not in what's rendered: non-sender clicks on "Viewed By" or "Cancel" get an ephemeral "Only the sender can do this." Store the resulting `channel_id`/`ts` back into `origin_channel_id`/`origin_ts`.
   - Schedule a `purge-expired-secret` job for `expires_at`.

### 5.2 Reveal / Download (per-user, single or multi viewer) — for non-sender viewers

> If the clicking `user.id` equals the secret's `sender_id`, do **not** run this flow — route to §5.5 instead (unlimited self-view, no consumption, no `views` row). The check for "is this the sender" happens first, before any of the logic below.

1. User clicks "View Secret" → Slack sends a **signed** `block_actions` interactivity payload containing `user.id` (trustworthy — Slack's signature, verified via your signing secret, is your identity proof; no extra verification step needed).
2. Backend transaction:
   ```sql
   -- reject if secret expired/consumed (single-mode) up front
   SELECT status, visibility_mode, allowed_viewer_id FROM secrets WHERE id = $1 FOR UPDATE;
   ```
   - If `status != 'pending'` and mode is `single` → respond ephemeral "This secret is no longer available."
   - If `allowed_viewer_id` is set and doesn't match clicking user → ephemeral "This wasn't sent to you."
   - Attempt `INSERT INTO views (secret_id, viewer_id, ...) VALUES (...) ON CONFLICT (secret_id, viewer_id) DO NOTHING RETURNING id`.
     - 0 rows returned → already viewed by this user → ephemeral "You've already viewed this."
     - 1 row returned → proceed to deliver.
   - If `visibility_mode = 'single'`, also mark `secrets.status = 'consumed'` in the same transaction (only one person, period, gets it).
3. Deliver:
   - `conversations.open` with the viewer → get/open bot↔viewer DM channel.
   - **Text**: decrypt, `chat.postMessage` the plaintext into that DM.
   - **File**: decrypt from the local encrypted storage path in memory, `files.uploadV2` targeted at that DM channel.
   - Record `dm_channel_id`, `dm_ts`, `delivered_at = now()`, `delete_at = now() + 5m` on the `views` row.
   - Enqueue a `delete-dm-message` job for `delete_at`.
4. Update the original placeholder via `chat.update`:
   - Single mode: "🔓 Secret viewed." (button removed/disabled — don't name the viewer publicly either, since who-viewed is sender-only info per §5.5; the sender can still see who via "Viewed By.")
   - Multi mode: increment a visible counter only, e.g. "🔒 Secret from Alice — viewed by 2 people so far" (button stays active for others). Do **not** print viewer names in the public placeholder — names are sender-only information, retrievable exclusively via the "Viewed By" button (§5.5).

### 5.3 Scheduled Deletion (5-minute worker)

- A BullMQ worker (or a simple cron poller every 15–30s as a lower-infra fallback) picks up due `delete-dm-message` jobs:
  - `chat.delete({channel: dm_channel_id, ts: dm_ts})` — bot authored this message, so deletion is unrestricted.
  - If file: also `files.delete` the re-uploaded copy if it wasn't already covered by the message deletion (uploaded files attached to a message are generally removed alongside it, but explicitly confirm/handle via `files.delete` for certainty).
  - Update `views.status = 'deleted'`.
  - **Retry policy**: on transient failure (rate limit, network), retry with backoff (BullMQ built-in); log persistent failures to an alerting channel — don't fail silently, since a stuck secret is a real leak.

### 5.4 Expiry Sweep (undelivered secrets)

- Worker checks `secrets WHERE status='pending' AND expires_at < now()` every minute (or rely on Redis key expiry + a keyspace-notification listener for near-real-time cleanup):
  - Delete the local encrypted file if file type (`fs.unlink` on the storage path).
  - Set `status = 'expired'`.
  - `chat.update` placeholder to "🔒 This secret expired, unopened." and disable the button.
  - **Note**: this sweep only touches secrets still in `pending` status (never claimed). Secrets in `consumed` status (already delivered to a recipient) are deliberately *not* purged by this sweep — they're kept until `expires_at` specifically so the sender can keep self-viewing them (§5.5). A second pass of the same sweep query, `WHERE status='consumed' AND expires_at < now()`, purges those once the full 1-hour window is actually up.

### 5.5 Sender-Only Controls: Self-View, Viewed-By, Cancel

These three behaviors are all gated on `clicking_user.id === secret.sender_id`; any non-sender click on the latter two buttons gets an ephemeral "Only the sender can do this."

**Self-view ("View Secret" clicked by the sender)**
- Unlike a normal recipient reveal, this does **not** touch the `views` table, does **not** consume a single-mode slot, and does **not** start a 5-minute delete timer — it's simply the sender checking what they sent.
- Available repeatedly, as many times as needed, for as long as the secret row exists (`status` in `('pending','consumed')`) — i.e. up to the full 1-hour `expires_at` window, regardless of whether a real recipient has already claimed their one view.
- Implementation: on click, verify sender identity, decrypt in-memory, and show the content via `views.open` (a modal) — using a modal rather than an ephemeral message here too, for the same reasons as the recipient flow (ephemeral messages can't be reliably force-closed, and a modal gives a cleaner "closed when done" feel). Nothing is written to the `views` table for these opens; optionally log a lightweight `sender_self_view_count` on the `secrets` row for your own debugging, but it has no effect on access control.
- Blocked once `status IN ('expired','cancelled')` — same ephemeral "no longer available" response as a recipient would get.

**"Viewed By" (sender-only)**
- On click (sender only — see gate above), query `views` for this `secret_id` and respond with an **ephemeral message** (visible only to the sender) listing viewer display names + `delivered_at` timestamps, e.g.:
  ```
  👁 Viewed by:
  • Bob — 2:14 PM
  • Carol — 2:31 PM
  ```
- This is the *only* place viewer identities are ever surfaced — never in the public placeholder text (per the §5.2 step-4 fix above), so a channel full of people never learns who else looked at a shared secret; only the sender gets that visibility.

**"Cancel" (sender-only, full revocation)**
- On click (sender only): this is a **hard, immediate teardown** of the secret across every surface it touched, at any point during its lifetime (whether zero people have viewed it yet, or several already have) — not just a pre-view "undo send."
- Steps, in a single transaction where possible:
  1. Verify `clicking_user.id === secret.sender_id`; else ephemeral reject.
  2. Look up all rows in `views` for this `secret_id` with `status = 'delivered'` (i.e., copies currently sitting in some recipient's DM, not yet auto-deleted).
  3. For each such row: `chat.delete({channel: dm_channel_id, ts: dm_ts})` — removes it from that recipient's DM immediately. Tolerate `message_not_found` gracefully (may have already auto-deleted via the 5-minute timer racing with the cancel click).
  4. `chat.delete` the origin placeholder itself (in whichever channel/DM it lives, per §5.1's routing rule) — removing it from wherever the sender or channel would otherwise still see it.
  5. Remove any encrypted file from local storage (`fs.unlink`), if `type = 'file'`.
  6. **Hard-delete** the `secrets` row and all associated `views` rows from Postgres — per the requirement that a cancelled secret is gone "from sender chat, receiver chat, as well as the database," this is a real `DELETE`, not a soft `status='cancelled'` flag left lingering. (A soft-delete audit trail would work equally well technically, but a full hard delete is what was asked for, so that's the default here — flag this to me if you'd actually prefer to keep a minimal cancelled-record for your own debugging/audit purposes instead.)
  7. Remove any pending BullMQ jobs for this secret (`delete-dm-message` for each view, `purge-expired-secret`) so nothing tries to act on a row that no longer exists.

---

## 6. Encryption Design

Two layers, deliberately redundant:

1. **Disk-level at rest**: LUKS-encrypted volume or gocryptfs-encrypted directory holding the local storage path — protects against someone pulling the raw disk/laptop theft scenario.
2. **Application-layer envelope encryption** (the layer that matters for "even a DB dump/disk copy doesn't leak plaintext"), fully local — no cloud KMS needed:
   - Master key generated once (`openssl rand -base64 32` or similar), stored **encrypted at rest** using `age` or `gpg` with a passphrase you enter when the service starts (or a keyfile with strict `chmod 600` permissions, owned by the service user only, on a separate disk/partition from the data if possible). **Never** commit it to git, never put the raw key in a plaintext `.env` file that gets backed up unencrypted.
   - Per-secret: generate a random data key, encrypt content with AES-256-GCM (authenticated encryption — protects integrity too, not just confidentiality), encrypt the data key itself with the master key (standard envelope pattern), store only the encrypted data key + ciphertext + IV/nonce in Postgres (text) or alongside the file on the encrypted volume (files).
   - Decrypt only in-memory, only at the moment of delivery, never logged.
   - Practical local-only option: `libsodium`'s `crypto_secretbox` (via `tweetnacl`/`libsodium-wrappers` npm packages) is a simpler, well-audited alternative to hand-rolling AES-GCM if you want fewer moving parts — either is fine for this threat model.

**Logging discipline (non-negotiable):**
- Structured logging only, with an explicit denylist/allowlist ensuring `ciphertext`, decrypted plaintext, and file bytes are never serialized into logs, error traces, or APM breadcrumbs (Sentry/Datadog). Log IDs and status transitions, not content.

---

## 7. File-Specific Handling

- **Size cap**: enforce at modal-validation time (reject with a clear `response_action: "errors"` on the view, not a silent failure) — e.g. 25MB, aligned with your infra/Slack limits.
- **AV scanning**: run uploaded bytes through ClamAV (self-hosted, cheap) or a cloud AV API before encrypting/storing — this is now a general internal file-relay, so treat it like one.
- **MIME/type checks**: reject executables (`.exe`, `.sh`, `.bat`, etc.) by default unless you deliberately want to allow them; sanity-check declared vs actual content type.
- **Preview/thumbnail caveat**: re-uploading via `files.uploadV2` lets Slack's backend generate previews server-side momentarily — same admin/backend-visibility caveat as text, just noting it applies here too (already an accepted tradeoff per your last message).

---

## 8. Channel vs DM Behavior Summary

| Context | Placeholder destination | `allowed_viewer_id` | `visibility_mode` | Placeholder update on view |
|---|---|---|---|---|
| 1:1 DM, no recipient needed (implicit) | that DM | the other person | `single` | "Bob viewed the secret" — done |
| Named recipient, run from anywhere (`/secret @bob ...`, incl. from inside a channel/group) | **bot↔Bob DM only** — never the originating channel | Bob's ID | `single` | Posted straight into Bob's DM; only Bob sees it exists at all |
| Open channel/group, anyone can view (`/secret ...`, no `@user`) | that channel/group | `NULL` | `multi` | Each clicker gets their own DM + timer; list grows |
| `/secret #channel-name ...` (no `@user`) | the named channel | `NULL` | `multi` | Placeholder posted in that channel; anyone there can claim their own view, same as row above |
| `/secret #channel-name @bob ...` (both given) | **bot↔Bob DM only** — not `#channel-name` | Bob's ID | `single` | Same as the "named recipient" row — naming a channel doesn't override the DM-only rule once a specific person is named |

This maps directly onto the schema in §4 — no special-casing needed in code beyond branching on `visibility_mode`.

---

## 9. Edge Cases & Failure Modes

| Scenario | Handling |
|---|---|
| Two clicks land within milliseconds (double-click, or two browser tabs) | DB unique constraint (`ON CONFLICT DO NOTHING`) is the real guard — first write wins, second sees 0 rows affected. |
| Worker/server restarts mid-flight | All timers are DB/Redis-backed jobs (BullMQ), not in-process — they survive restarts and get replayed. |
| `chat.delete` fails (rate limited, network blip) | BullMQ automatic retry w/ exponential backoff; alert after N failed attempts (Slack webhook to an ops channel, or PagerDuty). |
| User deletes the DM themselves before the 5-min timer | Deletion job should tolerate `message_not_found` gracefully (already gone — treat as success, not error). |
| Sender leaves the workspace before secret is claimed | Expiry sweep still purges it normally at the 1-hour mark; no special handling needed since it's keyed by ID, not live user session. |
| Recipient is a bot/deactivated user | Reject at reveal-time if `users.info` shows deactivated/is_bot — ephemeral error to whoever clicked. |
| Someone forwards a screenshot of the revealed content | Out of scope — same limitation WhatsApp view-once has; this system enforces *access*, not *retention after viewing*. Set this expectation with the team. |

---

## 10. Rollout Plan (Phased)

**Phase 1 — MVP (text only, single-viewer DM)**
- `/secret` → modal (text only) → placeholder → reveal-once → 5-min delete.
- No file support yet, no multi-viewer channel mode.
- Goal: validate the core reveal/delete mechanics and Slack API rate limits in your actual workspace.

**Phase 2 — Files**
- Add `file_input` to modal, S3/GCS pipeline, AV scan, envelope encryption for files.

**Phase 3 — Channel multi-viewer mode**
- `visibility_mode='multi'`, running "viewed by" list, per-user DB tracking.

**Phase 4 — Hardening**
- Alerting on failed deletes, admin dashboard (internal, for your own visibility into stuck jobs — not for viewing secret content), rate limiting on `/secret` to prevent abuse/spam.

### 10.1 Local Hosting Setup (Kali Linux, no cloud)

1. **Install dependencies**:
   ```bash
   sudo apt update
   sudo apt install postgresql redis-server clamav nodejs npm
   sudo systemctl enable --now postgresql redis-server
   ```
2. **Create the Postgres DB/user** for the app (standard `createuser`/`createdb`, local trust or password auth over `localhost` only — no need to expose Postgres beyond `127.0.0.1`).
3. **Set up encrypted storage volume** for files, one of:
   - `gocryptfs` (simplest, no partition resizing): create a cipher dir + mount point, mount on service start.
   - Or a LUKS-encrypted partition/loop file if you want block-level encryption instead.
4. **Generate and lock the master key**:
   ```bash
   openssl rand -base64 32 > master.key
   age -p -o master.key.age master.key   # passphrase-encrypt it
   shred -u master.key                    # remove the plaintext copy
   ```
   Your app decrypts `master.key.age` once at startup (prompting for the passphrase, or reading it from an env var you set manually each time you start the service — avoid auto-unlock scripts that store the passphrase in plaintext anywhere).
5. **Slack app config**: enable Socket Mode, generate the app-level token (`xapp-...`) and bot token (`xoxb-...`); store both in a local `.env` file with `chmod 600`, excluded via `.gitignore` if you ever put this in a repo.
6. **Run as a systemd service** so it survives reboots/crashes:
   ```ini
   # /etc/systemd/system/secret-bot.service
   [Unit]
   Description=Slack Secret Bot
   After=network.target postgresql.service redis-server.service

   [Service]
   Type=simple
   User=secretbot
   WorkingDirectory=/opt/secret-bot
   ExecStartPre=/opt/secret-bot/scripts/mount-encrypted-storage.sh
   ExecStart=/usr/bin/node /opt/secret-bot/dist/index.js
   Restart=on-failure
   EnvironmentFile=/opt/secret-bot/.env

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now secret-bot
   journalctl -u secret-bot -f   # tail logs
   ```
7. **Backups**: since there's no cloud redundancy, decide explicitly whether you want any backup of the Postgres DB/encrypted volume — even a simple encrypted `pg_dump` to an external drive on a schedule — or whether "no durability beyond this one machine" is acceptable for a low-stakes meme/secret-sharing tool (likely fine, just worth deciding consciously rather than by default).
8. **Availability caveat, restated**: the bot is only responsive while this machine is on, network-connected, and the service is running — Socket Mode's outbound connection reconnects automatically on network blips, but obviously not if the machine itself is off or asleep.

---

## 11. Suggested Tech Stack Recap

| Layer | Choice | Why |
|---|---|---|
| Bot framework | Bolt.js (Node/TypeScript) + **Socket Mode** | Official SDK, handles signing/verification, modals, interactivity — Socket Mode avoids needing any public URL/port forwarding on your Kali box |
| DB | PostgreSQL, installed locally via `apt` | Transactional guarantees for the one-view-per-user constraint |
| Cache/Queue | Redis + BullMQ, installed locally via `apt` | TTL for pending secrets, durable delayed jobs for deletion — durable across process restarts even with no cloud involved |
| File storage | Local directory on a LUKS or gocryptfs-encrypted volume | Files never leave the machine; encrypted at the filesystem layer plus application-layer envelope encryption |
| Secrets/keys | Local master key, `age`- or `gpg`-encrypted at rest, entered/unlocked at service start | No cloud KMS needed; equivalent protection for a single-machine, single-workspace tool |
| Hosting | `systemd` service on the Kali box itself | Keeps the process running across reboots/crashes; `journalctl` gives you logs for free (see §11.1) |
| AV scanning | ClamAV (`apt install clamav`, fully local) | Basic hygiene for the file-relay use case, no external API dependency |

---

## 12. Design Decisions (Finalized)

All the open product calls from earlier drafts are now resolved. Recap, with pointers to where each is implemented:

1. **Named-recipient routing** — `/secret @bob ...` always delivers the placeholder as a **DM to Bob only**, regardless of where the command was run (channel, group, or DM). No one else ever sees a placeholder exists. → §5.1, §8.
2. **"Viewed by" visibility** — viewer identities are **sender-only** information, surfaced exclusively via the ephemeral "Viewed By" button; the public placeholder (in multi-mode) shows only a numeric count, never names. The sender can also re-open their own sent secret ("View Secret") **as many times as needed for the full 1-hour retention window**, independent of whether a recipient has already claimed their one view. → §5.5.
3. **Cancel** — sender-only button that immediately deletes the secret everywhere it exists: any already-delivered copies in recipient DMs, the origin placeholder itself, the encrypted file (if any), and a **hard delete** of the database rows (not a soft status flag) — plus cancellation of any pending scheduled jobs for that secret. → §5.5.
4. **`/secret #channel-name` bot-membership rule** — public channels: auto-post via `chat:write.public`, no invite required. Private channels: always require `/invite @secret-bot` first — no scope exists to bypass this, so it's enforced as a hard requirement, not a fallback preference. → §3.2, §3.3.

Happy to turn any of these sections into working Bolt.js code next — I'd suggest starting with Phase 1 (text-only MVP) so you can test the reveal/self-view/cancel mechanics in a real workspace before layering on files.
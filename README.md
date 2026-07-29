# Secret Bot - Slack View-Once Secrets

A Slack bot that lets users share text secrets privately with view-once, download-once, and auto-delete behavior.

## 🚀 Features Implemented (Sprint 1 - MVP)

### Core Functionality

- **Slash Command**: `/secret` opens a modal to share secrets
- **Text Secrets**: Share encrypted text messages (up to 3000 characters)
- **Single Viewer Mode**: Send secrets to one specific user via DM
- **Multi Viewer Mode**: Share secrets with anyone (no recipient specified)

### Encryption & Security

- **Envelope Encryption**: Per-secret 256-bit data key encrypted with master key
- **XSalsa20-Poly1305**: Sodium-based authenticated encryption
- **Master Key**: Raw 32-byte key stored at `src/crypto/keys/master.key` with 0600 permissions
- **Double-View Guard**: UNIQUE constraint on `views(secret_id, viewer_id)` prevents re-viewing
- **Auto-Delete**: Messages automatically deleted 5 minutes after viewing (configurable)

### User Experience

- **3-Button Interface**:
  - 🔓 View Secret - Reveals the secret
  - 👁 Viewed By - Shows who has viewed (sender only)
  - 🗑 Revoke - Immediately deletes the secret (sender only)

- **Dynamic Button States**:
  - Before view: All buttons visible
  - After view (recipient): Only "Hide Secret" button
  - After view (sender): "Viewed By" and "Revoke" buttons

- **Hide Secret**: Instant deletion without waiting for 5-minute timer

- **Permanent Announcement**: Channel shows "X sent a secret to Y" permanently
- **Interactive Placeholder**: Gets updated/deleted on actions

### Message Flow

```
1. Sender runs /secret @user in channel
2. Modal opens with recipient picker and text field
3. Secret is encrypted and stored in PostgreSQL
4. Permanent announcement posted in channel: "🔒 sender sent a secret to recipient"
5. Interactive placeholder posted: "[View Secret] [Viewed By] [Revoke]"
6. DM sent to recipient with "View Secret" button only
7. Recipient clicks "View Secret" → text delivered to their DM
8. Placeholder updated to show "Hide Secret" button
9. 5-minute auto-delete timer started
10. Sender can click "Viewed By" to see viewer list
11. Sender can click "Revoke" to delete everything
12. Recipient can click "Hide Secret" to delete instantly
```

### Architecture

- **Framework**: Bolt.js (Node/TypeScript) with Socket Mode
- **Database**: PostgreSQL for persistent state
- **Queue**: BullMQ + Redis for delayed jobs (auto-delete, expiry sweep)
- **Crypto**: libsodium-wrappers for XSalsa20-Poly1305 encryption
- **Logging**: Pino with sensitive data redaction

### Configuration

Dynamic config file at `config/secret-bot-config.json`:

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
    "allow_multi_viewer": true
  },
  "behavior": {
    "sender_sees_buttons": true,
    "recipient_sees_only_view": true,
    "auto_revoke_on_expiry": true,
    "notify_on_cancel": true
  }
}
```

**Hot-reload**: Config changes are picked up within 60 seconds without restarting the bot.

### Database Schema

**secrets table**:
- id (UUID), sender_id, origin_channel_id, origin_ts
- type (text/file), ciphertext, iv, encrypted_data_key
- allowed_viewer_id, visibility_mode (single/multi)
- status (pending/consumed/expired/cancelled)
- created_at, expires_at

**views table**:
- id (UUID), secret_id (FK), viewer_id
- dm_channel_id, dm_ts, delivered_at, delete_at
- status (delivered/deleted/failed)
- UNIQUE(secret_id, viewer_id)

### Deployment

**Systemd Service**: `systemd/secret-bot.service`

**Environment Variables** (`.env`):
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

**Setup**:
```bash
npm install
npx tsx bin/migrate.ts
node bin/gen-key.js
npm run dev
```

---

## 🔮 Future Scope

### Sprint 2: File Secrets

- [ ] **File Upload**: Share encrypted files via modal
- [ ] **File Encryption**: Encrypt file buffers with same envelope scheme
- [ ] **Download-once**: Files can only be downloaded once
- [ ] **AV Scan**: Virus scan before storing files
- [ ] **Slack Files API**: Use `files.uploadV2` and `files.delete`
- [ ] **File Metadata**: Track file_path, file_name, file_size_bytes
- [ ] **Preview**: Show file preview in modal (images, PDFs)

### Sprint 3: Channel Multi-Viewer

- [ ] **Visibility Mode Selector**: Add single/multi picker to modal
- [ ] **Channel Sharing**: Post secrets directly in channels
- [ ] **View Counter**: Show "viewed by N people" in channel
- [ ] **Member Check**: Verify recipient is in channel before sharing
- [ ] **Bulk Share**: Share with multiple channel members at once

### Sprint 4: Hardening & Admin

- [ ] **Rate Limiting**: Limit `/secret` commands per user per minute
- [ ] **Admin Dashboard**: Web UI to view all secrets, views, status
- [ ] **Alerting**: Slack webhook to ops channel on failed deletes
- [ ] **Job Monitoring**: Visibility into stuck/failed BullMQ jobs
- [ ] **Health Check**: `/healthz` endpoint checking Postgres + Redis
- [ ] **Metrics**: Prometheus metrics for views, deletes, errors
- [ ] **Audit Log**: Track all secret operations for compliance
- [ ] **Recipient Privacy**: Respect DM restrictions from privacy settings

### Technical Improvements

- [ ] **Type Safety**: Remove all `any` casts, augment Slack payload types
- [ ] **Testing**: Unit tests for crypto, DB repos, queue processors
- [ ] **Integration Tests**: Full flow tests with testcontainers
- [ ] **E2E Tests**: Bolt handler tests with hand-crafted payloads
- [ ] **CI/CD**: GitHub Actions for lint, test, build, deploy
- [ ] **Error Tracking**: Sentry integration for production errors

---

## 📋 Changelog

### v1.0.0 (2026-07-28)

**Initial MVP Release**

- ✅ Text-only secret sharing with single-viewer DM
- ✅ Envelope encryption with libsodium XSalsa20-Poly1305
- ✅ PostgreSQL for persistent state
- ✅ BullMQ + Redis for delayed jobs
- ✅ 3-button interface (View, Viewed By, Revoke)
- ✅ Dynamic button states after viewing
- ✅ Hide Secret button for instant deletion
- ✅ Permanent channel announcement
- ✅ Auto-delete after 5 minutes (configurable)
- ✅ Hot-reload config without restart
- ✅ Sender self-view with ephemeral messages
- ✅ Recipient DM with view-once behavior
- ✅ Double-view guard via UNIQUE constraint
- ✅ Hard-delete on revoke
- ✅ Viewed By list for sender
- ✅ Proper channel routing (origin channel + recipient DM)
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

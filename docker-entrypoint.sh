#!/bin/bash
set -e

echo "==> Starting Slack Secret Bot container <=="

# 1. Ensure the master encryption key exists (generate once, persist via a mount).
KEYS_DIR="/app/src/crypto/keys"
KEY_PATH="${KEYS_DIR}/master.key"
mkdir -p "$KEYS_DIR"

if [ ! -f "$KEY_PATH" ]; then
    echo "==> Master key not found at ${KEY_PATH}. Generating new 32-byte master key..."
    node -e "const crypto = require('crypto'); const fs = require('fs'); fs.writeFileSync('${KEY_PATH}', crypto.randomBytes(32));"
    chmod 600 "$KEY_PATH"
    echo "==> Master key generated successfully."
else
    echo "==> Existing master key verified at ${KEY_PATH}."
fi

# 2. Ensure storage and log directories exist.
mkdir -p /app/encrypted-storage /app/logs
chmod 700 /app/encrypted-storage

# 3. Make the mounted config visible to the runtime (loaded from dist/config).
if [ -d "/app/config" ]; then
    mkdir -p /app/dist/config
    cp -r /app/config/* /app/dist/config/ 2>/dev/null || true
fi

# 4. Ensure migration SQL is visible to the runtime (loaded from dist/src/db/migrations).
if [ -d "/app/src/db/migrations" ]; then
    mkdir -p /app/dist/src/db/migrations
    cp -r /app/src/db/migrations/* /app/dist/src/db/migrations/ 2>/dev/null || true
fi

# 5. Apply database migrations against the configured (external) Postgres.
echo "==> Running database migrations..."
node dist/bin/migrate.js

# 6. Start the application.
echo "==> Starting bot application..."
exec "$@"

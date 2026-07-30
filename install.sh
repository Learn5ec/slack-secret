#!/usr/bin/env bash
#
# install.sh - Set up secret-bot for local/private-network deployment.
#
# Safe to re-run: it never overwrites an existing .env or master key, and
# every destructive/system-level step asks for confirmation first.
#
# What this does NOT do: create a Slack app for you. You need to create one
# yourself at https://api.slack.com/apps first - see the printed instructions.

set -euo pipefail

# ── Output helpers ────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_BLUE='\033[34m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi
log()   { echo -e "${C_GREEN}==>${C_RESET} $*"; }
info()  { echo -e "    $*"; }
warn()  { echo -e "${C_YELLOW}==> warning:${C_RESET} $*"; }
fail()  { echo -e "${C_RED}==> error:${C_RESET} $*" >&2; }
step()  { echo -e "\n${C_BOLD}${C_BLUE}== $* ==${C_RESET}"; }

ask_yes_no() {
  # ask_yes_no "question" default(y|n)
  local prompt="$1" default="${2:-n}" reply
  local hint="y/N"; [ "$default" = "y" ] && hint="Y/n"
  read -r -p "    $prompt [$hint] " reply || true
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

IS_ROOT=false
[ "$(id -u)" -eq 0 ] && IS_ROOT=true

if $IS_ROOT; then
  warn "Running as root. Privileged steps below (installing system packages, creating the"
  warn "systemd service) will run directly instead of via sudo. Prefer running as a regular"
  warn "user so the bot itself doesn't end up running as root."
  ask_yes_no "Continue anyway?" n || exit 1
fi

HAS_SUDO=false
command -v sudo >/dev/null 2>&1 && HAS_SUDO=true
CAN_ELEVATE=false
{ $IS_ROOT || $HAS_SUDO; } && CAN_ELEVATE=true

# Run a command as root: direct if already root, via sudo otherwise. Used for
# every privileged step below so this script also works inside minimal
# containers that run as root without a sudo binary installed.
as_root() {
  if $IS_ROOT; then
    "$@"
  else
    sudo "$@"
  fi
}

step "1. Checking prerequisites"

OS_ID=""
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release && echo "$ID")"
fi
HAS_APT=false
command -v apt-get >/dev/null 2>&1 && HAS_APT=true

MISSING_CMDS=()
for c in node npm git; do
  command -v "$c" >/dev/null 2>&1 || MISSING_CMDS+=("$c")
done

if [ ${#MISSING_CMDS[@]} -gt 0 ]; then
  fail "Missing required command(s): ${MISSING_CMDS[*]}"
  info "Install Node.js (>=18) and git first, then re-run this script."
  info "See https://nodejs.org/en/download for Node install options."
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js $NODE_MAJOR found, but this project needs Node 18 or newer."
  exit 1
fi
log "Node.js $(node --version), npm $(npm --version), git $(git --version | awk '{print $3}')"

NEED_SYSTEM_PKGS=()
command -v psql        >/dev/null 2>&1 || NEED_SYSTEM_PKGS+=("postgresql")
command -v redis-cli   >/dev/null 2>&1 || NEED_SYSTEM_PKGS+=("redis-server")

if [ ${#NEED_SYSTEM_PKGS[@]} -gt 0 ]; then
  warn "Not found on this machine: ${NEED_SYSTEM_PKGS[*]}"
  if $HAS_APT && $CAN_ELEVATE; then
    if ask_yes_no "Install ${NEED_SYSTEM_PKGS[*]} via apt now?" y; then
      as_root apt-get update
      as_root apt-get install -y "${NEED_SYSTEM_PKGS[@]}"
      as_root systemctl enable --now postgresql 2>/dev/null || true
      as_root systemctl enable --now redis-server 2>/dev/null || true
    else
      warn "Skipping. Make sure PostgreSQL and Redis are reachable before starting the bot."
    fi
  elif $HAS_APT; then
    warn "No way to gain root (no sudo, not running as root) - install these yourself:"
    info "  apt-get install -y ${NEED_SYSTEM_PKGS[*]}"
  else
    warn "No apt-get found (OS: ${OS_ID:-unknown}). Install PostgreSQL and Redis yourself,"
    warn "or point .env at existing/remote instances, then re-run this script."
  fi
else
  log "PostgreSQL client and Redis client found"
fi

if ! command -v clamscan >/dev/null 2>&1; then
  info "ClamAV (clamscan) not found - file uploads will skip AV scanning unless you install it."
  if $HAS_APT && $CAN_ELEVATE && ask_yes_no "Install ClamAV now?" n; then
    as_root apt-get update
    as_root apt-get install -y clamav clamav-daemon
    as_root freshclam || warn "freshclam failed - ClamAV virus definitions may be stale."
  fi
fi
HAVE_CLAMAV=false
command -v clamscan >/dev/null 2>&1 && HAVE_CLAMAV=true

step "2. Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

step "3. Setting up .env"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32
  fi
}

if [ -f .env ]; then
  log ".env already exists - leaving it untouched."
  # shellcheck disable=SC1091
  set -a; source .env; set +a
else
  log "Creating .env"
  POSTGRES_DB_DEFAULT="secret_bot"
  POSTGRES_USER_DEFAULT="secret_bot"
  POSTGRES_PASSWORD="$(gen_secret)"

  echo ""
  info "${C_BOLD}Slack app credentials${C_RESET} - if you haven't created a Slack app yet:"
  info "  1. Go to https://api.slack.com/apps -> Create New App -> From scratch"
  info "  2. Enable Socket Mode (Settings -> Socket Mode) - generates your app-level token (xapp-...)"
  info "  3. Under OAuth & Permissions, add these Bot Token Scopes, then install to workspace:"
  info "       commands, chat:write, chat:write.public, im:write, files:write,"
  info "       channels:read, groups:read, files:read, users:read"
  info "  4. Copy the Bot User OAuth Token (xoxb-...) from OAuth & Permissions"
  info "  5. Copy the Signing Secret from Basic Information"
  info "  6. Your Team/workspace ID (starts with T) is in Basic Information -> App Credentials"
  info "  7. Under Slash Commands, create /secret pointing anywhere (Socket Mode ignores the URL)"
  echo ""
  info "You can leave any of these blank and fill them into .env by hand later."
  echo ""

  read -r -p "    SLACK_APP_TOKEN (xapp-...): " IN_APP_TOKEN || true
  read -r -p "    SLACK_BOT_TOKEN (xoxb-...): " IN_BOT_TOKEN || true
  read -r -p "    SLACK_SIGNING_SECRET: " IN_SIGNING_SECRET || true
  read -r -p "    SLACK_TEAM_ID (T...): " IN_TEAM_ID || true

  AV_ENABLED_DEFAULT="false"
  $HAVE_CLAMAV && AV_ENABLED_DEFAULT="true"

  cat > .env <<ENVEOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Slack ──────────────────────────────────────────
SLACK_APP_TOKEN=${IN_APP_TOKEN:-xapp-REPLACE-ME}
SLACK_BOT_TOKEN=${IN_BOT_TOKEN:-xoxb-REPLACE-ME}
SLACK_SIGNING_SECRET=${IN_SIGNING_SECRET:-REPLACE-ME}
SLACK_TEAM_ID=${IN_TEAM_ID:-T-REPLACE-ME}

# ── Database ───────────────────────────────────────
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=${POSTGRES_DB_DEFAULT}
POSTGRES_USER=${POSTGRES_USER_DEFAULT}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ── Redis ──────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── Encryption ─────────────────────────────────────
# Raw random key file generated by "npm run gen-key" - not passphrase-protected
# (age-encryption was planned but never implemented; there's no passphrase to set).
MASTER_KEY_FILE=./src/crypto/keys/master.key

# ── App ────────────────────────────────────────────
LOG_LEVEL=info
HEALTH_PORT=9090
# NOTE: the file size limit actually enforced today is config/secret-bot-config.json's
# security.max_file_size_bytes, not this value - see current-implementation.md.
FILE_SIZE_MAX=26214400
AV_ENABLED=${AV_ENABLED_DEFAULT}
STORAGE_DIR=./encrypted-storage
ENVEOF
  chmod 600 .env
  log ".env written (chmod 600)"

  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

step "4. Setting up PostgreSQL"

# Run a command as the 'postgres' OS user: via sudo if available (works
# whether we're already root or not), else via su (only reachable if we're
# root with no sudo binary - e.g. a minimal container).
as_postgres() {
  if $HAS_SUDO; then
    sudo -u postgres "$@"
  elif $IS_ROOT; then
    su postgres -c "$(printf '%q ' "$@")"
  else
    return 1
  fi
}

if command -v psql >/dev/null 2>&1 && { $HAS_SUDO || $IS_ROOT; } && as_postgres psql -tAc '\q' >/dev/null 2>&1; then
  ROLE_EXISTS="$(as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${POSTGRES_USER}'" 2>/dev/null | tr -d '[:space:]')"
  if [ "$ROLE_EXISTS" = "1" ]; then
    log "Postgres role '${POSTGRES_USER}' already exists"
  else
    log "Creating Postgres role '${POSTGRES_USER}'"
    as_postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE ROLE \"${POSTGRES_USER}\" WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';"
  fi

  DB_EXISTS="$(as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" 2>/dev/null | tr -d '[:space:]')"
  if [ "$DB_EXISTS" = "1" ]; then
    log "Database '${POSTGRES_DB}' already exists"
  else
    log "Creating database '${POSTGRES_DB}'"
    as_postgres psql -v ON_ERROR_STOP=1 -c \
      "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"
  fi
else
  warn "Can't manage PostgreSQL as the 'postgres' OS user on this machine (remote DB,"
  warn "different auth setup, or no way to gain root). Make sure this database/role already"
  warn "exist and match .env before continuing:"
  info "  Database: ${POSTGRES_DB:-secret_bot}   Role: ${POSTGRES_USER:-secret_bot}"
  ask_yes_no "Continue anyway?" y || exit 1
fi

step "5. Running database migrations"
npm run migrate

step "6. Generating master encryption key"
npm run gen-key
if [ -f src/crypto/keys/master.key ]; then
  chmod 600 src/crypto/keys/master.key
fi

step "7. Preparing encrypted file storage directory"
mkdir -p encrypted-storage
chmod 700 encrypted-storage
log "encrypted-storage/ ready"

mkdir -p logs

step "8. Optional: install as a systemd service"
if command -v systemctl >/dev/null 2>&1 && $CAN_ELEVATE && ask_yes_no "Install secret-bot as a systemd service (starts on boot)?" n; then
  SERVICE_NAME="secret-bot"
  CURRENT_USER="$(id -un)"
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  TSX_BIN="${ROOT_DIR}/node_modules/.bin/tsx"

  if [ ! -x "$TSX_BIN" ]; then
    warn "Couldn't find $TSX_BIN - skipping systemd install."
  else
    UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
    log "Writing ${UNIT_PATH} for user ${CURRENT_USER}"
    as_root tee "$UNIT_PATH" > /dev/null <<UNITEOF
[Unit]
Description=Secret Bot - Slack view-once secrets
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${ROOT_DIR}
Environment=PATH=${NODE_BIN_DIR}:/usr/bin:/bin
ExecStartPre=${TSX_BIN} bin/migrate.ts
ExecStart=${TSX_BIN} src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=${ROOT_DIR}/.env

[Install]
WantedBy=multi-user.target
UNITEOF
    as_root systemctl daemon-reload
    as_root systemctl enable "$SERVICE_NAME"
    log "Installed. Start it with: sudo systemctl start ${SERVICE_NAME}"
    info "Logs: journalctl -u ${SERVICE_NAME} -f"
  fi
elif command -v systemctl >/dev/null 2>&1 && ! $CAN_ELEVATE; then
  info "Skipped systemd install (no way to gain root). Use bin/start-all.sh or 'npm run dev'."
else
  info "Skipped. Use bin/start-all.sh / bin/stop-all.sh, or 'npm run dev', to run it manually."
fi

step "Done"

NEEDS_SLACK_CREDS=false
grep -qE '(REPLACE-ME)' .env 2>/dev/null && NEEDS_SLACK_CREDS=true

echo ""
log "Setup complete."
if $NEEDS_SLACK_CREDS; then
  warn "You still need to fill in real Slack credentials in .env (some fields are placeholders)."
fi
info "Next steps:"
info "  - Review .env, especially the Slack credentials"
info "  - Invite the bot to any channel it needs to post in"
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet secret-bot 2>/dev/null; then
  info "  - Start it: sudo systemctl start secret-bot"
else
  info "  - Start it: npm run dev   (or ./bin/start-all.sh)"
fi
info "  - Health check once running: curl http://localhost:${HEALTH_PORT:-9090}/healthz"
echo ""

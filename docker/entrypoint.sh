#!/bin/sh
# Zero-config first run: provision persistent secrets, seed the admin, start the server.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
SECRETS="$DATA_DIR/.secrets.env"

# Auto-provision the master key and JWT secret only for values not already supplied
# via the environment. They are persisted in the data volume so encrypted DB secrets
# (SSH creds, stored LLM key) and existing sessions survive restarts.
if [ -z "$SUPOPS_MASTER_KEY" ] || [ -z "$JWT_SECRET" ]; then
  if [ ! -f "$SECRETS" ]; then
    echo "[supops] first run: generating persistent secrets at $SECRETS"
    umask 077
    printf 'SUPOPS_MASTER_KEY=%s\nJWT_SECRET=%s\n' \
      "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" > "$SECRETS"
  fi
  MK_FILE=$(sed -n 's/^SUPOPS_MASTER_KEY=//p' "$SECRETS")
  JWT_FILE=$(sed -n 's/^JWT_SECRET=//p' "$SECRETS")
  export SUPOPS_MASTER_KEY="${SUPOPS_MASTER_KEY:-$MK_FILE}"
  export JWT_SECRET="${JWT_SECRET:-$JWT_FILE}"
fi

echo "[supops] applying seed (idempotent)…"
npm run seed --workspace=@supops/server

echo "[supops] starting SupOps on port ${PORT:-3001}…"
exec npm run start --workspace=@supops/server

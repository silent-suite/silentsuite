#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Installer
# -----------------------------------
# Sets up the SilentSuite sync server with PostgreSQL and Caddy (auto-TLS).
# Users connect via app.silentsuite.io or mobile apps with a custom server URL.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  SilentSuite Self-Hosted Installer"
echo "============================================"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────

check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is not installed. Please install it first."
    exit 1
  fi
}

check_command docker
check_command openssl

if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "ERROR: 'docker compose' is not available. Please install Docker Compose v2."
  exit 1
fi

echo "Prerequisites OK: docker, $COMPOSE, openssl"
echo ""

# ── Prompt for domain ─────────────────────────────────────────────────

echo "Enter the domain for your SilentSuite server."
echo "This is where your apps will connect to sync data."
echo "Example: sync.example.com"
echo ""
read -rp "Domain: " DOMAIN
if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: Domain name is required."
  exit 1
fi

echo ""
echo "SilentSuite server: https://$DOMAIN"
echo ""

# ── Generate passwords ────────────────────────────────────────────────

echo "Generating secure passwords..."
DATABASE_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
SUPER_PASS=$(openssl rand -base64 16 | tr -d '/+=')

# ── Write .env ─────────────────────────────────────────────────────────

cat > .env <<EOF
DOMAIN=$DOMAIN
DATABASE_PASSWORD=$DATABASE_PASSWORD
SUPER_USER=admin
SUPER_PASS=$SUPER_PASS
EOF

chmod 600 .env
echo "Wrote .env (permissions: 600)"

# ── Pull images and start ─────────────────────────────────────────────

echo ""
echo "Pulling images and starting containers..."
$COMPOSE pull
$COMPOSE up -d

# ── Wait for health checks ───────────────────────────────────────────

echo ""
echo "Waiting for services to become healthy..."

MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=0

  for container in silentsuite-postgres silentsuite-server; do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
      HEALTHY=$((HEALTHY + 1))
    fi
  done

  if [ "$HEALTHY" -ge 2 ]; then
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo "  $HEALTHY/2 services healthy ($ELAPSED/${MAX_WAIT}s)..."
done

if [ "$HEALTHY" -lt 2 ]; then
  echo ""
  echo "WARNING: Not all services are healthy after ${MAX_WAIT}s."
  echo "Run 'docker compose logs' to troubleshoot."
  echo ""
fi

echo ""
echo "============================================"
echo "  SilentSuite is installed!"
echo "============================================"
echo ""
echo "  Server URL:    https://$DOMAIN"
echo "  Admin Panel:   https://$DOMAIN/admin/"
echo ""
echo "  Admin user:    admin"
echo "  Admin pass:    $SUPER_PASS"
echo ""
echo "  IMPORTANT: Save these credentials!"
echo "  They are also stored in .env"
echo ""
echo "  Next steps:"
echo "  1. Point a DNS A record for $DOMAIN to this server's IP"
echo "  2. Caddy will auto-provision a TLS certificate once DNS propagates"
echo "  3. Open app.silentsuite.io (or the mobile app)"
echo "  4. On the signup/login page, expand 'Advanced Settings'"
echo "  5. Enter https://$DOMAIN as your server URL"
echo "  6. Create your account and start syncing!"
echo ""

#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Installer
# -----------------------------------

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

if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "ERROR: 'docker compose' is not available. Please install Docker Compose v2."
  exit 1
fi

echo "Prerequisites OK: docker, $COMPOSE"
echo ""

# ── Prompt for domain ─────────────────────────────────────────────────

read -rp "Enter your domain name (e.g., silentsuite.example.com): " DOMAIN
if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: Domain name is required."
  exit 1
fi

echo ""
echo "Domain: $DOMAIN"
echo "Sync:   sync.$DOMAIN"
echo ""

# ── Generate passwords ────────────────────────────────────────────────

echo "Generating secure passwords..."
POSTGRES_PASSWORD=$(openssl rand -base64 32)
ETEBASE_DB_PASSWORD=$(openssl rand -base64 32)
ETEBASE_ADMIN_PASSWORD=$(openssl rand -base64 32)

# ── Write .env ─────────────────────────────────────────────────────────

cat > .env <<EOF
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
ETEBASE_DB_PASSWORD=$ETEBASE_DB_PASSWORD
ETEBASE_ADMIN_USER=admin
ETEBASE_ADMIN_PASSWORD=$ETEBASE_ADMIN_PASSWORD
EOF

echo "Wrote .env"

# ── Patch etebase-server.ini ───────────────────────────────────────────

cp etebase-server.ini etebase-server.ini.bak
sed -i "s|PLACEHOLDER_DOMAIN|sync.$DOMAIN|g" etebase-server.ini
sed -i "s|PLACEHOLDER_ETEBASE_DB_PASSWORD|$ETEBASE_DB_PASSWORD|g" etebase-server.ini
echo "Patched etebase-server.ini"

# ── Create data directories ───────────────────────────────────────────

mkdir -p data
echo "Created data directories"

# ── Build and start ───────────────────────────────────────────────────

echo ""
echo "Building and starting containers..."
$COMPOSE up -d --build

# ── Wait for health checks ───────────────────────────────────────────

echo ""
echo "Waiting for services to become healthy..."

MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=$(docker ps --filter "name=silentsuite" --filter "health=healthy" --format '{{.Names}}' | wc -l)
  TOTAL=$(docker ps --filter "name=silentsuite" --format '{{.Names}}' | wc -l)
  ETEBASE_HEALTHY=$(docker ps --filter "name=etebase-server" --filter "health=healthy" --format '{{.Names}}' | wc -l)

  ALL_HEALTHY=$((HEALTHY + ETEBASE_HEALTHY))
  ALL_TOTAL=$((TOTAL + $(docker ps --filter "name=etebase-server" --format '{{.Names}}' | wc -l)))

  if [ "$ALL_HEALTHY" -ge 3 ]; then
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo "  $ALL_HEALTHY/$ALL_TOTAL services healthy ($ELAPSED/${MAX_WAIT}s)..."
done

echo ""
echo "============================================"
echo "  SilentSuite is installed!"
echo "============================================"
echo ""
echo "  Web App:       https://$DOMAIN"
echo "  Sync Server:   https://sync.$DOMAIN"
echo "  Etebase Admin: https://sync.$DOMAIN/admin/"
echo ""
echo "  Admin user:    admin"
echo "  Admin pass:    $ETEBASE_ADMIN_PASSWORD"
echo ""
echo "  IMPORTANT: Save these credentials!"
echo "  They are also stored in .env"
echo ""
echo "  Next steps:"
echo "  1. Point DNS A records for $DOMAIN and sync.$DOMAIN to this server"
echo "  2. Caddy will auto-provision TLS certificates once DNS propagates"
echo "  3. Open https://$DOMAIN to create your first account"
echo ""

#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Installer
# -----------------------------------
# Sets up the SilentSuite sync server with PostgreSQL.
# Can be run standalone via:
#   curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
#
# Pin to a specific release:
#   curl -fsSL .../install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash
# Or, when running locally:
#   bash install.sh --version v0.1.0-beta

REPO="silent-suite/silentsuite"
INSTALL_DIR="${SILENTSUITE_DIR:-silentsuite-server}"
REQUESTED_VERSION=""

# ── Parse arguments ───────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: install.sh [--version <tag>]

  --version <tag>   Install a specific SilentSuite release (e.g. v0.1.0-beta).
                    Default: the latest umbrella release on GitHub, falling
                    back to the 'main' branch if no umbrella release exists.
  -h, --help        Show this message and exit.

Environment:
  SILENTSUITE_DIR       Install directory (default: silentsuite-server).
  SILENTSUITE_VERSION   Same as --version. Useful for the curl-pipe pattern:
                        curl -fsSL .../install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash
                        (CLI --version takes precedence over the env var.)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ]; then
        echo "ERROR: --version requires an argument (e.g. --version v0.1.0-beta)" >&2
        exit 1
      fi
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --version=*)
      REQUESTED_VERSION="${1#--version=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument '$1'. Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

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
check_command curl

if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "ERROR: 'docker compose' is not available. Please install Docker Compose v2."
  exit 1
fi

echo "Prerequisites OK: docker, $COMPOSE, openssl, curl"
echo ""

# ── Resolve target version ────────────────────────────────────────────
#
# Precedence: --version flag > SILENTSUITE_VERSION env > latest umbrella
# release on GitHub > 'main' branch (development tip, fallback when no
# umbrella release exists yet).

resolve_version() {
  if [ -n "$REQUESTED_VERSION" ]; then
    echo "$REQUESTED_VERSION"
    return 0
  fi
  if [ -n "${SILENTSUITE_VERSION:-}" ]; then
    echo "$SILENTSUITE_VERSION"
    return 0
  fi

  # Walk the releases list newest-first and pick the first tag that is
  # neither component-prefixed (bridge-vX, android-vX, server-vX, web-vX)
  # nor component-suffixed (vX-bridge, vX-android, ...). Mirrors the
  # filtering convention used by bridge/install.sh — both installers walk
  # the same release stream, applying the filter that's right for them.
  local releases tag
  releases=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" 2>/dev/null || true)
  if [ -z "$releases" ]; then
    echo "main"
    return 0
  fi

  tag=$(echo "$releases" \
    | grep -E '"tag_name":' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
    | grep -vE '^(bridge|android|server|web)-|-(bridge|android|server|web)$' \
    | head -1)

  if [ -z "$tag" ]; then
    echo "main"
  else
    echo "$tag"
  fi
}

verify_ref_exists() {
  # Skip the check for branches — we treat 'main' / 'dev' as always-valid.
  case "$1" in
    main|dev) return 0 ;;
  esac
  curl -fsI "https://raw.githubusercontent.com/${REPO}/$1/self-host/docker-compose.yml" >/dev/null 2>&1
}

VERSION=$(resolve_version)
if ! verify_ref_exists "$VERSION"; then
  echo "ERROR: Version '$VERSION' does not exist or has no self-host config." >&2
  echo "       Check available releases at https://github.com/${REPO}/releases" >&2
  exit 1
fi

if [ "$VERSION" = "main" ]; then
  echo "WARNING: No SilentSuite umbrella release found yet — installing from 'main'"
  echo "         (development tip). Once a release is cut, this default switches"
  echo "         automatically. To pin explicitly: --version vX.Y.Z."
else
  echo "Installing SilentSuite version: $VERSION"
fi
echo ""

GITHUB_RAW_BASE="https://raw.githubusercontent.com/${REPO}/${VERSION}/self-host"

# ── Set up install directory ──────────────────────────────────────────

if [ ! -d "$INSTALL_DIR" ]; then
  echo "Creating install directory: $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
fi
# 0750 keeps secrets in .env and etebase-server.ini out of reach of other
# local users on shared hosts — the install dir is a single-operator surface.
chmod 750 "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Download docker-compose.yml ───────────────────────────────────────

echo "Downloading docker-compose.yml..."
curl -fsSL "$GITHUB_RAW_BASE/docker-compose.yml" -o docker-compose.yml

# ── Download helper scripts ───────────────────────────────────────────

for script in update.sh verify.sh; do
  echo "Downloading $script..."
  curl -fsSL "$GITHUB_RAW_BASE/$script" -o "$script"
  chmod +x "$script"
done

echo "Downloading landing page..."
curl -fsSL "$GITHUB_RAW_BASE/success.html" -o success.html

echo ""

# ── Clean up stale containers ─────────────────────────────────────────

for container in silentsuite-postgres silentsuite-server; do
  if docker inspect "$container" &>/dev/null; then
    echo "Removing stale container: $container"
    docker stop "$container" 2>/dev/null || true
    docker rm "$container" 2>/dev/null || true
  fi
done

# ── Gather configuration ──────────────────────────────────────────────

if [ -f .env ]; then
  echo "An existing .env file was found."
  read -rp "Overwrite it? (y/N): " OVERWRITE </dev/tty
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Keeping existing .env. Starting containers..."
    $COMPOSE pull
    $COMPOSE up -d
    echo ""
    echo "Done. Run ./verify.sh to check health."
    exit 0
  fi
fi

echo "Enter the domain name your server will be accessible at."
echo "This is the hostname users will enter in the SilentSuite app."
echo "Examples: sync.example.com, silentsuite.example.com"
echo ""
read -rp "Domain: " DOMAIN </dev/tty

if [ -z "$DOMAIN" ]; then
  echo "ERROR: Domain cannot be empty."
  exit 1
fi

echo ""
echo "If you're using a Docker-based reverse proxy (Nginx Proxy Manager, Traefik),"
echo "enter the Docker network name it runs on (leave empty to skip):"
echo ""
read -rp "Proxy network name [empty to skip]: " PROXY_NETWORK </dev/tty
echo ""

# ── Generate passwords ────────────────────────────────────────────────

echo "Generating secure passwords..."
DATABASE_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
SUPER_PASS=$(openssl rand -base64 16 | tr -d '/+=')

# ── Write .env ─────────────────────────────────────────────────────────

cat > .env <<EOF
# SilentSuite Self-Hosted Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC")

# Port the SilentSuite server listens on (default: 3735).
# Your reverse proxy should forward traffic to this port.
SERVER_PORT=3735

# PostgreSQL credentials (auto-generated)
DATABASE_PASSWORD=$DATABASE_PASSWORD

# Django admin panel credentials (advanced use only).
# These are for the Etebase Django admin at https://$DOMAIN/admin/
# Most users don't need this — the first user to sign up in the
# SilentSuite app becomes the server admin automatically.
SUPER_USER=admin
SUPER_PASS=$SUPER_PASS

# Open registration toggle. "false" allows new signups (default; needed for
# the first admin to register). Flip to "true" once the admin is registered.
ETEBASE_DISABLE_SIGNUP=false
EOF

chmod 600 .env

# ── Proxy network override ─────────────────────────────────────────────

if [ -n "$PROXY_NETWORK" ]; then
  echo "PROXY_NETWORK=$PROXY_NETWORK" >> .env
  cat > docker-compose.override.yml <<OVERRIDE
# Auto-generated: connects the server to your reverse proxy network.
# Delete this file if you no longer need proxy network integration.
services:
  server:
    networks:
      - silentsuite
      - proxy

networks:
  silentsuite:
    driver: bridge
  proxy:
    external: true
    name: $PROXY_NETWORK
OVERRIDE
  echo "Generated docker-compose.override.yml for proxy network: $PROXY_NETWORK"
fi

# ── Generate etebase-server.ini ────────────────────────────────────────

cat > etebase-server.ini <<INIEOF
; SilentSuite / Etebase server configuration
; Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
;
; This file is mounted into the container at
; /etc/etebase-server/etebase-server.ini. Edit it and restart to apply:
;   docker compose restart server

[global]
secret_file = /data/secret.txt
debug = false
media_root = /data/media
static_root = /data/static

[allowed_hosts]
allowed_host1 = $DOMAIN
allowed_host2 = localhost

[database]
engine = django.db.backends.postgresql
name = silentsuite
user = silentsuite
password = $DATABASE_PASSWORD
host = postgres
port = 5432
INIEOF
# 0644 (not 0600) so the etebase user inside the container — which has a
# different UID from the host operator — can still read this file via the
# bind mount. The file already lives in an operator-owned install directory.
chmod 644 etebase-server.ini
echo "Generated etebase-server.ini"

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
  echo "Run '$COMPOSE logs' to troubleshoot."
  echo ""
fi

echo ""
echo "============================================"
echo "  SilentSuite is installed!"
echo "============================================"
echo ""
echo "  The first user to sign up becomes the server admin."
echo ""
echo "  Next steps:"
echo ""
echo "  1. Set up a reverse proxy to forward HTTPS traffic"
echo "     to this server on port 3735."
echo ""
echo "     The server listens on 127.0.0.1:3735 (localhost only)."
echo "     You need a reverse proxy (Caddy, nginx, Traefik, or"
echo "     Cloudflare Tunnel) to handle TLS and forward traffic."
echo ""
if [ -n "$PROXY_NETWORK" ]; then
echo "     Your reverse proxy network ($PROXY_NETWORK) has been"
echo "     configured. Use 'silentsuite-server:3735' as the"
echo "     upstream/target in your proxy settings."
else
echo "     If using Nginx Proxy Manager or another Docker-based proxy,"
echo "     re-run this installer and enter the proxy network name, or"
echo "     manually connect the containers:"
echo "       docker network connect <proxy_network> silentsuite-server"
echo "     Then use 'silentsuite-server:3735' as the upstream."
fi
echo ""
echo "  2. Point your DNS A record for $DOMAIN"
echo "     to this server's public IP."
echo ""
echo "  3. Open https://app.silentsuite.io (or the mobile app)"
echo "  4. On the signup page, expand 'Advanced Settings'"
echo "  5. Enter https://$DOMAIN as the server URL"
echo "  6. Create your account — you'll be the admin!"
echo ""
echo "  Configuration files:"
echo "    .env                — environment variables"
echo "    etebase-server.ini  — server config (domain, database)"
echo ""
echo "  To change the domain or other settings, edit etebase-server.ini"
echo "  and restart: docker compose restart server"
echo ""

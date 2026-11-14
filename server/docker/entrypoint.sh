#!/bin/sh
# SilentSuite server container entrypoint.
#
# Responsibilities (each step is idempotent and safe on every container start):
#   1. Collect Django static assets for /admin/ into the configured STATIC_ROOT.
#   2. Apply Django migrations.
#   3. Optionally create a Django /admin/ superuser when SUPER_USER and
#      SUPER_PASS are both set and the user does not already exist.
#   4. Exec uvicorn.
#
# Self-host operators read configuration from /etc/etebase-server/etebase-server.ini
# (or wherever ETEBASE_EASY_CONFIG_PATH points). The SaaS deployment leaves
# SUPER_USER / SUPER_PASS unset, so step 2 silently no-ops there.

set -eu

cd /app

# When the user passes a command (e.g. `docker run … python manage.py shell`),
# skip the default startup sequence and run the command directly.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

echo "[entrypoint] collecting static assets..."
python manage.py collectstatic --noinput --verbosity 0

echo "[entrypoint] applying database migrations..."
python manage.py migrate --noinput

if [ -n "${SUPER_USER:-}" ] && [ -n "${SUPER_PASS:-}" ]; then
    python manage.py shell <<'PYEOF'
import os
from django.contrib.auth import get_user_model
User = get_user_model()
username = os.environ.get("SUPER_USER")
password = os.environ.get("SUPER_PASS")
if username and password and not User.objects.filter(username=username).exists():
    User.objects.create_superuser(
        username=username,
        email=f"{username}@localhost",
        password=password,
    )
    print(f"[entrypoint] created Django superuser '{username}'")
PYEOF
fi

TRUSTED_PROXY_IPS="${TRUSTED_PROXY_IPS:-127.0.0.1}"
export TRUSTED_PROXY_IPS

# A reverse proxy on the Docker host reaches a published port through Docker,
# so the server sees the container's default gateway as the peer, not
# 127.0.0.1. The entry "docker-gateway" stands for that address, read from the
# routing table at every start so it follows the network if Compose recreates
# it with another subnet. It is opt-in: trusting the gateway trusts whatever
# reaches the container through it, which is only programs on this host while
# the port is published on 127.0.0.1. If no IPv4 default route exists, the
# entry is dropped and nothing extra is trusted.
case "$TRUSTED_PROXY_IPS" in
    *docker-gateway*)
        TRUSTED_PROXY_IPS="$(python - <<'PYEOF'
import os
import socket
import struct
import sys

gateway = ""
try:
    with open("/proc/net/route") as routes:
        next(routes, None)
        for line in routes:
            fields = line.split()
            # Destination 0.0.0.0 with RTF_UP and RTF_GATEWAY set.
            if len(fields) > 3 and fields[1] == "00000000" and int(fields[3], 16) & 3 == 3:
                gateway = socket.inet_ntoa(struct.pack("=L", int(fields[2], 16)))
                break
except (OSError, ValueError):
    gateway = ""

resolved = []
for entry in os.environ.get("TRUSTED_PROXY_IPS", "").split(","):
    entry = entry.strip()
    if entry == "docker-gateway":
        if not gateway:
            print("[entrypoint] docker-gateway: no IPv4 default route; not trusting a gateway", file=sys.stderr)
            continue
        entry = gateway
    if entry and entry not in resolved:
        resolved.append(entry)
print(",".join(resolved) or "127.0.0.1")
PYEOF
)"
        ;;
esac
echo "[entrypoint] trusting X-Forwarded-* headers from: $TRUSTED_PROXY_IPS"

echo "[entrypoint] starting uvicorn..."
exec uvicorn etebase_server.asgi:application \
    --host 0.0.0.0 --port 3735 \
    --workers 2 --proxy-headers \
    --forwarded-allow-ips "$TRUSTED_PROXY_IPS"

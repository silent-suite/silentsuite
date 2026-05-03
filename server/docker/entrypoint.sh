#!/bin/sh
# SilentSuite server container entrypoint.
#
# Responsibilities (each step is idempotent and safe on every container start):
#   1. Apply Django migrations.
#   2. Optionally create a Django /admin/ superuser when SUPER_USER and
#      SUPER_PASS are both set and the user does not already exist.
#   3. Exec uvicorn.
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

echo "[entrypoint] starting uvicorn..."
exec uvicorn etebase_server.asgi:application \
    --host 0.0.0.0 --port 3735 \
    --workers 2 --proxy-headers \
    --forwarded-allow-ips '*'

#!/usr/bin/env bash
# Start the self-host server built from this commit's Dockerfile.server on
# http://127.0.0.1:8000, with its SQLite database and media under STATE_DIR so a later
# job can start it again on the same accounts. Plain HTTP on loopback only; the state
# holds nothing but a synthetic account. Run from the repository root.
#
# Usage: server.sh start STATE_DIR | server.sh stop STATE_DIR
set -euo pipefail
action="$1" state="$2"
if [ "$action" = stop ]; then
  docker stop ss-server >/dev/null
  sudo chmod -R a+rwX "$state"
  exit 0
fi
mkdir -p "$state/etc" "$state/data/media" "$state/data/static"
[ -f "$state/etc/secret.txt" ] || head -c 48 /dev/urandom | base64 > "$state/etc/secret.txt"
cat > "$state/etc/etebase-server.ini" <<'INI'
[global]
secret_file = /etc/etebase-server/secret.txt
debug = false
static_root = /data/static
media_root = /data/media

[allowed_hosts]
allowed_host1 = *

[database]
engine = django.db.backends.sqlite3
name = /data/db.sqlite3
INI
sudo chmod -R a+rwX "$state"
docker build -q -f Dockerfile.server -t ss-server:continuity .
docker run -d --name ss-server -p 127.0.0.1:8000:8000 \
  -v "$state/etc:/etc/etebase-server:ro" -v "$state/data:/data" \
  -e ETEBASE_EASY_CONFIG_PATH=/etc/etebase-server/etebase-server.ini \
  -e ETEBASE_SECURE_SSL_REDIRECT=false \
  ss-server:continuity sh -c 'python manage.py migrate --noinput && exec uvicorn etebase_server.asgi:application --host 0.0.0.0 --port 8000'
for _ in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:8000/ && break
  sleep 2
done
curl -sS -o /dev/null -w 'server %{http_code}\n' http://127.0.0.1:8000/api/v1/authentication/is_etebase/

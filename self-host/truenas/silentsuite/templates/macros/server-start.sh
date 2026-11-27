{% macro server_start(values) -%}
#!/bin/sh
# SilentSuite TrueNAS app startup wrapper.
#
# Runs the same server lifecycle as the shared image entrypoint (collectstatic,
# database migrations, then uvicorn with two workers) with these package guarantees:
#   1. /data is checked, and its secret files are inspected without following links,
#      before anything under /data is created, read or changed.
#   2. The server configuration, which holds the database password, is written to a
#      private tmpfs on every start and never to the data dataset.
#   3. The registration signing material is generated once per install, kept private
#      in the data dataset, and never printed.
#   4. umask 077, so files the server creates under /data start private.
#   5. HTTP access logging and WebSocket connection INFO records are disabled.
set -eu

umask 077
cd /app

python - <<'PY'
import configparser
import os
import secrets
import stat
import sys

DATA = "/data"
SECRETS = ("secret.txt", "registration-signing")


def fail(message):
    sys.exit("[package-start] " + message)


# 1. The data directory and the existing secret entries, before any change.
try:
    info = os.lstat(DATA)
except FileNotFoundError:
    fail("the data directory is missing")
if not stat.S_ISDIR(info.st_mode):
    fail("the data directory is not a directory")
if not os.access(DATA, os.W_OK | os.X_OK):
    fail("the data directory is not writable for uid %d / gid %d; give that user ownership or "
         "enable automatic permissions" % (os.getuid(), os.getgid()))
for name in SECRETS:
    path = os.path.join(DATA, name)
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(entry.st_mode):
        fail(name + " is a symbolic link; refusing to use it")
    if not stat.S_ISREG(entry.st_mode):
        fail(name + " is not a regular file")
    if entry.st_uid != os.getuid():
        fail(name + " is not owned by the server user")

# 2. Private, per-start server configuration on tmpfs.
password = os.environ.get("SILENTSUITE_DB_PASSWORD", "")
if not password or password != password.strip() or any(c in password for c in "\r\n\0"):
    fail("the database password is empty or has surrounding spaces or line breaks")
config = configparser.ConfigParser()
config["global"] = {
    "secret_file": DATA + "/secret.txt",
    "debug": "false",
    "static_root": DATA + "/static",
    "media_root": DATA + "/media",
}
config["allowed_hosts"] = {"allowed_host1": "*"}
config["database"] = {
    "engine": "django.db.backends.postgresql",
    "name": os.environ["SILENTSUITE_DB_NAME"],
    "user": os.environ["SILENTSUITE_DB_USER"],
    # ConfigParser interpolates "%"; the settings loader reads it back unescaped.
    "password": password.replace("%", "%%"),
    "host": os.environ["SILENTSUITE_DB_HOST"],
    "port": os.environ["SILENTSUITE_DB_PORT"],
}
with open(os.environ["ETEBASE_EASY_CONFIG_PATH"], "w", encoding="utf-8") as handle:
    config.write(handle)

# 3. Repair existing secrets, then create the signing material once.
for name in SECRETS:
    path = os.path.join(DATA, name)
    if os.path.lexists(path):
        # Checked above to be a regular file owned by this user, not a link.
        os.chmod(path, 0o600)
signing = os.path.join(DATA, "registration-signing")
if not os.path.lexists(signing):
    fd = os.open(signing, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as handle:
        handle.write(secrets.token_hex(32))
        handle.flush()
        os.fsync(handle.fileno())
for name in ("media", "static"):
    os.makedirs(os.path.join(DATA, name), exist_ok=True)
if os.stat(DATA).st_uid == os.getuid():
    os.chmod(DATA, 0o700)
PY

unset SILENTSUITE_DB_PASSWORD
ETEBASE_REGISTRATION_TOKEN="$(cat /data/registration-signing)"
export ETEBASE_REGISTRATION_TOKEN

# Parity with the image entrypoint: explicit arguments run directly.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "[package-start] collecting static assets..."
python manage.py collectstatic --noinput --verbosity 0

echo "[package-start] applying database migrations..."
python manage.py migrate --noinput

echo "[package-start] starting uvicorn (access and connection logs disabled)..."
exec uvicorn etebase_server.asgi:application \
    --host 0.0.0.0 --port {{ values.consts.server_port }} \
    --workers 2 --proxy-headers --no-access-log --log-level warning \
    --forwarded-allow-ips 127.0.0.1
{%- endmacro %}

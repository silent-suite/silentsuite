# Legacy Docker Stack

This directory is retained for older local-development workflows only. Do not use
it for new self-hosted deployments.

Use `../self-host/` instead. The current self-host stack pins the server image,
binds the sync server to host loopback by default, generates credentials, and
documents reverse-proxy/TLS setup.

If you still run this legacy stack locally:

- Copy `.env.example` to `.env` and set a unique `POSTGRES_PASSWORD`.
- Update `etebase/etebase-server.ini` so its database password matches `.env`,
  then rebuild the image with `docker compose build etebase` because the legacy
  Dockerfile copies that INI file at build time.
- Keep the default loopback-only ports and put any public access behind your
  reverse proxy/TLS layer.
- Use `docker-compose.dev.yml` only for disposable local development; it contains
  intentional dev-only defaults and exposes Postgres on all interfaces.

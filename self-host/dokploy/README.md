# SilentSuite on Dokploy

[Dokploy](https://dokploy.com) is a self-hosted PaaS that deploys Docker Compose stacks behind
Traefik with Let's Encrypt certificates. `silentsuite/` is a Dokploy blueprint in the layout of the
[Dokploy templates](https://github.com/Dokploy/templates) catalogue: `docker-compose.yml`,
`template.toml`, `meta.json` and the logo.

The stack runs five containers from published images pinned by digest: a small nginx router (the
only service with a domain), the web app, a one-shot initializer, the Etebase-compatible server
and PostgreSQL 16. The router serves the web app and the sync API from one HTTPS origin.

## Install

Until the blueprint is in the Dokploy catalogue, import it by hand:

1. In this repository, run `python3 scripts/dokploy-template-render.py import` and copy the
   output. It is the same base64 "Import" text the Dokploy template site produces.
2. In Dokploy, open a project, choose **Create Service > Compose**, then the service's
   **Advanced > Import**, paste the text and import it.
3. Open **Domains**. Dokploy creates the domain as plain HTTP on a generated `sslip.io` name.
   Change it to your own domain (or keep the generated one if the server is reachable from the
   internet on port 80), turn on **HTTPS** with **Let's Encrypt**, and save.
4. Deploy.

Do the HTTPS step before anyone signs up. The web app needs a secure context for its encryption,
and both the web app and the server refuse the installation-owner login from a plain-HTTP
origin, so an HTTP-only install cannot create accounts.

## First account

Dokploy generates three secrets when the service is created and shows them in the service's
**Environment** tab:

- `SILENTSUITE_INSTALLATION_PASSWORD`: the installation password. Open your domain, choose
  **Sign up** and enter it once, then choose your own account password. Your account password
  encrypts your data and is never sent to the server, so it cannot be recovered.
- `SILENTSUITE_REGISTRATION_SIGNING` and `SILENTSUITE_DB_PASSWORD`: used internally.

Do not delete or empty these values. The stack refuses to start if any of them is missing or
empty, because a server without them would accept signups from anyone.

New accounts always need a grant from the installation-owner login, so other people can only
join when you sign them up with the installation password.

## Apps

The Android app and the [Bridge](https://github.com/silent-suite/silentsuite/releases/latest)
connect to `https://your-domain` directly. Calendar and address-book apps that speak CalDAV or
CardDAV connect to the Bridge on your computer, and the Bridge syncs with this server.

## Backup and restore

Both recipes below are what CI runs on every change to this package. They need a shell on the
Dokploy host. Dokploy keeps the stack in `/etc/dokploy/compose/<app>/code`, where `<app>` is
the service's app name, and the `.env` file there sets the Compose project name, so run the
commands from that directory. Volume names start with `<app>_`.

Back up all of it: the database holds accounts and metadata, and the server-data volume holds
`secret.txt` and the encrypted item chunks. A database dump on its own loses every item.

### Logical backup

This stops SilentSuite but keeps PostgreSQL running for the dump:

```sh
cd /etc/dokploy/compose/<app>/code
docker compose stop silentsuite silentsuite-web silentsuite-server
docker compose exec -T silentsuite-postgres pg_dump -U silentsuite -d silentsuite --format=custom > ~/silentsuite-db.dump
docker run --rm --network none --entrypoint tar -v <app>_silentsuite-server-data:/data:ro -v ~:/backup \
  postgres:16.16-alpine -C /data -cpf /backup/silentsuite-server-data.tar .
docker compose start silentsuite-server silentsuite-web silentsuite
```

To restore it, create and deploy a new SilentSuite service in Dokploy, then replace its empty data:

```sh
cd /etc/dokploy/compose/<new-app>/code
docker compose down --volumes
docker compose create
docker compose start silentsuite-postgres
until docker compose exec -T silentsuite-postgres pg_isready -U silentsuite -d silentsuite; do sleep 2; done
docker compose exec -T silentsuite-postgres pg_restore -U silentsuite -d silentsuite --no-owner --exit-on-error < ~/silentsuite-db.dump
docker run --rm --network none --entrypoint tar -v <new-app>_silentsuite-server-data:/data -v ~:/backup:ro \
  postgres:16.16-alpine -C /data --numeric-owner -xpf /backup/silentsuite-server-data.tar
```

Then deploy the new service again from Dokploy.

### Volume backup

Stop the whole stack with `docker compose stop`, check
that `docker compose logs silentsuite-postgres` ends with "database system is shut down", then
archive the three volumes `<app>_silentsuite-postgres-data`, `<app>_silentsuite-server-data` and
`<app>_silentsuite-server-config` the same way. A volume restore must keep the old
`SILENTSUITE_DB_PASSWORD`, because the restored database still uses it: set all three secrets in
the new service's Environment tab to the old values before you deploy it. Dokploy's own volume
backups count as volume backups and are only safe while the whole stack is stopped; that feature
itself is not covered by this package's CI.

## Updating

Dokploy does not update a stack created from a template. To move to a newer SilentSuite
release, edit the service's compose file and change the three SilentSuite image lines, for
`silentsuite-web`, `silentsuite-init` and `silentsuite-server`, to the new release's pinned
images (the init and server lines use the same server image), then redeploy. This package's
`docker-compose.yml` on `main` always has the current pins. Back up first.

## Security notes

- On Umbrel the installation-owner login sits behind the Umbrel login. Dokploy has no such
  layer, so `/api/v1/owner/login/` is reachable from the internet. It needs the 128-bit generated
  installation password, a matching HTTPS `Origin`, and it only returns a short-lived signup
  grant.
- The Django admin panel is off.
- Dokploy stores the three secrets in its own database and shows them to every Dokploy user who
  can open the service.
- The router and the server keep no request logs. Dokploy's Traefik can keep access logs if you
  turn them on; they would show request paths and IP addresses, never the encrypted content.

## Maintenance

`template.toml` is generated from the Umbrel package files by
`scripts/dokploy-template-render.py template`; CI fails if they drift apart. The CI workflow
`.github/workflows/ci-dokploy-template.yml` runs the Dokploy catalogue's own validators, boots
the stack on amd64 and arm64, and deploys it on a throwaway Dokploy install over verified TLS.

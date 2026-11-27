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

Do the HTTPS step before anyone enters the installation password. In a browser, signup only works
over HTTPS: the web app needs a secure context for its encryption and will not send the
installation password from a plain-HTTP page, and the server refuses an `http://` origin. Once
HTTPS is on, Dokploy redirects plain HTTP to HTTPS.

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

Back up the database and the server-data volume together: the database holds accounts and
metadata, the server-data volume holds `secret.txt` and the encrypted item chunks. A database
dump on its own loses every item.

Run each block below as root on the Dokploy host, as one script (for example save it and run
`sh backup.sh`). Set the first lines: `app` is the service's App Name in Dokploy, `backup` a
directory that does not exist yet. The scripts stop at the first error, find the volumes through
the stack's own containers instead of typed volume names, and refuse to overwrite a service that
already has accounts. CI runs these blocks exactly as written, with only those first lines
changed.

### Logical backup

SilentSuite stops while PostgreSQL keeps running for the dump:

```sh
# recipe: logical-backup
app=silentsuite-abc123
backup=/root/silentsuite-backup
code=/etc/dokploy/compose/$app/code
set -eu
umask 077
cd "$code"
mkdir -m 700 "$backup"
docker compose stop silentsuite silentsuite-web silentsuite-server
docker compose exec -T silentsuite-postgres pg_dump -U silentsuite -d silentsuite --format=custom > "$backup/db.dump"
docker run --rm --network none --entrypoint tar --volumes-from "$(docker compose ps -aq silentsuite-init)" \
  -v "$backup:/backup" postgres:16.16-alpine -C /data -cpf /backup/server-data.tar .
docker compose start silentsuite-server silentsuite-web silentsuite
```

To restore, create a new SilentSuite service in Dokploy and deploy it once without signing up,
then run:

```sh
# recipe: logical-restore
app=silentsuite-def456
backup=/root/silentsuite-backup
code=/etc/dokploy/compose/$app/code
set -eu
cd "$code"
users="$(docker compose exec -T silentsuite-postgres psql -U silentsuite -d silentsuite -tAc 'select count(*) from myauth_user')"
[ "$users" = 0 ] || { echo "refusing: $app already has accounts" >&2; exit 1; }
docker compose down --volumes
docker compose create
docker compose start silentsuite-postgres
until docker compose exec -T silentsuite-postgres pg_isready -h 127.0.0.1 -U silentsuite -d silentsuite >/dev/null 2>&1; do sleep 2; done
docker compose exec -T silentsuite-postgres pg_restore -U silentsuite -d silentsuite --no-owner --exit-on-error < "$backup/db.dump"
docker run --rm --network none --entrypoint tar --volumes-from "$(docker compose ps -aq silentsuite-init)" \
  -v "$backup:/backup:ro" postgres:16.16-alpine -C /data --numeric-owner -xpf /backup/server-data.tar
```

Then deploy the new service again in Dokploy. The wait uses TCP on purpose: on a new volume,
PostgreSQL first runs a temporary socket-only server while it creates the database.

### Volume backup

The whole stack stops, PostgreSQL included, before its files are copied:

```sh
# recipe: volume-backup
app=silentsuite-abc123
backup=/root/silentsuite-volumes
code=/etc/dokploy/compose/$app/code
set -eu
umask 077
cd "$code"
mkdir -m 700 "$backup"
docker compose stop
docker compose logs silentsuite-postgres | tail -n 5 | grep -q "database system is shut down"
docker run --rm --network none --entrypoint tar --volumes-from "$(docker compose ps -aq silentsuite-postgres)" \
  -v "$backup:/backup" postgres:16.16-alpine -C /var/lib/postgresql/data -cpf /backup/postgres-data.tar .
docker run --rm --network none --entrypoint sh --volumes-from "$(docker compose ps -aq silentsuite-init)" \
  -v "$backup:/backup" postgres:16.16-alpine -c 'tar -C /data -cpf /backup/server-data.tar . && tar -C /config -cpf /backup/server-config.tar .'
```

Then deploy the service again in Dokploy to start it.

The copied database still uses the old database password. To restore, create a new SilentSuite
service, set its three secrets in the Environment tab to the old service's values before the
first deploy, deploy it once without signing up, then run:

```sh
# recipe: volume-restore
app=silentsuite-def456
backup=/root/silentsuite-volumes
code=/etc/dokploy/compose/$app/code
set -eu
cd "$code"
users="$(docker compose exec -T silentsuite-postgres psql -U silentsuite -d silentsuite -tAc 'select count(*) from myauth_user')"
[ "$users" = 0 ] || { echo "refusing: $app already has accounts" >&2; exit 1; }
docker compose down --volumes
docker compose create
docker run --rm --network none --entrypoint tar --volumes-from "$(docker compose ps -aq silentsuite-postgres)" \
  -v "$backup:/backup:ro" postgres:16.16-alpine -C /var/lib/postgresql/data --numeric-owner -xpf /backup/postgres-data.tar
docker run --rm --network none --entrypoint sh --volumes-from "$(docker compose ps -aq silentsuite-init)" \
  -v "$backup:/backup:ro" postgres:16.16-alpine -c 'tar -C /data --numeric-owner -xpf /backup/server-data.tar && tar -C /config --numeric-owner -xpf /backup/server-config.tar'
```

Then deploy the new service in Dokploy. All three archives go into empty volumes before anything
starts. Dokploy's own volume backups are a volume backup too and are only safe while the whole
stack is stopped; that feature itself is not covered by this package's CI.

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

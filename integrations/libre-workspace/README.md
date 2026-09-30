# SilentSuite add-on for Libre Workspace

A basic [Libre Workspace](https://docs.libre-workspace.org/modules/addons.html)
add-on that runs the SilentSuite sync server and its PostgreSQL database on a
Libre Workspace server and serves it at `https://silentsuite.<your domain>`.

> **Status: not yet tested on a real Libre Workspace server.** The scripts are
> covered by fixture tests (see [Testing](#testing)), but installation,
> removal, the portal buttons, Caddy and DNS on a live system are unverified.
> Do not use it for production data yet.

## What it does and does not do

It does:

- install the server with the standard self-host installer
  ([`self-host/install.sh`](https://github.com/silent-suite/silentsuite/blob/main/self-host/install.sh)), pinned to the
  SilentSuite release the package was built for. The installer checks that the
  release is published, that its tag points at the recorded source commit, the
  bundle checksum and contents, and the server and PostgreSQL image digests.
  See [SELF-HOSTING.md](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md);
- add one site to the Libre Workspace Caddy, which terminates HTTPS and forwards
  to the server on `127.0.0.1:3735`. On `int.de` test systems the site uses
  Caddy's internal TLS, as the upstream add-ons do;
- add a SilentSuite tile to the portal dashboard. It opens in a new tab, not in
  an iframe.

It does not:

- connect SilentSuite accounts to Libre Workspace users. There is no single
  sign-on, no automatic account creation and no password sync. The Libre
  Workspace administrator password is never read or reused;
- host the SilentSuite web app. Use the SilentSuite apps or `app.silentsuite.io`
  and enter your server URL;
- upgrade SilentSuite automatically (see [Updates](#updates)).

## Building the package

Build from a checkout that contains this add-on (release tags made before the
add-on existed do not). The package bundles that checkout's
`self-host/install.sh`, so first confirm it matches the release you pin:

```bash
git diff v0.5.10-beta -- self-host/install.sh   # expect no output
integrations/libre-workspace/build-deb.sh --release v0.5.10-beta --out-dir dist/libre-workspace-v0.5.10-beta
```

The output directory must not exist yet. Missing parent directories (here
`dist/`) are created. The build writes
`libre-workspace-module-silentsuite_<version>_all.deb` and a `.sha256` file.
`dpkg-deb` is required. `--tree-only` builds only the unpacked package tree. If
the bundled installer does not accept the release's bundle, setup fails before
installing anything.

Package contents (`/usr/lib/libre-workspace/modules/silentsuite/`):

| File | Purpose |
|---|---|
| `silentsuite.conf` | add-on metadata (`url="silentsuite"`, `disable_iframe="true"`) |
| `setup_silentsuite.sh`, `update_silentsuite.sh`, `remove_silentsuite.sh` | lifecycle scripts run by the portal as root |
| `silentsuite-addon-lib.sh` | helpers shared by those scripts |
| `install.sh` | unchanged copy of `self-host/install.sh` |
| `silentsuite-release` | the pinned release tag |
| `silentsuite.svg` | portal icon (the SilentSuite logo) |
| `LICENSE` | AGPL-3.0-only, as for the rest of the server and self-host code |
| `README.md` | this document |

Installing the package does not start anything. It has no maintainer scripts.

## Installing

1. Upload the `.deb` in the portal's add-on management, or run
   `apt install ./libre-workspace-module-silentsuite_<version>_all.deb`.
2. Install **SilentSuite** from the portal. The portal runs
   `setup_silentsuite.sh`.
3. Make sure `silentsuite.<your domain>` resolves to the server.

The package's own dependencies cover the shell tools setup uses (`curl`,
`openssl`, `tar`, and `ss` from `iproute2`). It does not depend on Docker
Engine, Docker Compose v2, Caddy or systemd. Libre Workspace provides those,
and setup checks for them before it changes anything.

Setup stops without changing anything if:

- `docker`, `docker compose`, `caddy`, `systemctl` or `ss` is missing, or the
  Docker daemon does not answer (an unanswered query never counts as "nothing
  exists");
- `DOMAIN` is not a valid lower-case DNS name;
- `/root/silentsuite` already exists, meaning the add-on is installed or an
  earlier attempt left it behind;
- a `silentsuite-postgres` or `silentsuite-server` container already exists;
- a `silentsuite-server_pgdata` or `silentsuite-server_server_data` volume
  already exists, which happens after an earlier installation was removed;
- port 3735 is in use, or `ss` cannot tell;
- the Caddyfile is a symbolic link or has other hard links. The add-on
  replaces the Caddyfile by rename, which would detach a file managed
  elsewhere, so it refuses instead;
- the Caddyfile already has a SilentSuite block or a site for the host;
- `caddy validate` rejects the new configuration.

Caddy runs on the host and reaches the server's loopback-only port through
Docker's port publishing. The server therefore sees Caddy's connections coming
from the gateway address of its Compose network, not from `127.0.0.1`. After
the installer starts the server, setup does three things:

- sets `TRUSTED_PROXY_IPS` in the install directory's `.env` to `127.0.0.1`
  plus that one gateway address (no subnet ranges);
- records the address in `/root/silentsuite/addon-state`;
- recreates only the server container.

Without this, the server ignores Caddy's `X-Forwarded-Proto` header and
redirects every HTTPS request back to itself. Setup stops without guessing if
the server is on more than one network, has no IPv4 gateway, or the installer
wrote a different `TRUSTED_PROXY_IPS` value. The port stays published on
`127.0.0.1` only.

The Caddyfile is changed by writing a staged copy beside it, with the same
owner and mode, and renaming it into place. A failed or interrupted write
never truncates the live file. If setup fails or is stopped (SIGINT/SIGTERM)
after it started changing the Caddyfile, it puts the previous one back.

If setup fails after the server was created (the installer fails, the
containers are unhealthy, the Caddyfile cannot be written, Caddy does not
reload, or the task is stopped), it restores the previous Caddyfile and stops
the containers without deleting their volumes. What happens next depends on
whether the containers are really gone.

**All containers are gone.** Setup moves the files to
`/root/silentsuite-failed-<UTC time>`, and the portal shows the add-on as not
installed. The data volumes are kept, so a new installation is refused. Look
into the cause first. Then either keep the data, or delete it as described in
[Deleting the data](#deleting-the-data).

**A container is still there, or Docker cannot say, or the Caddyfile could not
be restored.** Setup leaves `/root/silentsuite` in place, and the portal still
lists the add-on as installed. The output names the containers, or the
Caddyfile backup to restore by hand. Remove the add-on from the portal first.
Do **not** delete volumes while any SilentSuite container exists.

The installer's standard output is not shown because it contains the one-time
signup token. Its error messages are shown.

## Creating the first account

Setup writes instructions to `/root/silentsuite/FIRST-ACCOUNT.txt`. They
contain no secrets. In short:

1. As root, read the one-time token:
   `grep '^ETEBASE_BOOTSTRAP_ADMIN_TOKEN=' /root/silentsuite/silentsuite-server/.env`
2. In a SilentSuite app, go to sign up, open **Advanced Settings** and use
   `https://silentsuite.<your domain>/?bootstrap_token=<token>` as the server URL.
3. Create your account.
4. Close registration immediately:
   `cd /root/silentsuite/silentsuite-server && ./close-signups.sh`

Do not share the token. Until the first account exists, signups without the
token are refused. Until you close registration, anyone who can reach the
server can create an account.

## Updates

The portal's update action and nightly updates run `update_silentsuite.sh`.
It changes nothing and says so. It never pulls images, follows mutable tags,
restarts the server or rewrites settings.

### Trusted proxy address

Update does run one read-only check with `docker inspect`. It compares three
values: the trusted proxy address recorded in `/root/silentsuite/addon-state`
(`trusted_proxy=`), the `TRUSTED_PROXY_IPS` line in the install directory's
`.env`, and the current gateway of the server container's network. It warns
if:

- no address is recorded;
- `.env` does not trust exactly `127.0.0.1,<recorded address>`;
- the check cannot be made (Docker does not answer, the server container is
  missing, or it is not on exactly one network with an IPv4 gateway);
- the gateway differs from the recorded address. This can happen if the
  Compose network was recreated, for example by a manual `docker compose down`
  followed by `up`. Caddy's HTTPS requests are then redirected again.

To re-pin by hand, as root (nothing below prints a secret):

```bash
docker inspect --format '{{range $n, $net := .NetworkSettings.Networks}}{{$n}} {{$net.Gateway}}{{"\n"}}{{end}}' silentsuite-server
# Expect exactly one line: "<network> <IPv4 gateway>". Use that one address as G.
G=172.18.0.1   # replace with the gateway printed above
cd /root/silentsuite/silentsuite-server
sed -i "s/^TRUSTED_PROXY_IPS=.*/TRUSTED_PROXY_IPS=127.0.0.1,$G/" .env
sed -i "s/^trusted_proxy=.*/trusted_proxy=$G/" ../addon-state
docker compose -p silentsuite-server up -d --force-recreate --no-deps server
```

Trust only that single address. Never trust a subnet or `*`.

A newer add-on package only changes the release used by **new**
installations. It does not change a running server. The release that is
installed is recorded in `/root/silentsuite/addon-state`. Moving an existing
server to a newer release is a manual step: back up first (`backup.sh` in the
install directory) and follow [SELF-HOSTING.md](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md).

## Removing

Removing the add-on in the portal runs `remove_silentsuite.sh`. It:

1. checks the Caddyfile holds exactly the block setup wrote, then validates the
   configuration without it. Otherwise it stops and changes nothing;
2. stops the containers with `docker compose down`, **without** `--volumes`.
   If any SilentSuite container is still there afterwards, or Docker cannot
   say, it stops here: the Caddyfile and `/root/silentsuite` are left as they
   were;
3. removes only the SilentSuite block from the Caddyfile (staged copy and
   rename, as in setup) and reloads Caddy. If the write fails, Caddy fails to
   reload, or removal is stopped (SIGINT/SIGTERM) before the reload succeeds,
   it restores the previous Caddyfile and keeps `/root/silentsuite`;
4. moves `/root/silentsuite` to `/root/silentsuite-removed-<UTC time>`.

**User data is kept.** The database and server data stay in the Docker volumes
`silentsuite-server_pgdata` and `silentsuite-server_server_data`. The
configuration and its secrets stay in the moved directory. This differs from
the upstream add-on convention on purpose, so a click in the portal cannot
erase data. A new installation is refused while those volumes exist.

### Uninstalling the package

Remove the add-on from the portal **before** you uninstall the package with
`apt remove` or `apt purge`. The package has no maintainer scripts, so
uninstalling it while the add-on is installed only deletes the lifecycle
scripts. The containers, the Caddy site and the data stay behind with no
packaged way to remove them. Reinstalling the same package version brings the
scripts back.

### Recovering an interrupted setup

If setup was killed outright (for example with SIGKILL, or by a power loss)
before it recorded `/root/silentsuite/addon-state`, removal refuses to act. It
cannot tell what was installed. Setup also refuses, because
`/root/silentsuite` exists. To recover without losing data, as root:

1. Check for containers with `docker ps -a --filter name=silentsuite-`. If
   `/root/silentsuite/silentsuite-server/docker-compose.yml` exists, run
   `docker compose -p silentsuite-server down` in that directory. Do not add
   `--volumes`.
2. If the Caddyfile has a `# BEGIN silentsuite add-on` block, delete that block
   by hand, run `caddy validate --config /etc/caddy/Caddyfile`, then
   `systemctl reload caddy`.
3. Move the marker aside instead of deleting it:
   `mv /root/silentsuite /root/silentsuite-recovered-$(date -u +%Y%m%dT%H%M%SZ)`.

Any data volumes left behind still block a new installation until you delete
them, as described below.

### Deleting the data

This cannot be undone. Make a backup first if you might need the data. Only
do this after removal, when `docker ps -a --filter name=silentsuite-` shows
no SilentSuite container.

```bash
docker volume rm silentsuite-server_pgdata silentsuite-server_server_data
rm -rf /root/silentsuite-removed-<UTC time>   # or /root/silentsuite-failed-<UTC time>
```

## Testing

```bash
integrations/libre-workspace/tests/lifecycle.test.sh
```

The tests run the real setup, update, remove and build scripts in temporary
fixtures. `docker`, `caddy`, `systemctl`, `id`, `ss` and `sleep` are stubs, and
the installer is a stub that prints a fake token so the tests can check it is
never shown. They also check the refusal and rollback rules above, and that
the Caddyfile is byte-identical after removal.

`tests/runtime-smoke.sh` is a deployment runtime smoke. It runs only in CI, on
a disposable GitHub-hosted runner (workflow `libre-workspace-addon.yml`), and
refuses to run anywhere else. It covers:

- the built `.deb`, unpacked to the module path with `dpkg-deb -x`;
- the packaged setup, update and remove scripts, run as root the way the portal
  runs them;
- the real release download and verification, and the pinned server and
  PostgreSQL images;
- Ubuntu's `caddy` service serving `https://silentsuite.int.de` with Caddy's
  internal CA.

It checks:

- both containers are healthy and migrations are in PostgreSQL;
- HTTPS works with a verified certificate;
- the first signup is refused without the token and with a wrong token, and
  accepted with the stored token;
- no secret appears in any script output;
- update does not touch the containers;
- remove keeps the volumes and restores the Caddyfile byte-for-byte;
- a reinstall over the kept data is refused.

The Libre Workspace portal is not installed there. The Addon Center, task
queue, dashboard tile, icon, hosts and DNS entries, and a public certificate
are untested. Neither test replaces an install on a real Libre Workspace
server.

## License

AGPL-3.0-only, like the rest of the SilentSuite server and self-host code
(see [LICENSE](https://github.com/silent-suite/silentsuite/blob/main/LICENSE)).

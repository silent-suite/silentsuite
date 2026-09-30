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

If setup fails after the server was created (the installer fails, the
containers are unhealthy, or Caddy does not reload), it:

- stops the containers but keeps their volumes;
- restores the previous Caddyfile;
- moves the files to `/root/silentsuite-failed-<UTC time>`.

If any SilentSuite container is still there after `docker compose down`, or
Docker cannot say, setup leaves `/root/silentsuite` in place. The portal then
still lists the add-on as installed, and the output names the containers.
Remove the add-on from the portal before retrying.

The portal then shows the add-on as not installed. Before retrying, look into
the cause and then delete the data (see [Deleting the data](#deleting-the-data)).

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
It does nothing and says so. It never pulls images, follows mutable tags or
restarts the server.

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
3. removes only the SilentSuite block from the Caddyfile and reloads Caddy.
   If Caddy fails to reload, it restores the previous Caddyfile;
4. moves `/root/silentsuite` to `/root/silentsuite-removed-<UTC time>`.

**User data is kept.** The database and server data stay in the Docker volumes
`silentsuite-server_pgdata` and `silentsuite-server_server_data`. The
configuration and its secrets stay in the moved directory. This differs from
the upstream add-on convention on purpose, so a click in the portal cannot
erase data. A new installation is refused while those volumes exist.

### Deleting the data

This cannot be undone. Make a backup first if you might need the data.

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

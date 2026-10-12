# Configuration Reference

Compose and container runtime settings are environment variables in the `.env` file, which `install.sh` generates. The hostnames the server accepts and the server's own database connection come from `etebase-server.ini`, which the installer also generates and mounts into the container (see below). The PostgreSQL credentials in `.env` configure the database container and must match the `[database]` section of that ini file.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SILENTSUITE_SERVER_IMAGE` | Yes | -- | The verified server image digest the installer wrote. Compose has no default and refuses to start without it. Do not edit by hand. |
| `SERVER_PORT` | No | `3735` | Host loopback port Docker publishes the server on (`127.0.0.1:SERVER_PORT`). Your reverse proxy forwards traffic here. |
| `DATABASE_PASSWORD` | Yes | -- | Password for the PostgreSQL `silentsuite` user. Must match the `password` in the `[database]` section of `etebase-server.ini`. |
| `SUPER_USER` | No | `admin` | Username for the Django admin panel at `https://your-domain/admin/`. |
| `SUPER_PASS` | No | -- | Password for the Django admin panel; the installer generates one. When both `SUPER_USER` and `SUPER_PASS` are set, the container creates that admin login on first start if it does not exist yet. These credentials only open the admin panel; they are not a SilentSuite account you can sign in with from the app. |
| `ETEBASE_DISABLE_SIGNUP` | No | `false` | `false` allows new registrations (needed for your first signup). `./close-signups.sh` sets it to `true`. |
| `ETEBASE_BOOTSTRAP_ADMIN_TOKEN` | No | empty | One-time token the first signup must pass as `?bootstrap_token=...` in the server URL while the server has no users. The installer generates it; leaving it empty does not protect the first signup. |
| `ETEBASE_DISABLE_DJANGO_ADMIN` | No | `true` | Hides the Django `/admin/` panel. Set to `false` to enable it; see [Admin Panel](./admin-dashboard.md) before exposing it. |
| `TRUSTED_PROXY_IPS` | No | `127.0.0.1` | Comma-separated exact reverse proxy IPs allowed to set `X-Forwarded-*` headers. CIDR ranges are not supported. |

After changing a server runtime setting in `.env` (`SUPER_USER`, `SUPER_PASS`, `ETEBASE_DISABLE_SIGNUP`, `ETEBASE_BOOTSTRAP_ADMIN_TOKEN`, `ETEBASE_DISABLE_DJANGO_ADMIN`, `TRUSTED_PROXY_IPS`, `SERVER_PORT`), recreate the server container:

```bash
docker compose up -d --force-recreate server
```

The PostgreSQL values (`DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`) are different. They initialize a fresh database the first time the PostgreSQL volume is created; an existing database keeps its stored name, user, and password regardless of what `.env` or `etebase-server.ini` later say. Changing them on an existing installation requires making the corresponding change inside PostgreSQL first, then updating `.env` and the `[database]` section of the ini to match. Recreating containers alone does not apply such a change, and the server will fail to start on a mismatched password. Never delete the database volume to apply a configuration change; that destroys every account and sync row.

## Advanced Variables

These have sensible defaults and rarely need changing:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_NAME` | `silentsuite` | PostgreSQL database name. Must match `name` in the `[database]` section of `etebase-server.ini`. |
| `DATABASE_USER` | `silentsuite` | PostgreSQL username. Must match `user` in the `[database]` section of `etebase-server.ini`. |
| `PROXY_NETWORK` | unset | Recorded by the installer when you name a Docker reverse-proxy network. The network itself is wired by the generated `docker-compose.override.yml`. |

## Host Settings: `etebase-server.ini`

The domain the server accepts and the database connection are read from `etebase-server.ini`, mounted read-only at `/etc/etebase-server/etebase-server.ini` inside the container. The installer writes the domain you entered into `[allowed_hosts]`. There is no `ALLOWED_HOSTS` or `DOMAIN` variable in `.env`; setting one has no effect.

```ini
[allowed_hosts]
allowed_host1 = sync.example.com
allowed_host2 = localhost
```

To change the domain, edit this section (add `allowed_hostN = your.domain`) and restart the server:

```bash
docker compose restart server
```

## Security Note

The `.env` file contains secrets. Restrict its permissions:

```bash
chmod 600 .env
```

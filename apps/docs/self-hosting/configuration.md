# Configuration Reference

All configuration is done through environment variables in the `.env` file.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVER_PORT` | No | `3735` | Port the SilentSuite server listens on. Your reverse proxy forwards traffic here. |
| `DATABASE_PASSWORD` | Yes | -- | Password for the PostgreSQL `silentsuite` user. |
| `SUPER_USER` | No | `admin` | Username for the admin panel at `https://your-domain/admin/`. |
| `SUPER_PASS` | Yes | -- | Password for the admin panel. |
| `ALLOWED_HOSTS` | Yes | `localhost` | Comma-separated hostnames the server will accept. Set this to your domain (e.g., `sync.example.com,localhost`). Requests with a `Host` header not in this list will be rejected. |

## Advanced Variables

These have sensible defaults and rarely need changing:

| Variable | Default | Description |
|---|---|---|
| `AUTO_UPDATE` | `false` | Set to `true` to automatically update the Etebase server on container restart. |
| `DATABASE_NAME` | `silentsuite` | PostgreSQL database name. |
| `DATABASE_USER` | `silentsuite` | PostgreSQL username. |

## Example .env

```bash
SERVER_PORT=3735
DATABASE_PASSWORD=a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV
SUPER_USER=admin
SUPER_PASS=xYz123AbCdEf
ALLOWED_HOSTS=sync.example.com,localhost
```

## Security

The `.env` file contains secrets. Restrict its permissions:

```bash
chmod 600 .env
```

Never commit `.env` to version control. It is already listed in `.gitignore`.

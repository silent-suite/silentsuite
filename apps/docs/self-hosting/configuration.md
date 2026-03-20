# Configuration Reference

All configuration is done through environment variables in the `.env` file.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOMAIN` | Yes | -- | Your domain name. The SilentSuite server runs at `https://DOMAIN`. |
| `DATABASE_PASSWORD` | Yes | -- | Password for the PostgreSQL `silentsuite` user. |
| `SUPER_USER` | No | `admin` | Username for the admin panel at `https://DOMAIN/admin/`. |
| `SUPER_PASS` | Yes | -- | Password for the admin panel. |

## Advanced Variables

These have sensible defaults and rarely need changing:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_NAME` | `silentsuite` | PostgreSQL database name. |
| `DATABASE_USER` | `silentsuite` | PostgreSQL username. |

## Security Note

The `.env` file contains secrets. Restrict its permissions:

```bash
chmod 600 .env
```

# Configuration Reference

All configuration is done through environment variables in the `.env` file.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOMAIN` | Yes | `silentsuite.example.com` | Your domain. The app runs at `https://DOMAIN` and sync at `https://sync.DOMAIN`. |
| `POSTGRES_PASSWORD` | Yes | -- | Password for the main PostgreSQL superuser (`silentsuite`). |
| `ETEBASE_DB_PASSWORD` | Yes | -- | Password for the `etebase_user` PostgreSQL role. Used by the Etebase server to access the database. |
| `ETEBASE_ADMIN_USER` | Yes | `admin` | Username for the Etebase admin account. |
| `ETEBASE_ADMIN_PASSWORD` | Yes | -- | Password for the Etebase admin account. |

## Security Note

The `.env` file contains secrets. Restrict its permissions:

```bash
chmod 600 .env
```

# Admin Dashboard

The SilentSuite server includes a built-in admin panel powered by Django.

## Accessing the Admin Panel

Go to `https://your-domain/admin/` and log in with the `SUPER_USER` and `SUPER_PASS` credentials from your `.env` file.

If you're testing locally without a reverse proxy: `http://localhost:3735/admin/`

## What You Can Do

- **Manage user accounts** -- view, create, and delete users.
- **View collections** -- inspect the encrypted data collections stored on your server (you can see metadata, but the contents are encrypted).
- **Monitor database state** -- review the internal state of the sync server.

## Feature Access

In self-hosted mode, all features are unlocked for every user. There are no subscription tiers or feature gates.

## Creating Additional Admin Users

```bash
docker exec -it silentsuite-server python manage.py createsuperuser
```

Follow the prompts to set a username, email, and password.

## Resetting the Admin Password

If you've lost your admin password:

```bash
docker exec -it silentsuite-server python manage.py changepassword admin
```

Replace `admin` with your `SUPER_USER` name if you changed it.

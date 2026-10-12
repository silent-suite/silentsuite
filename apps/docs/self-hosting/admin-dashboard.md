# Admin Dashboard

The SilentSuite server includes a built-in admin panel powered by Django.

## Accessing the Admin Panel

The admin panel is disabled by default: the installer writes `ETEBASE_DISABLE_DJANGO_ADMIN=true` to `.env`, and the server does not register the `/admin/` route while that is set. To enable it, set `ETEBASE_DISABLE_DJANGO_ADMIN=false` in `.env` and recreate the server container:

```bash
docker compose up -d --force-recreate server
```

Only enable it when you need it, and protect `/admin/` with your reverse proxy or an access gateway before exposing it on your public sync domain.

Then go to `https://your-domain/admin/` and log in with the `SUPER_USER` and `SUPER_PASS` credentials from your `.env` file. These credentials open the Django admin panel only; they are not a SilentSuite account for the app. The first user to sign up through the app becomes the server admin.

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

# Admin Panel

The SilentSuite server includes a built-in admin panel for managing your instance.

## Accessing the Admin Panel

The admin panel is disabled by default: the installer writes `ETEBASE_DISABLE_DJANGO_ADMIN=true` to `.env`, and the server does not register the `/admin/` route while that is set. To enable it, set `ETEBASE_DISABLE_DJANGO_ADMIN=false` in `.env` and recreate the server container:

```bash
docker compose up -d --force-recreate server
```

Only enable it when you need it, and protect `/admin/` with your reverse proxy or an access gateway before exposing it on your public sync domain.

Then go to `https://your-domain.com/admin/` and log in with the `SUPER_USER` and `SUPER_PASS` credentials from your `.env` file. These credentials open the Django admin panel only; they are not a SilentSuite account for the app. The first user to sign up through the app becomes the server admin.

## Features

The admin panel allows you to:

- **Manage user accounts** -- view, create, and delete user accounts.
- **View collections** -- inspect the encrypted data collections stored on your server.
- **Monitor database state** -- review the internal state of the server.

## Feature Access

In self-hosted mode, all features are unlocked for every user on the instance. There are no subscription tiers or feature gates. Every account has full access to the complete SilentSuite feature set.

## Creating Additional Admin Users

```bash
docker exec -it silentsuite-server python manage.py createsuperuser
```

Follow the prompts to create a new admin account.

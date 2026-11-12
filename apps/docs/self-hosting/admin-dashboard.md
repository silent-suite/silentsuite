# Admin Dashboard

The SilentSuite server includes a built-in admin panel powered by Django.

## Accessing the Admin Panel

The admin panel is disabled by default: the installer writes `ETEBASE_DISABLE_DJANGO_ADMIN=true` to `.env`, and the server does not register the `/admin/` route while that is set. To enable it, set `ETEBASE_DISABLE_DJANGO_ADMIN=false` in `.env` and recreate the server container:

```bash
docker compose up -d --force-recreate server
```

Only enable it when you need it, and protect `/admin/` with your reverse proxy or an access gateway before exposing it on your public sync domain.

Then go to `https://your-domain/admin/` and log in with the `SUPER_USER` and `SUPER_PASS` credentials from your `.env` file. These credentials open the Django admin panel only; they are not a SilentSuite account for the app. The first account to sign up through the app is an ordinary user account; signing up does not make it a server administrator. The admin login is a separate user, created by the server container at startup from `SUPER_USER` and `SUPER_PASS`.

If you're testing locally without a reverse proxy: `http://localhost:3735/admin/`

## What You Can Do

- **Manage user accounts** -- view, create, and delete users.
- **View collections** -- inspect the encrypted data collections stored on your server (you can see metadata, but the contents are encrypted).
- **Monitor database state** -- review the internal state of the sync server.

## Delete a User

User deletion is a Django admin action:

1. Enable the admin panel as described above.
2. Go to `https://your-domain/admin/` and log in with your `SUPER_USER` and `SUPER_PASS` credentials.
3. Open **Users**, select the account, and delete it. App accounts are the users people created by signing up in the app; leave the `SUPER_USER` row alone.
4. Set `ETEBASE_DISABLE_DJANGO_ADMIN=true` in `.env` again and recreate the server container to hide the panel.

Deleting an app account removes the user and its collections from the server
database. Encrypted attachment files can stay in the server's media volume
until you remove the volumes; see [Uninstalling](./uninstalling.md) if you are
taking the server down.

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

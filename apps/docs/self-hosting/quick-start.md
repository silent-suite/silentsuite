# Quick Start

The fastest path from zero to a running SilentSuite server. Make sure you've met the [requirements](./requirements.md) first.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

The installer will:

1. Check that Docker and Docker Compose are installed.
2. Create a `silentsuite-server/` directory in your current folder.
3. Download the Docker Compose configuration.
4. Ask for your domain name (e.g., `sync.example.com`).
5. Generate strong random passwords for PostgreSQL.
6. Write the `.env` file.
7. Pull Docker images and start the containers.
8. Wait for health checks to pass.

The first user to sign up in the SilentSuite app becomes the server admin.

## 2. Set Up Your Reverse Proxy

The SilentSuite server listens on `127.0.0.1:3735`. You need a reverse proxy to handle HTTPS and forward traffic to it.

**Caddy** (easiest -- automatic HTTPS):
```
sync.example.com {
    reverse_proxy localhost:3735
}
```

**nginx:**
```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3735;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 50m;
    }
}
```

**Cloudflare Tunnel** (no open ports needed):
```bash
cloudflared tunnel --url http://localhost:3735
```

**Nginx Proxy Manager** or other Docker-based proxies:

If your reverse proxy runs in Docker, connect it to the SilentSuite network:
```bash
docker network connect silentsuite-server_silentsuite <proxy_container>
```
Then use `silentsuite-server:3735` as the upstream instead of `localhost:3735`.

See the [SELF-HOSTING.md](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md) in the repo for more reverse proxy examples (Traefik, security headers).

## 3. Verify

```bash
cd silentsuite-server
./verify.sh
```

Both services should show `[OK]`.

Then test from outside your server:

```bash
curl -s https://sync.example.com/ | head -5
```

You should get a response from the Etebase server (not a connection error or TLS warning).

## 4. Connect Your Apps

1. Open [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile app.
2. On the signup page, expand **Advanced Settings**.
3. Enter `https://sync.example.com` (your domain) as the server URL.
4. Create your account and start syncing -- you'll be the admin!

Your data is end-to-end encrypted. The server never sees your plaintext calendar entries, contacts, or tasks.

## Next Steps

- [Configuration](./configuration.md) -- understand and customize your environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage users via the web app admin panel.
- [Backup & Restore](./backup-and-restore.md) -- set up automated backups.
- [Updating](./updating.md) -- keep your instance up to date.

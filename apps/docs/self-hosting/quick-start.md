# Quick Start

The fastest path from zero to a running SilentSuite server. Make sure you've met the [requirements](./requirements.md) first.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
```

The installer will:

1. Check that Docker, Docker Compose, and the download-verification tools are installed.
2. Resolve the newest published release that ships verified self-host assets.
3. Download the release bundle, its checksum, and `server-image.json`, then verify the checksum, the manifest, and the archive contents before extracting anything.
4. Confirm with GitHub that the release tag points at the commit the manifest names, and confirm the registry serves the promised image digest, revision, and architecture.
5. Create a `silentsuite-server/` directory in your current folder — only after every check above has passed.
6. Ask for your domain name (e.g., `sync.example.com`).
7. Generate strong random passwords for PostgreSQL.
8. Write the `.env` file, including the verified server image digest.
9. Pull the pinned images, start the containers, and wait for health checks to pass.

The first user to sign up in the SilentSuite app becomes the server admin.

To inspect a release before installing it, stage it first. Staging verifies the
release tag, the bundle checksum, the manifest, and the archive contents, then
writes the files out without installing, pulling an image, or starting a
container:

```bash
bash install.sh --version vX.Y.Z --stage-only ./silentsuite-vX.Y.Z
```

Staging deliberately stops before the registry image-identity check, because
that check pulls the image. A real install performs it; staging reports the
digest the manifest names, not one it confirmed.

Three different scopes of verification are involved, and it is worth keeping
them apart:

- **CI**, before any release exists, verifies the complete two-platform image
  index — both architecture digests, their config, labels, and platforms.
- **A host install** verifies the one image *this host* pulls: its repository
  digest against the manifest, its platform against this machine, and its build
  revision against the release commit. It does the same for the digest-pinned
  PostgreSQL image.
- **`--stage-only`** verifies only the metadata: tag, checksum, manifest, and
  archive contents.

## 2. Set Up Your Reverse Proxy

Docker publishes the SilentSuite server on host loopback at `127.0.0.1:3735`. You need a reverse proxy to handle HTTPS and forward traffic to it.

**Caddy** (easiest -- automatic HTTPS):
```
sync.example.com {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
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

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

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

If your reverse proxy runs in Docker, connect it to the SilentSuite network. The
network's physical name depends on your Compose project, so read it off the
running server container rather than typing one from documentation:
```bash
docker inspect --format '{{range $net, $_ := .NetworkSettings.Networks}}{{$net}}{{"\n"}}{{end}}' silentsuite-server
# Replace these two placeholders with an exact name printed above and your proxy container.
docker network connect NETWORK_NAME PROXY_CONTAINER_NAME
```
Then use `silentsuite-server:3735` as the upstream instead of `localhost:3735`.
Set `TRUSTED_PROXY_IPS` in `.env` to the proxy container's exact IP so the server
only trusts forwarded headers from that proxy. Multiple values are
comma-separated, for example `TRUSTED_PROXY_IPS=127.0.0.1,172.18.0.5`. Uvicorn
matches exact IPs here; CIDR ranges are not supported.

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

- [Troubleshooting](./troubleshooting.md) -- common install, reverse proxy, and health-check problems.
- [Configuration](./configuration.md) -- understand and customize your environment variables.
- [Admin Dashboard](./admin-dashboard.md) -- manage users via the web app admin panel.
- [Backup & Restore](./backup-and-restore.md) -- set up automated backups.
- [Updating](./updating.md) -- keep your instance up to date.

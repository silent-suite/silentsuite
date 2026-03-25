# Architecture

SilentSuite self-hosting runs two containers on a single Docker network. You provide your own reverse proxy for HTTPS.

## Overview

```
    Your Server                         SilentSuite Apps
  ┌─────────────────┐
  │  Your Reverse   │◄──────────── app.silentsuite.io
  │  Proxy (HTTPS)  │              (or mobile apps)
  └────────┬────────┘              enter your server URL
           │                       in Advanced Settings
  ┌────────┴────────┐
  │   SilentSuite   │
  │     Server      │
  │      :3735      │
  └────────┬────────┘
           │
  ┌────────┴────────┐
  │  PostgreSQL 16  │
  │    (internal)   │
  └─────────────────┘
```

## Service Roles

| Service | Image | Role |
|---|---|---|
| **SilentSuite Server** | `victorrds/etebase` | Sync server built on the Etebase protocol. Handles encrypted data sync, user authentication, and the admin panel. All data is encrypted client-side; the server never sees plaintext. |
| **PostgreSQL** | `postgres:16-alpine` | Database. Stores encrypted sync data and user accounts. Only accessible within the Docker network. |

## Network and Security

- Both services run on an internal Docker bridge network (`silentsuite`).
- PostgreSQL is not exposed to the host -- only the server container can reach it.
- The SilentSuite server binds to `127.0.0.1:3735` -- not directly accessible from the network.
- You bring your own reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) for TLS termination.
- All sync data is end-to-end encrypted. The server stores only ciphertext.

## Why No Web App Container?

Self-hosters only need the sync server. Users access SilentSuite through:

- **[app.silentsuite.io](https://app.silentsuite.io)** -- the hosted web app (works with any SilentSuite server)
- **SilentSuite mobile apps** -- available for Android

Both support entering a custom server URL in Advanced Settings during signup or login. This keeps the self-hosted stack minimal (2 containers) while giving users the full SilentSuite experience.

## Data Volumes

| Volume | Purpose |
|---|---|
| `pgdata` | PostgreSQL data directory |
| `server_data` | Server secret key and media files |

Both volumes are Docker named volumes. They persist across container restarts and updates.

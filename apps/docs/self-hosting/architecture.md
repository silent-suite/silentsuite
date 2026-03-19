# Architecture

SilentSuite self-hosting runs three containers on a single Docker network. Caddy is the only service exposed to the internet. Users connect via [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps.

## Overview

```
    Your Server                         SilentSuite Apps
  ┌─────────────────┐
  │  Caddy (HTTPS)  │◄──────────── app.silentsuite.io
  │       :443      │              (or mobile apps)
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
| **Caddy** | `caddy:2-alpine` | Reverse proxy. Terminates TLS, routes requests to the SilentSuite server. Automatically provisions and renews Let's Encrypt certificates. |
| **SilentSuite Server** | `victorrds/etebase` | Sync server built on the Etebase protocol. Provides end-to-end encrypted data sync. All data is encrypted client-side; the server never sees plaintext. |
| **PostgreSQL** | `postgres:16-alpine` | Database. Stores encrypted sync data and user accounts. |

## Network and Security

- All services run on an internal Docker bridge network.
- No service except Caddy binds to host ports.
- Services communicate by container name (e.g., `postgres:5432`, `server:3735`).
- Caddy adds security headers to all responses: HSTS, X-Frame-Options, X-Content-Type-Options, and more.
- All sync data is end-to-end encrypted. The server never has access to your plaintext data.

## Why No Web App Container?

Self-hosters only need the sync server. Users access SilentSuite through:

- **[app.silentsuite.io](https://app.silentsuite.io)** -- the hosted web app (works with any SilentSuite server)
- **SilentSuite mobile apps** -- available for Android and iOS

Both support entering a custom server URL in Advanced Settings during signup or login. This keeps the self-hosted stack minimal (3 containers, 3 env vars) while giving users the full SilentSuite experience.

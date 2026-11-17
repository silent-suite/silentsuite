# Architecture

SilentSuite self-hosting runs two containers on a single Docker network: PostgreSQL and the SilentSuite sync server. You provide your own reverse proxy in front of the stack to terminate TLS and forward traffic to the server. Users connect from [app.silentsuite.io](https://app.silentsuite.io) or the SilentSuite mobile apps.

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
| **SilentSuite Server** | `ghcr.io/silent-suite/silentsuite-server` (pinned per release by digest) | Sync server built on the [Etebase protocol](https://www.etebase.com/). Provides end-to-end encrypted data sync. All data is encrypted client-side; the server never sees plaintext. |
| **PostgreSQL** | `postgres`, pinned to the immutable OCI index digest of 16.16-alpine | Database. Stores encrypted sync data and user accounts. Existing installations keep their installed digest. |

Neither image is referenced by a mutable tag. PostgreSQL is pinned to
`postgres@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e`, and the server image comes from `SILENTSUITE_SERVER_IMAGE`, which the
installer writes as the release's immutable index digest.

The reverse proxy is **not** part of the stack — pick whatever you already run (Caddy, nginx, Traefik, Cloudflare Tunnel) and forward HTTPS traffic to `127.0.0.1:3735`. Examples for each are in [SELF-HOSTING.md](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md#reverse-proxy-examples).

## Network and Security

- Both containers run on an internal Docker bridge network and communicate by container name (e.g., `postgres:5432`).
- PostgreSQL is not exposed to the host.
- The SilentSuite server binds only to `127.0.0.1:3735`, so it is not reachable from the network without a reverse proxy on the same host.
- TLS termination, security headers, and ACME certificate provisioning are the reverse proxy's job — see the [recommended security headers](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md#recommended-security-headers).
- All sync data is end-to-end encrypted. The server never has access to your plaintext data.

## Why No Web App Container?

Self-hosters only need the sync server. Users access SilentSuite through:

- **[app.silentsuite.io](https://app.silentsuite.io)** -- the hosted web app (works with any SilentSuite server)
- **SilentSuite mobile app** -- available for Android. iOS is not supported yet; a native app is planned.

The web and Android apps support entering a custom server URL in Advanced Settings during signup or login. This keeps the self-hosted stack minimal (two containers, a handful of env vars) while giving users the supported SilentSuite experience.

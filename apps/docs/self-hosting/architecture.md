# Architecture

SilentSuite runs as four containers on a single Docker network. Caddy is the only service exposed to the internet. All inter-service communication happens on an internal bridge network.

## Overview

```
                           Internet
                              |
                       [ Ports 80/443 ]
                              |
                        +----------+
                        |  Caddy   |
                        | (HTTPS)  |
                        +----+-----+
                             |
                      +------+------+
                      |             |
                DOMAIN/        sync.DOMAIN/
                      |             |
                 +----+----+  +----+------+
                 |   Web   |  |  Etebase  |
                 | Next.js |  |  (Sync)   |
                 | :3000   |  |  :3735    |
                 +---------+  +-----+-----+
                                    |
                             +------+------+
                             | PostgreSQL  |
                             |    :5432    |
                             +-------------+
```

## Service Roles

| Service | Image | Role |
|---|---|---|
| **Caddy** | `caddy:2-alpine` | Reverse proxy. Terminates TLS, routes requests to internal services by subdomain. Automatically provisions and renews Let's Encrypt certificates. |
| **Web** | `ghcr.io/silent-suite/silentsuite-web` | Next.js frontend. Serves the web application, including the built-in admin dashboard. Communicates with the Etebase server via its public URL (through Caddy). |
| **Etebase** | `victorrds/etebase` | EteSync server. Provides end-to-end encrypted data sync. Connects to PostgreSQL. All data is encrypted client-side; the server never sees plaintext. |
| **PostgreSQL** | `postgres:16-alpine` | Database. Used by Etebase for storing encrypted sync data and user accounts. |

## Network and Security

- All services run on an internal Docker bridge network (`silentsuite`).
- No service except Caddy binds to host ports.
- Services communicate by container name (e.g., `postgres:5432`, `etebase:3735`).
- Caddy adds security headers to all responses: HSTS, X-Frame-Options, X-Content-Type-Options, and more.
- All features are unlocked in self-hosted mode. No external licensing or subscription service is contacted.

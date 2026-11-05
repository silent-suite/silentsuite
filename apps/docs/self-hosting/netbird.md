# Using NetBird

[NetBird](https://netbird.io) can put your SilentSuite server online in two quite different ways. Pick the one that matches your setup, do the common steps, then follow your path.

This guide covers the SilentSuite sync server (the URL you enter in the apps under **Advanced Settings**). It doesn't cover installing NetBird itself or its TCP/UDP services. The settings here follow the NetBird documentation and SilentSuite's own server configuration. NetBird's reverse proxy is still in beta, so check the NetBird pages linked below if anything in its dashboard looks different.

## Choose your path

| | A. NetBird reverse proxy | B. Your own proxy, NetBird as the network |
|---|---|---|
| Who handles HTTPS | NetBird | Caddy, nginx or Traefik |
| Public URL | A NetBird proxy domain or your own domain (CNAME) | Your own domain |
| Who can connect | Anyone on the internet, or only NetBird peers if you choose NetBird-Only Access | Only NetBird peers (private), or anyone if the proxy runs on a public server |
| Works with NetBird Cloud | Yes | Yes |
| Works with self-hosted NetBird | Yes, once NetBird's proxy is deployed | Yes |

**Public versus peer-only.** If the URL is public, phones and laptops can sync from anywhere without running NetBird. If access is peer-only, every device that syncs must be connected to your NetBird network, including the phone in your pocket and the browser you use for [app.silentsuite.io](https://app.silentsuite.io). A device that drops off the mesh simply can't reach the server until it reconnects.

**NetBird access is not your SilentSuite account.** NetBird decides which machines can reach the server. It doesn't sign anyone in to SilentSuite. People still create a SilentSuite account in the app and sign in with it as usual, the first account still needs the bootstrap token, and your data stays end-to-end encrypted either way.

### DNS points; it doesn't forward

Your sync domain needs a DNS record that *resolves* to the right place: an `A`/`AAAA` record pointing at an IP address, or a `CNAME` pointing at another hostname. Don't use a registrar's "URL forwarding" or "redirect" option. That feature answers with an HTTP redirect to the address you gave it, so the browser ends up showing the bare IP. The apps would then talk to the wrong name, and HTTPS can't work.

## Common steps

### 1. Install SilentSuite

Install as usual with the [Quick Start](./quick-start.md). The domain you enter is the public or private name people will type into the apps. The installer writes it to the `[allowed_hosts]` section of `etebase-server.ini`. The server only answers requests whose `Host` header is listed there.

If that name changes later (for example, you switch to a NetBird-provided domain), add the new name to `[allowed_hosts]` and run `docker compose restart server`. Don't add the server's internal IP address to the list as a workaround. See [Troubleshooting](#troubleshooting) for why.

### 2. Make the server reachable over NetBird (only when needed)

By default Docker publishes the server on the host's loopback address only:

```yaml
    ports:
      - "127.0.0.1:${SERVER_PORT:-3735}:3735"
```

Only programs on the same machine can reach that address. Traffic arriving through the NetBird tunnel can't. NetBird's troubleshooting guide lists a loopback-only service as a common cause of failed connections.

- **Path A**, and **path B with the proxy on a different machine**: you need this step.
- **Path B with the proxy on the same machine as SilentSuite**: skip it and keep the loopback mapping. A proxy installed on the host uses that mapping. A proxy running in a Docker container joins SilentSuite's Docker network instead (see [B1](#b1-private-proxy-on-the-silentsuite-machine-peers-only)).

To make the server reachable on the NetBird network only:

1. Find this machine's NetBird IP (shown by `netbird status`; by default it's in the `100.64.0.0/10` range).
2. Open `docker-compose.yml` in your install directory and edit the `server` service's `ports:` entry. **Replace** the loopback line with one that uses the NetBird IP:

   ```yaml
       ports:
         - "100.x.y.z:${SERVER_PORT:-3735}:3735"
   ```

   If a reverse proxy on this same machine also needs the loopback address, keep both lines on purpose. Leave the `postgres` service as it is; it has no published ports and should stay that way.
3. Apply the change to the server container only:

   ```bash
   docker compose up -d server
   docker compose port server 3735
   ```

   The second command should print the NetBird IP and port. This recreates the server container. Your data lives in Docker volumes and isn't touched. Never add `-v` to a `docker compose down` here; that deletes the volumes.

Things to watch:

- **Edit the line; don't add an override.** Putting a new `ports:` entry in `docker-compose.override.yml` doesn't replace the original. Compose adds it to the list, so the server ends up published on both addresses. The installer may already have created an override file for a proxy network; leave it alone.
- **Never publish on all interfaces.** A mapping without an IP, or with `0.0.0.0`, exposes the port on every address, including public ones. Ordinary host firewall rules such as `ufw` don't protect Docker-published ports, because Docker routes that traffic before those rules see it. Binding to the NetBird IP is the control. On top of that, you can use NetBird access control policies to decide which peers may reach this machine.
- **Startup order.** Docker can only bind to the NetBird IP once NetBird has brought its interface up. If the server container fails to start after a reboot, check `docker compose ps`. Once `netbird status` shows the machine connected, start it again with `docker compose up -d server`.
- **Future upgrades.** If you replace `docker-compose.yml` with a newer copy, make this edit again.

If the SilentSuite machine isn't a NetBird peer itself and is reached through a NetBird routing peer instead, publish on its LAN address rather than the NetBird IP. Keep it to a private address, never a public one.

### 3. Tell SilentSuite which proxy to trust

The proxy terminates HTTPS and forwards plain HTTP to SilentSuite. It reports the original scheme in an `X-Forwarded-Proto: https` header. SilentSuite only believes that header from the exact addresses in `TRUSTED_PROXY_IPS` in `.env` (default `127.0.0.1`). From any other address, the server treats the request as plain HTTP and answers with a `301` redirect to `https://`. Behind a proxy, that redirect is what causes the loops and wrong-host redirects described in [Troubleshooting](#troubleshooting).

Two settings get mixed up here:

- **`TRUSTED_PROXY_IPS`** (SilentSuite, in `.env`) lists the address of the proxy that connects to SilentSuite.
- **`NB_PROXY_TRUSTED_PROXIES`** (self-hosted NetBird proxy) lists whatever sits in front of NetBird's proxy. It has nothing to do with SilentSuite.

Which address to trust depends on how the proxy connects:

| Setup | Address SilentSuite sees |
|---|---|
| NetBird reverse proxy, Peer target (path A) | The NetBird proxy's NetBird IP |
| Your proxy on another NetBird peer (B2) | That machine's NetBird IP |
| Proxy installed on the SilentSuite host (B1) | `127.0.0.1`, or Docker's gateway address (see below) |
| Proxy container on SilentSuite's Docker network (B1) | The proxy container's IP on that network |

If the HTTPS check in [Check your setup](#check-your-setup) already returns `200`, the proxy is trusted and there's nothing to change. Otherwise, confirm the address in the server log, and read it at the right moment. The server only swaps the logged address for a forwarded one when the connection comes from an address already in `TRUSTED_PROXY_IPS`. So while the new proxy isn't trusted yet, the log shows where the connection really came from:

1. Finish your path's setup below, then open your sync URL once through the proxy.
2. In the install directory, run `docker compose logs --tail 20 server`. Request lines look like `100.92.10.4:51234 - "GET / HTTP/1.1" 301`. The part before the colon is the connecting address.
3. Check that the address fits the table above. A public internet address, or the address of the phone or laptop you tested from, is a visitor, not your proxy. Don't trust it.
4. Add the proxy's exact address to `.env`, keeping any entries you still need:

   ```bash
   TRUSTED_PROXY_IPS=127.0.0.1,100.92.10.4
   ```

5. Recreate the server so it picks up the change:

   ```bash
   docker compose up -d --force-recreate server
   ```

Once the proxy is trusted, its log lines show the visitor's address instead, with or without a port number. So don't use later log lines to choose addresses to trust, and don't read too much into the port. Whether HTTPS is recognised shows up in the HTTPS check (`200` rather than `301`), not in the log.

Trust one exact address. Don't use `*`. Don't use the whole NetBird range either: every peer on your network has an address in it, and any of them could then fake the header. A proxy installed on the same machine that connects through `127.0.0.1:3735` may show up as Docker's network gateway (often `172.x.0.1`) rather than `127.0.0.1`. If the log shows that address, trust it; with the loopback-only port mapping, only programs on this machine come in that way. If the proxy's address changes later, for example when a proxy container is recreated, the redirects come back; repeat the check.

Don't fix a redirect by turning HTTPS enforcement off. The apps expect `https://`, and the trusted address above is the safe fix.

## Path A: NetBird reverse proxy

NetBird's proxy holds the certificate, accepts HTTPS from clients and forwards requests through the WireGuard tunnel to your server.

1. Complete common steps 1 and 2.
2. **Cloud:** nothing to deploy. **Self-hosted NetBird:** deploy NetBird's proxy first by following [Enable the reverse proxy](https://docs.netbird.io/selfhosted/migration/enable-reverse-proxy). In its `proxy.env`, set `NB_PROXY_FORWARDED_PROTO=https`, as NetBird's own example does. That pins the scheme NetBird reports to SilentSuite. On NetBird Cloud there's no equivalent setting to change. NetBird's proxy sets the header itself, and the HTTPS check in [Check your setup](#check-your-setup) shows whether SilentSuite accepted it.
3. In the NetBird dashboard, create an HTTP reverse proxy service:
   - **Domain:** a NetBird-provided domain, or your own domain with a `CNAME` to the proxy cluster (see NetBird's [custom domains](https://docs.netbird.io/manage/reverse-proxy/custom-domains)). Whichever you choose must be in `[allowed_hosts]`.
   - **Target:** type **Peer**, choose the SilentSuite machine, protocol **HTTP**, port **3735** (or your `SERVER_PORT`).
   - **Pass Host Header:** on. Without it, NetBird sends the target's address as the host name, and the server either rejects the request or redirects the browser to that internal address.
   - **Rewrite Redirects:** optional. It doesn't replace common step 3.
   - **Authentication:** see below.
4. Complete common step 3. When the target connects straight to the peer, NetBird documents that the server sees the proxy's NetBird IP. Read the exact address from the log before you trust it, as described there.
5. Run the [checks](#check-your-setup).

**Authentication on the service.** Don't turn on NetBird's SSO, password or PIN protection for the sync service. These are browser login screens in front of every request. The SilentSuite apps talk to the server's API directly and can't get past them, so sync fails. SilentSuite's own sign-in still protects accounts. If you want to limit who can reach the server at the network level, you have two options:

- **NetBird-Only Access**: only selected NetBird peers can use the service. Every syncing device must then be on the mesh. On self-hosted NetBird this needs the proxy's private mode (`NB_PROXY_PRIVATE`).
- **Access restrictions** (IP ranges, countries): evaluated before any login.

NetBird also has a "Direct Upstream" option, where its proxy dials the backend from its own host instead of through the tunnel. It only applies to NetBird-Only services, and this guide doesn't cover it.

## Path B: your own proxy, NetBird as the network

Here NetBird is just the private network. Your usual Caddy, nginx or Traefik terminates HTTPS, using the examples in [SELF-HOSTING.md](https://github.com/silent-suite/silentsuite/blob/main/self-host/SELF-HOSTING.md#reverse-proxy-examples) or the [Quick Start](./quick-start.md). What changes:

### B1. Private: proxy on the SilentSuite machine, peers only

- **DNS:** point the domain at the machine's NetBird IP with an `A` record. You can use your public DNS or any private DNS your devices use. The name only works for devices connected to NetBird.
- **TLS:** a certificate authority can't reach a NetBird address, so the usual HTTP-based Let's Encrypt challenge fails. Use your proxy's DNS-challenge support with your DNS provider, or another certificate your devices trust. The apps need a valid certificate for the name they use.
- **Listening address:** have the proxy listen on the NetBird IP, not on every interface, if you want the service to stay private. A proxy installed directly on the host is covered by your host firewall rules. A proxy running in Docker with published ports is not, so bind its published ports to the NetBird IP too.
- **SilentSuite port:** keep the default loopback mapping (skip common step 2).
- **Upstream:** this depends on how the proxy runs.
  - **Installed on the host** (or a container using Docker's host networking): forward to `127.0.0.1:3735`, exactly as in the examples.
  - **In a Docker container on a normal bridge network**, such as Nginx Proxy Manager or Traefik in Compose: `127.0.0.1` inside the container is the container itself, so that upstream gives a `502`. Connect the proxy container to SilentSuite's Docker network and use `silentsuite-server:3735`, as described under "Nginx Proxy Manager or other Docker-based proxies" in the [Quick Start](./quick-start.md). Leave the server's port mapping on loopback; the proxy doesn't need it.
- **Trust:**
  - **Host-installed proxy:** usually the default `127.0.0.1`. If the HTTPS check still redirects, see the Docker gateway note in common step 3.
  - **Proxy container:** the container's exact IP on SilentSuite's network. With the network name from the Quick Start command, this prints it:

    ```bash
    docker inspect --format '{{(index .NetworkSettings.Networks "NETWORK_NAME").IPAddress}}' PROXY_CONTAINER_NAME
    ```

### B2. Public proxy that reaches SilentSuite over NetBird

For example, a small public VPS runs Caddy and is a NetBird peer, and SilentSuite runs at home.

- **DNS:** the domain's `A` record points at the VPS's public IP. The normal Let's Encrypt setup works there.
- **SilentSuite port:** do common step 2 on the SilentSuite machine, then point the proxy at `http://<SilentSuite NetBird IP>:3735` instead of `localhost:3735`.
- **Headers:** the proxy must pass the original `Host` and send `X-Forwarded-Proto: https`. The nginx example sets both explicitly. Caddy does both by default when the upstream is plain HTTP. For Traefik, check its host-header and forwarded-header settings.
- **Trust:** `TRUSTED_PROXY_IPS` gets the VPS's NetBird IP (shown by `netbird status` on the VPS). Confirm it with the pre-trust log check in common step 3.
- **Access policies:** a NetBird access policy that allows only the VPS peer to reach port 3735 keeps the rest of your mesh out.

## Check your setup

From a device that should be able to sync:

```bash
curl -sS -D - -o /dev/null https://sync.example.com/
```

For a correct setup, expect a `200` status line and no `location:` header. Any `301` or `location:` pointing somewhere means the trust or host settings still need work; see the table below.

To check that the server is reachable over NetBird without the proxy, run this from another NetBird peer that the access policies allow:

```bash
curl -sS -D - -o /dev/null -H 'Host: sync.example.com' http://100.x.y.z:3735/
```

Here a `301` with `location: https://sync.example.com/` is the expected answer. It shows the server is reachable and that it redirects requests that aren't from a trusted proxy. A connection error or timeout means the problem is reachability (common step 2 or NetBird policies).

If you're still working out which address to trust, use the log check in common step 3, before adding the proxy to `TRUSTED_PROXY_IPS`.

**When sharing output with anyone,** replace your domain and IPs with placeholders. Never share `.env`, `etebase-server.ini`, passwords or tokens. The first-signup URL contains `?bootstrap_token=...`, and that token can appear in server logs, so remove it from anything you paste.

## Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| Browser lands on an internal IP or `localhost` | NetBird's **Pass Host Header** is off, so the server builds its HTTPS redirect from the target address; or the domain uses registrar URL forwarding | Turn on Pass Host Header and complete common step 3; use an `A`/`CNAME` record instead of URL forwarding |
| "Too many redirects", or `301` back to the same `https://` URL | SilentSuite doesn't trust the proxy's address, so it ignores `X-Forwarded-Proto` | Common step 3: add the proxy's exact address (from your topology, confirmed with the pre-trust log check) to `TRUSTED_PROXY_IPS`, recreate the server; on self-hosted NetBird set `NB_PROXY_FORWARDED_PROTO=https` |
| `400 Invalid host header` / "Invalid HTTP_HOST" | The name in the request isn't in `[allowed_hosts]`, often because Pass Host Header is off or a NetBird-provided domain wasn't added | Turn on Pass Host Header; add the public name (not an internal IP) to `[allowed_hosts]` and `docker compose restart server` |
| `502`, timeout, or "connection refused" through NetBird | The server is still published on `127.0.0.1` only, the container didn't start after a reboot, the target port is wrong, a NetBird policy blocks the peer, or a proxy container forwards to `127.0.0.1` | Common step 2; `docker compose ps`; check target type/port; for a proxy container use `silentsuite-server:3735` (see B1); check NetBird policies and NetBird's [troubleshooting guide](https://docs.netbird.io/manage/reverse-proxy/troubleshooting) |
| Website loads in a browser but the apps can't sign in or sync | NetBird SSO, password or PIN is enabled on the service, or the device isn't on the mesh with NetBird-Only Access | Turn off those login methods for the sync service; connect the device to NetBird |
| Apps reach the server but the account is refused | SilentSuite account issue, not NetBird: missing bootstrap token on first signup, or signups closed | See [Troubleshooting](./troubleshooting.md) and the first-admin steps in the Quick Start |

## NetBird references

- [Reverse proxy overview](https://docs.netbird.io/manage/reverse-proxy): targets, Pass Host Header, Rewrite Redirects, authentication, NetBird-Only Access
- [Backend service configuration](https://docs.netbird.io/manage/reverse-proxy/service-configuration): which address a backend sees, and trusting it
- [Reverse proxy troubleshooting](https://docs.netbird.io/manage/reverse-proxy/troubleshooting): unreachable backends and loopback-only services
- [Enable the reverse proxy on self-hosted NetBird](https://docs.netbird.io/selfhosted/migration/enable-reverse-proxy): deployment and `NB_PROXY_*` settings
- Docker: [packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/) and [merging Compose files](https://docs.docker.com/reference/compose-file/merge/)

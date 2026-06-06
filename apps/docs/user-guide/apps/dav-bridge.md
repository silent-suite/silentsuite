# SilentSuite Bridge

SilentSuite Bridge is a local daemon that translates between CalDAV/CardDAV and the Etebase protocol. It runs on your machine and makes SilentSuite compatible with **any** calendar, contacts, or tasks app that supports CalDAV/CardDAV -- including Thunderbird, macOS Calendar, GNOME Calendar, Windows Calendar, Outlook, and more.

## How It Works

```
Your App (CalDAV/CardDAV)
        |
http://localhost:37358/
        |
SilentSuite Bridge (local)
        | (encrypted)
SilentSuite Server
```

The bridge handles encryption/decryption locally. Your data is still end-to-end encrypted -- the bridge just presents it as standard CalDAV/CardDAV to your apps.

**Supported data types:**
- Calendars (CalDAV / VEVENT)
- Tasks (CalDAV / VTODO)
- Contacts (CardDAV / VCARD)

The bridge exposes every SilentSuite calendar, task list, and address book as its own DAV collection, so compatible clients can select the destination collection for new events, tasks, and contacts.

## Install

### One-Line Installer (Recommended)

**Linux / macOS:**

```bash
curl -fsSL https://silentsuite.io/bridge/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://silentsuite.io/bridge/install.ps1 | iex
```

The installer will:
1. Download the correct binary for your OS and architecture
2. Install it to `~/.local/bin/`
3. Optionally set up auto-start
4. Open the bridge dashboard for first-time login

::: info
The bridge install URLs are coming soon. The binary distribution pipeline is being finalized. Check back shortly or watch the [GitHub releases](https://github.com/silent-suite/silentsuite/releases) for updates.
:::

## First-Time Setup

### 1. Start The Bridge And Log In

After installation, run:

```bash
silentsuite-bridge
```

This starts the local bridge and opens the dashboard at `http://localhost:37358/`. If your browser does not open automatically, open that URL yourself. Enter your account email and password in the dashboard setup form; the bridge authenticates with the server, stores your session locally, and starts syncing.

`silentsuite-bridge --login` is still available as a fallback or advanced path. Running it adds another account or re-authenticates the same account; it does not remove accounts that are already configured.

### 2. Note Your Connection URLs

After successful login, the dashboard shows your CalDAV/CardDAV URLs:

| Field | Value |
|---|---|
| **CalDAV URL** | `http://localhost:37358/your@email.com/` |
| **CardDAV URL** | `http://localhost:37358/your@email.com/` |
| **Username** | Your account email |
| **Password** | Your account password |

You can always find these URLs by:
- Opening the dashboard at `http://localhost:37358/`
- Using the system tray menu account entries (Copy CalDAV URL / Copy CardDAV URL)

## Multi-Account Use

The bridge can keep multiple accounts active in one local bridge profile. Each account has its own credentials, local cache namespace, sync thread, and DAV path.

```bash
silentsuite-bridge --login
silentsuite-bridge --login
silentsuite-bridge --list-accounts
```

Each account uses a URL containing the account email:

```text
http://localhost:37358/work@example.com/
http://localhost:37358/personal@example.com/
```

Use the matching account email and password in your calendar/contact client. A client authenticated as one account cannot access another account's DAV path.

You can add or re-authenticate accounts from the dashboard with **Add / Re-authenticate Account**. It shows the dashboard sign-in form and starts syncing the account after login succeeds; you do not need to restart the bridge.

To remove only the local login/session for one account while keeping its local cache for future re-login:

```bash
silentsuite-bridge --logout work@example.com
```

To fully remove one account's local bridge data, including its decrypted local cache:

```bash
silentsuite-bridge --remove-account work@example.com
```

::: warning
The bridge local cache contains decrypted calendar, contact, and task data. Use `--remove-account` when retiring a shared or untrusted machine.
:::

### 3. Keep The Bridge Running

Leave `silentsuite-bridge` running. The bridge will:
- Start the CalDAV/CardDAV server on `localhost:37358`
- Show a system tray icon (green = connected, yellow = warning, red = error)
- Sync automatically in the background

## Dashboard

The bridge serves a status dashboard at:

```
http://localhost:37358/
```

The dashboard shows:
- Connection status
- All configured accounts
- Last sync time
- Per-account CalDAV/CardDAV URLs with copy buttons
- Add / Re-authenticate, Log out, and Remove account actions
- Recent sync log

Use **Log out** to remove local bridge credentials while keeping that account's local cache for re-login. Use **Remove account** to delete local bridge credentials and that account's decrypted local bridge cache on this computer. Other configured accounts are not affected.

## Auto-Start

### Install Auto-Start

```bash
silentsuite-bridge --install-autostart
```

This configures the bridge to start when you log in:
- **Linux**: Creates a systemd user service
- **macOS**: Creates a launchd agent
- **Windows**: Adds a startup registry entry

### Remove Auto-Start

```bash
silentsuite-bridge --remove-autostart
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SILENTSUITE_SERVER_URL` | `https://server.silentsuite.io` | Etebase server URL |
| `SILENTSUITE_LISTEN_ADDRESS` | `localhost` | IP address to listen on |
| `SILENTSUITE_LISTEN_PORT` | `37358` | Port to listen on |
| `SILENTSUITE_DATA_DIR` | Platform-specific | Data storage location |
| `SILENTSUITE_SYNC_INTERVAL` | `900` (15 min) | Sync interval in seconds |
| `SILENTSUITE_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARNING, ERROR) |

For self-hosted servers:

```bash
export SILENTSUITE_SERVER_URL=https://sync.your-domain.com
silentsuite-bridge
```

## CLI Reference

```bash
silentsuite-bridge                    # Start the bridge
silentsuite-bridge --version          # Show version
silentsuite-bridge --login            # Add or re-authenticate an account
silentsuite-bridge --list-accounts    # List configured accounts
silentsuite-bridge --logout EMAIL     # Remove local credentials; keep cache
silentsuite-bridge --remove-account EMAIL  # Remove credentials and local cache
silentsuite-bridge --manual-login     # CLI add/re-authenticate (headless/dev)
silentsuite-bridge --install-autostart  # Install auto-start
silentsuite-bridge --remove-autostart   # Remove auto-start
silentsuite-bridge --no-tray          # Start without system tray
```

## Troubleshooting

### Bridge won't start

On the default localhost bind, the bridge can start before an account is configured so you can log in through `http://localhost:37358/`. If you intentionally configured a remote/non-loopback bind, the dashboard is disabled for safety and you must add an account first with:

```bash
silentsuite-bridge --login
```

### Can't connect from your app

1. Verify the bridge is running: open `http://localhost:37358/` in your browser
2. Check the tray icon color (green = OK, red = error)
3. Check the dashboard sync log for errors

### System tray not visible (GNOME)

GNOME removed native tray support. Install the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) to restore it. KDE, XFCE, and other desktop environments support the tray natively.

### Firewall blocking

Ensure `localhost:37358` is not blocked by your firewall. The bridge only listens on localhost -- it never accepts connections from other machines.

## Next Steps

Once the bridge is running, set up your apps:

- [Thunderbird](./thunderbird.md) (Linux, macOS, Windows)
- [macOS Calendar & Contacts](./macos.md)
- [Windows / Outlook](./windows.md)
- [GNOME Calendar & Contacts](./gnome.md)
- [iOS Calendar & Contacts](./ios.md)
- [Android (DAVx5)](./android.md)
- [GNOME Evolution](./evolution.md) (also supports native Etebase)
- [KDE Kontact](./kde.md) (also supports native Etebase)
- [Other CalDAV/CardDAV Apps](./other.md) (em Client, BusyCal, Fantastical, and more)

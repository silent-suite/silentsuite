# Linux Desktop Bridge

The SilentSuite Bridge runs on your Linux computer and gives desktop apps a local CalDAV/CardDAV connection to your encrypted SilentSuite data. It decrypts data only on your device and syncs encrypted data with the SilentSuite server.

::: warning Local desktop service
The bridge exposes decrypted calendar, contact, and task data on your computer. Keep it bound to localhost and do not expose port `37358` to your network or the public internet.
:::

This guide is for the desktop bridge. It does not install or remove a [self-hosted SilentSuite server](/self-hosting/quick-start).

## Install

The installer supports Linux on x86_64 and ARM64. Run the stable installer in a terminal:

```bash
curl -fsSL https://silentsuite.io/bridge/install.sh | sh
```

The installer downloads the current bridge release, verifies the checksum against the release's `.sha256` sidecar before installing, installs it at `~/.local/bin/silentsuite-bridge`, and configures a systemd user service. Checksum verification is mandatory — the installer refuses to install when the verifier, release checksum sidecar, or asset/binary is unavailable, ambiguous, malformed, or mismatched. If you require manual verification, download the binary and its `.sha256` file from GitHub Releases and compare them before running it.

If your current shell cannot find the command immediately, open a new terminal or run:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

If you prefer to download the binary yourself, use the current files on [GitHub Releases](https://github.com/silent-suite/silentsuite/releases):

- `silentsuite-bridge-linux-x86_64` and its `.sha256` file for most Intel and AMD computers
- `silentsuite-bridge-linux-arm64` and its `.sha256` file for 64-bit ARM computers

Do not install from scripts on the `dev` branch. They may contain unreleased changes.

## Start and Sign In

The installer enables and starts the systemd user service automatically. Confirm it is running:

```bash
systemctl --user status silentsuite-bridge.service
```

If you downloaded the binary manually instead, or intentionally stopped the service, you can run the bridge in the foreground with:

```bash
silentsuite-bridge
```

Do not run a second foreground copy while the systemd service is active. Open the local dashboard at:

```text
http://localhost:37358/
```

If the browser does not open automatically, open that address yourself. Sign in with your SilentSuite account. The dashboard then shows the account-specific CalDAV and CardDAV URL to use in desktop apps, for example:

```text
http://localhost:37358/your@email.com/
```

Use the matching SilentSuite account email and password when your desktop app asks for DAV credentials. Keep the bridge running while your apps sync.

## Start Automatically

The installer normally configures auto-start for you. To install or repair it manually, run:

```bash
silentsuite-bridge --install-autostart
systemctl --user status silentsuite-bridge.service
```

This creates and enables a systemd user service. It starts with your user session.

If the bridge must remain running after you log out, you can enable lingering:

```bash
sudo loginctl enable-linger "$USER"
```

The auto-start command checks this setting and may enable it automatically when passwordless `sudo` permits that change. Otherwise, it prints the command above as an optional follow-up. Lingering also affects other systemd user services for your account, so enable it only when you want that behavior. It is not required when you only need the bridge while logged in.

## Connect Linux Apps

Always start the bridge and sign in before configuring a desktop app. Copy the account-specific DAV URL from the dashboard rather than guessing it.

- **Thunderbird:** Follow the [Thunderbird guide](./thunderbird.md) for calendars, address books, and tasks.
- **GNOME Calendar and Contacts:** Add the local DAV account through GNOME Online Accounts using the [GNOME guide](./gnome.md).
- **Evolution:** Evolution can connect through the bridge, but its native Etebase integration does not require one. See the [Evolution guide](./evolution.md) for both options.
- **KDE Kontact, KOrganizer, and KAddressBook:** KDE also has native and bridge options. See the [KDE guide](./kde.md).

## Troubleshooting

First confirm that the bridge dashboard opens at `http://localhost:37358/`. If it does not, check the installed version and systemd user service:

```bash
silentsuite-bridge --version
systemctl --user status silentsuite-bridge.service
journalctl --user -u silentsuite-bridge.service --since today
```

Common checks:

- Use the full account-specific URL shown by the dashboard, such as `http://localhost:37358/your@email.com/`.
- The bridge and DAV app must run on the same computer because the bridge listens on localhost by default.
- Check the dashboard sync log before troubleshooting the desktop app.
- If the tray icon is missing on GNOME, install or enable the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/). The bridge can still run without a visible tray icon.

## Uninstall

The following steps remove the Linux desktop bridge. They do not delete your SilentSuite account or server data, remove a self-hosted server, or cancel a hosted trial or subscription.

### Optional: Remove One Local Account

Before deleting the binary, you can remove one account's local bridge data:

```bash
silentsuite-bridge --remove-account your@email.com
```

`--logout your@email.com` removes local credentials but keeps that account's local cache. `--remove-account your@email.com` removes both its local credentials and decrypted local cache.

### Remove the Service and Binary

```bash
# Remove auto-start while the bridge command is still available
silentsuite-bridge --remove-autostart 2>/dev/null || true

# Stop a remaining service or manually started bridge
systemctl --user stop silentsuite-bridge.service 2>/dev/null || true
pkill -f '(^|/)silentsuite-bridge( |$)' 2>/dev/null || true

# Remove any remaining service file and reload systemd
rm -f ~/.config/systemd/user/silentsuite-bridge.service
systemctl --user daemon-reload 2>/dev/null || true

# Remove the installed binary
rm -f ~/.local/bin/silentsuite-bridge
```

The installer may have added `~/.local/bin` to your shell profile. You can leave that standard user binary directory on `PATH`, especially if other programs use it.

If you previously enabled lingering only for the bridge, you may disable it separately:

```bash
sudo loginctl disable-linger "$USER"
```

Do not disable lingering automatically. Other systemd user services may rely on it.

### Optional: Delete All Local Bridge Data

::: danger Decrypted local data
The next command permanently removes all local bridge credentials, settings, and decrypted calendar, contact, and task cache for every configured account on this computer.
:::

```bash
rm -rf ~/.local/share/silentsuite-bridge
```

This local wipe does not delete data from the SilentSuite server. For Docker server removal, use the separate [self-hosted uninstall guide](/self-hosting/uninstalling).

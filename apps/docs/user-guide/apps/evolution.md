# GNOME Evolution

GNOME Evolution has native Etebase support, allowing you to sync your SilentSuite calendar, contacts, and tasks directly -- no DAV bridge required.

Once configured in Evolution, your data also appears in **GNOME Calendar**, **GNOME Contacts**, and **GNOME To Do**.

## Install the EteSync Module

The `evolution-etesync` module provides native Etebase support. Install it for your distribution:

### Arch Linux

```bash
# Install from AUR
yay -S evolution-etesync-git
```

### Fedora / CentOS

```bash
sudo dnf copr enable daftaupe/etesync-rs
sudo dnf install evolution-etesync
```

### Debian / Ubuntu

Add the OBS repository for `home:fawz:libetebase` and install:

```bash
sudo apt install evolution-etesync
```

Check the [EteSync downloads page](https://www.etesync.com/downloads/) for the latest package links.

### Other Distributions

See the [EteSync GNOME guide](https://www.etesync.com/guides/gnome-evolution/) for additional options and build-from-source instructions.

## Set Up

1. Open **Evolution**.
2. Click the arrow next to **New** in the toolbar > **Collection Account**.
3. Enter your **username** (email address).
4. Tick **"Look up for an EteSync account"**.
5. Click **Next**.
6. Enter your **password**.
7. For self-hosted servers: click **Advanced Options** and enter your server URL (e.g. `https://sync.your-domain.com`). For the hosted service, enter `https://server.silentsuite.io`.
8. Click **Next** > **Finish**.

Your calendars, contacts, and task lists will appear in Evolution and across all GNOME apps.

## GNOME Calendar & Contacts

After setting up Evolution, your SilentSuite data automatically appears in:

- **GNOME Calendar** -- all your encrypted calendars show up with events.
- **GNOME Contacts** -- all your encrypted contacts are accessible.
- **GNOME To Do** -- your encrypted task lists are available.

No additional configuration is needed for these apps.

## Alternative: Via DAV Bridge

If the native module is not available for your distribution, you can use the [DAV bridge](./dav-bridge.md) instead:

1. Set up the [SilentSuite Bridge](./dav-bridge.md).
2. In Evolution: **New** > **Collection Account**.
3. Enter your username.
4. Click **Advanced Options** > set server to `http://localhost:37358/`.
5. Tick **"Look up for a CalDAV/CardDAV server"**, untick other options.
6. Click **Look Up** and enter your SilentSuite password.

## Troubleshooting

### Module not found

If the "EteSync account" option doesn't appear, the `evolution-etesync` package may not be installed correctly. Verify:

```bash
# Check for the module
ls /usr/lib/evolution/modules/ | grep etesync
```

### Authentication fails

Double-check your username and password. Remember that your SilentSuite password is also your encryption key -- it must be entered exactly.

# KDE Kontact

KDE's Kontact suite (KOrganizer, KAddressBook, KMail) has native Etebase support built into `kdepim-runtime`, allowing direct sync with your SilentSuite server -- no DAV bridge required.

## Install

The EteSync resource is part of `kdepim-runtime` but requires `libetebase`. Install for your distribution:

### Arch Linux

```bash
# Ensure kdepim-runtime >= 20.12 and libetebase are installed
sudo pacman -S kdepim-runtime libetebase
```

### Fedora / CentOS

```bash
sudo dnf copr enable daftaupe/etesync-rs
sudo dnf install kdepim-runtime-etesync
```

### Debian / Ubuntu

Add the OBS repository for `home:fawz:libetebase` and install:

```bash
sudo apt install kdepim-runtime-etesync
```

Check the [EteSync downloads page](https://www.etesync.com/downloads/) for the latest package links.

### Other Distributions

See the [EteSync KDE guide](https://www.etesync.com/guides/kde/) and the [developer blog](https://www.thejollyblog.tech/posts/KDE/etesync-v2-kontact) for build-from-source instructions.

## Set Up

1. Open **Kontact** and go to the **Calendar** view (KOrganizer).
2. Right-click the calendar list > **Add Calendar**.
3. Select **"EteSync Groupware Resource"** from the list.
4. Enter your **username** (email) and **password**.
5. Click **Next**.
6. Enter your **encryption password** (this is the same as your SilentSuite password).
7. For self-hosted servers: tick **Advanced Settings** and enter your server URL (e.g. `https://sync.your-domain.com`). For the hosted service, enter `https://server.silentsuite.io`.
8. Click **Finish**.

Your calendars, contacts, and task lists will appear in KOrganizer, KAddressBook, and across all KDE PIM apps.

## What Syncs

| KDE App | SilentSuite Data |
|---|---|
| **KOrganizer** | Calendar events |
| **KAddressBook** | Contacts |
| **KOrganizer** (Tasks view) | Tasks |

## Alternative: Via DAV Bridge

If the native resource is not available, use the [DAV bridge](./dav-bridge.md):

1. Set up the [SilentSuite Bridge](./dav-bridge.md).
2. In KOrganizer, add a new CalDAV/CardDAV resource.
3. Server URL: `http://localhost:37358/`.
4. Use your SilentSuite credentials.

## Troubleshooting

### "EteSync Groupware Resource" not in the list

The `kdepim-runtime-etesync` package (or equivalent) is not installed. Install it following the instructions above and restart Kontact.

### Sync errors

Check the Akonadi console for detailed error messages:

```bash
akonadiconsole
```

Look for EteSync-related resources and their sync status.

# Apps & Integrations

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/). You can sync your encrypted data with the supported SilentSuite and third-party apps listed below.

## How It Works

The hosted server at `server.silentsuite.io` (or your self-hosted URL) speaks the Etebase protocol. Apps connect to it directly or through a local bridge, and all encryption/decryption happens on your device.

## SilentSuite Apps

| App | Platform | Syncs |
|---|---|---|
| [SilentSuite Web](https://app.silentsuite.io) | Browser | Contacts, Calendars, Tasks |
| [SilentSuite for Android](./android.md) | Android | Contacts, Calendars, Tasks |
| [SilentSuite for iOS](./ios.md) | iOS | In development |

## Compatible Third-Party Apps

These apps connect directly to `server.silentsuite.io` or your self-hosted server with full end-to-end encryption. No bridge needed.

| App | Platform | Syncs |
|---|---|---|
| [Tasks.org](./tasks-org.md) | Android | Tasks |
| [GNOME Evolution](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [GNOME Calendar, Contacts & To Do](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [KDE Kontact](./kde.md) | Linux (KDE) | Contacts, Calendars, Tasks |

## Via the DAV Bridge

For apps that don't support Etebase natively, the [SilentSuite Bridge](./dav-bridge.md) runs a local CalDAV/CardDAV server on your machine that translates between standard DAV protocols and Etebase. This makes SilentSuite compatible with virtually any calendar/contacts app.

| App | Platform | Needs DAV Bridge | Tested app version |
|---|---|---|---|
| [Thunderbird](./thunderbird.md) | Linux, macOS, Windows | Yes | Not recorded yet |
| [macOS Calendar & Contacts](./macos.md) | macOS | Yes | Not recorded yet |
| [Windows / Outlook](./windows.md) | Windows | Yes | Not recorded yet |
| [GNOME Calendar & Contacts](./gnome.md) | Linux (GNOME) | Yes | Not recorded yet |
| [Other CalDAV/CardDAV Apps](./other.md) | Any | Yes | Not recorded yet |

::: tip
If your app supports CalDAV/CardDAV, it works with SilentSuite through the DAV bridge. Set up the [SilentSuite Bridge](./dav-bridge.md) first, then point your app at `http://localhost:37358/`.
:::

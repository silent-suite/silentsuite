# Apps & Integrations

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/), which means your encrypted data works with a growing ecosystem of compatible apps. You can sync your calendar, contacts, and tasks with native apps on every major platform.

## How It Works

Your SilentSuite server at `server.silentsuite.io` (or your self-hosted URL) speaks the Etebase protocol. Apps connect to it directly or through a local bridge, and all encryption/decryption happens on your device.

## SilentSuite Apps

| App | Platform | Syncs |
|---|---|---|
| [SilentSuite Web](https://app.silentsuite.io) | Browser | Contacts, Calendars, Tasks |
| [SilentSuite for Android](./android.md) | Android | Contacts, Calendars, Tasks |

## Compatible Third-Party Apps

These apps connect directly to your SilentSuite server with full end-to-end encryption. No bridge needed.

| App | Platform | Syncs |
|---|---|---|
| [EteSync for iOS](./ios.md) (third-party) | iOS | Contacts, Calendars, Reminders |
| [Tasks.org](./tasks-org.md) | Android | Tasks |
| [GNOME Evolution](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [GNOME Calendar, Contacts & To Do](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [KDE Kontact](./kde.md) | Linux (KDE) | Contacts, Calendars, Tasks |

## Via the DAV Bridge

For apps that don't support Etebase natively, the [SilentSuite Bridge](./dav-bridge.md) runs a local CalDAV/CardDAV server on your machine that translates between standard DAV protocols and Etebase. This makes SilentSuite compatible with virtually any calendar/contacts app.

| App | Platform | Needs DAV Bridge |
|---|---|---|
| [Thunderbird](./thunderbird.md) | Linux, macOS, Windows | Yes |
| [macOS Calendar & Contacts](./macos.md) | macOS | Yes |
| [Windows / Outlook](./windows.md) | Windows | Yes |
| [GNOME Calendar & Contacts](./gnome.md) | Linux (GNOME) | Yes |
| [Other CalDAV/CardDAV Apps](./other.md) | Any | Yes |

::: tip
If your app supports CalDAV/CardDAV, it works with SilentSuite through the DAV bridge. Set up the [SilentSuite Bridge](./dav-bridge.md) first, then point your app at `http://localhost:37358/`.
:::

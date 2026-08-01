# Apps & Integrations

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/). Today you can sync calendars, contacts, and tasks through the web app, the native Android app, and supported desktop clients.

## How It Works

The hosted server at `server.silentsuite.io` (or your self-hosted URL) speaks the Etebase protocol. Apps connect to it directly or through a local bridge, and all encryption/decryption happens on your device.

## SilentSuite Apps

| App | Platform | Syncs |
|---|---|---|
| [SilentSuite Web](https://app.silentsuite.io) | Browser | Contacts, Calendars, Tasks |
| [SilentSuite for Android](./android.md) | Android | Contacts, Calendars, Tasks |


## On the Roadmap

- **[iOS](./ios.md):** Coming soon. iOS is not currently supported.

## Compatible Third-Party Apps

These apps connect directly to `server.silentsuite.io` or your self-hosted server with full end-to-end encryption. No bridge needed.

| App | Platform | Syncs |
|---|---|---|
| [Tasks.org](./tasks-org.md) | Android | Tasks |
| [GNOME Evolution](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [GNOME Calendar, Contacts & To Do](./evolution.md) | Linux (GNOME) | Contacts, Calendars, Tasks |
| [KDE Kontact](./kde.md) | Linux (KDE) | Contacts, Calendars, Tasks |

## Via the DAV Bridge

For apps that don't support Etebase natively, the [SilentSuite Bridge](./dav-bridge.md) runs a local CalDAV/CardDAV server on your machine that translates between standard DAV protocols and Etebase. This makes SilentSuite compatible with the supported desktop calendar and contacts clients listed below.

On Linux, start with the [Linux desktop bridge guide](./linux-bridge.md) for installation, sign-in, auto-start, app connections, troubleshooting, and uninstall instructions.

| App | Platform | Needs DAV Bridge | Tested app version |
|---|---|---|---|
| [Thunderbird](./thunderbird.md) | Linux, macOS, Windows | Yes | Not recorded yet |
| [macOS Calendar & Contacts](./macos.md) | macOS | Yes | Not recorded yet |
| [Windows / Outlook](./windows.md) | Windows | Yes | Not recorded yet |
| [GNOME Calendar & Contacts](./gnome.md) | Linux (GNOME) | Yes | Not recorded yet |
| [Additional desktop CalDAV/CardDAV Apps](./other.md) | Desktop | Yes | Varies by client |

::: tip
Additional desktop CalDAV/CardDAV clients may work through the local bridge, but unlisted clients are not guaranteed. iOS is not currently supported. Set up the [SilentSuite Bridge](./dav-bridge.md) first, then use a supported client with `http://localhost:37358/`.
:::

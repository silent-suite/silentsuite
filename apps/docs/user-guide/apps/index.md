# Apps & Integrations

SilentSuite is built on the [Etebase protocol](https://www.etebase.com/). Today you can sync calendars, contacts, and tasks through the web app, the native Android app, and supported desktop clients.

<AppLogoStrip compact />

<p class="app-logo-note">
  Logos link to each app's official site. App names and logos identify their respective products and do not imply endorsement or partnership.
  <a href="/app-logo-notices">Sources, licenses, and trademark notices</a>.
</p>

## How It Works

The hosted server at `server.silentsuite.io` (or your self-hosted URL) speaks the Etebase protocol. Apps connect to it directly or through a local bridge, and all encryption/decryption happens on your device.

## SilentSuite Apps

| App | Official site | Platform | Syncs |
|---|---|---|---|
| <img class="app-table-logo" src="/logo.svg" alt="" width="28" height="28"> [SilentSuite Web](https://app.silentsuite.io) | [app.silentsuite.io](https://app.silentsuite.io) | Browser | Contacts, Calendars, Tasks |
| <img class="app-table-logo" src="/logo.svg" alt="" width="28" height="28"> [SilentSuite for Android](./android.md) | [silentsuite.io](https://silentsuite.io/) | Android | Contacts, Calendars, Tasks |

## On the Roadmap

- **[iOS](./ios.md):** Coming soon. iOS is not currently supported.

## Compatible Third-Party Apps

These apps connect directly to `server.silentsuite.io` or your self-hosted server with full end-to-end encryption. No bridge needed.

| App | Official site | Platform | Syncs |
|---|---|---|---|
| <img class="app-table-logo" src="/app-logos/tasks-org.svg" alt="" width="28" height="28"> [Tasks.org](./tasks-org.md) | [tasks.org](https://tasks.org/) | Android | Tasks |
| <img class="app-table-logo" src="/app-logos/evolution.svg" alt="" width="28" height="28"> [GNOME Evolution](./evolution.md) | [GNOME Evolution](https://help.gnome.org/evolution/index.html) | Linux (GNOME) | Contacts, Calendars, Tasks |
| <img class="app-table-logo" src="/app-logos/gnome-calendar.svg" alt="" width="28" height="28"> <img class="app-table-logo" src="/app-logos/gnome-contacts.svg" alt="" width="28" height="28"> [GNOME Calendar, Contacts & To Do](./evolution.md) | [Calendar](https://apps.gnome.org/Calendar/) · [Contacts](https://apps.gnome.org/Contacts/) · [To Do archive](https://wiki.gnome.org/Apps/Todo) | Linux (GNOME) | Contacts, Calendars, Tasks |
| <img class="app-table-logo" src="/app-logos/kontact.svg" alt="" width="28" height="28"> [KDE Kontact](./kde.md) | [kontact.kde.org](https://kontact.kde.org/) | Linux (KDE) | Contacts, Calendars, Tasks |

## Via the DAV Bridge

For apps that don't support Etebase natively, the [SilentSuite Bridge](./dav-bridge.md) runs a local CalDAV/CardDAV server on your machine that translates between standard DAV protocols and Etebase. This makes SilentSuite compatible with the supported desktop calendar and contacts clients listed below.

On Linux, start with the [Linux desktop bridge guide](./linux-bridge.md) for installation, sign-in, auto-start, app connections, troubleshooting, and uninstall instructions.

| App | Official site | Platform | Needs DAV Bridge | Tested app version |
|---|---|---|---|---|
| <img class="app-table-logo" src="/app-logos/thunderbird.png" alt="" width="28" height="28"> [Thunderbird](./thunderbird.md) | [thunderbird.net](https://www.thunderbird.net/) | Linux, macOS, Windows | Yes | Not recorded yet |
| <img class="app-table-logo" src="/app-logos/apple-calendar.png" alt="" width="28" height="28"> <img class="app-table-logo" src="/app-logos/apple-contacts.png" alt="" width="28" height="28"> [macOS Calendar & Contacts](./macos.md) | [Calendar](https://support.apple.com/guide/calendar/welcome/mac) · [Contacts](https://support.apple.com/guide/contacts/welcome/mac) | macOS | Yes | Not recorded yet |
| <img class="app-table-logo" src="/app-logos/outlook.svg" alt="" width="28" height="28"> [Windows / Outlook](./windows.md) | [Outlook for Windows](https://www.microsoft.com/en-us/microsoft-365/outlook/outlook-for-windows) | Windows | Yes | Not recorded yet |
| <img class="app-table-logo" src="/app-logos/gnome-calendar.svg" alt="" width="28" height="28"> <img class="app-table-logo" src="/app-logos/gnome-contacts.svg" alt="" width="28" height="28"> [GNOME Calendar & Contacts](./gnome.md) | [Calendar](https://apps.gnome.org/Calendar/) · [Contacts](https://apps.gnome.org/Contacts/) | Linux (GNOME) | Yes | Not recorded yet |
::: tip
Use one of the documented desktop clients above with the [SilentSuite Bridge](./dav-bridge.md). Protocol support alone does not establish SilentSuite compatibility. iOS is not currently supported.
:::

## How to report bridge compatibility

If you try an app with the [SilentSuite Bridge](./dav-bridge.md), report your result with:

- **App name and version** you tested.
- **Operating system** (for example, macOS 15, Windows 11, Ubuntu 24.04).
- **Bridge version** you were running.
- **Calendar sync:** yes, no, or partial.
- **Contacts sync:** yes, no, or partial.
- **Notes or errors** -- what worked, what failed, and any error message or log excerpt.

Redact private data before sharing: remove usernames, email addresses, server URLs, and any event or contact content from logs and screenshots. Only report apps you have actually tested -- an untested app is not known to work.

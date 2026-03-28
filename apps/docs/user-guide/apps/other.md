# Other CalDAV/CardDAV Apps

Any app that supports CalDAV or CardDAV can sync with SilentSuite through the [SilentSuite Bridge](./dav-bridge.md). This guide covers the general setup process.

## What You Need

Before configuring your app, make sure the [SilentSuite Bridge](./dav-bridge.md) is installed and running. Then gather these connection details from the bridge dashboard at `http://localhost:37358/.web/`:

| Field | Value |
|---|---|
| **CalDAV URL** | `http://localhost:37358/your@email.com/` |
| **CardDAV URL** | `http://localhost:37358/your@email.com/` |
| **Username** | Your SilentSuite email |
| **Password** | Your SilentSuite password |

Replace `your@email.com` with the email you used to log into the bridge.

## Generic Setup Steps

Most CalDAV/CardDAV apps follow a similar pattern:

### Calendars (CalDAV)

1. Open your app's account or calendar settings.
2. Look for an option to add a **CalDAV** account (sometimes called "CalDAV calendar", "network calendar", or "remote calendar").
3. Enter the **CalDAV URL**, **username**, and **password** from the table above.
4. Save. The app should discover your calendars automatically.

### Contacts (CardDAV)

1. Open your app's account or contacts settings.
2. Look for an option to add a **CardDAV** account (sometimes called "CardDAV address book" or "remote contacts").
3. Enter the **CardDAV URL**, **username**, and **password** from the table above.
4. Save. The app should discover your address books automatically.

### Tasks (CalDAV)

Task lists are served over CalDAV alongside calendars. If your app supports VTODO, task lists will appear after adding the CalDAV account.

## Apps Known to Work

These apps have been tested with SilentSuite through the DAV bridge. For some, we have dedicated setup guides.

| App | Platform | Guide |
|---|---|---|
| Thunderbird | Linux, macOS, Windows | [Thunderbird guide](./thunderbird.md) |
| Apple Calendar & Contacts | macOS | [macOS guide](./macos.md) |
| Microsoft Outlook (with CalDav Synchronizer) | Windows | [Windows guide](./windows.md) |
| em Client | Windows, macOS | [Windows guide](./windows.md) |
| GNOME Calendar & Contacts | Linux | [GNOME guide](./gnome.md) |
| GNOME Evolution | Linux | [Evolution guide](./evolution.md) |
| KDE Kontact | Linux | [KDE guide](./kde.md) |
| BusyCal | macOS | Use CalDAV account setup |
| Fantastical | macOS, iOS | Use CalDAV account setup |
| DAVx5 | Android | Use CalDAV/CardDAV account setup |
| Rainlendar | Windows, macOS, Linux | Use CalDAV subscription |
| Calendars by Readdle | iOS | Use CalDAV account setup |
| CardBook (Thunderbird add-on) | Linux, macOS, Windows | Use CardDAV remote address book |

::: tip
If your app supports CalDAV or CardDAV but is not listed here, it will most likely work. Use the generic steps above.
:::

## URL Variants

Some apps require different URL formats. If the default URL does not work, try these:

| Format | URL |
|---|---|
| With email path | `http://localhost:37358/your@email.com/` |
| Root URL | `http://localhost:37358/` |
| With `.well-known` | `http://localhost:37358/.well-known/caldav` |
| IP instead of hostname | `http://127.0.0.1:37358/your@email.com/` |

## Troubleshooting

### App cannot find any calendars or contacts

1. Verify the bridge is running: open `http://localhost:37358/.web/` in your browser.
2. Check that you are using the correct URL format. Try the root URL (`http://localhost:37358/`) if the full path does not work, or vice versa.
3. Make sure your username and password are correct. They are the same credentials you use to log into SilentSuite.

### Connection refused or timeout

1. The bridge must be running on the same machine as your app. It listens on `localhost` only.
2. Check that port 37358 is not blocked by a firewall.
3. Try `http://127.0.0.1:37358/` instead of `http://localhost:37358/`.

### SSL/TLS errors

The bridge runs over plain HTTP on localhost. If your app requires HTTPS, it will not work directly. Some apps let you disable SSL verification for local connections. Check your app's settings.

### Sync is slow or events are missing

1. Check the bridge dashboard for sync errors.
2. Some apps limit how far back they sync events. Look for a "sync range" or "time range" setting.
3. Force a sync in your app (usually pull-to-refresh or a sync button).

### Two-way sync not working

Make sure your app is configured for read-write access, not read-only. Some apps default to one-way sync or subscribe mode for CalDAV URLs.

# Thunderbird

Mozilla Thunderbird supports CalDAV and CardDAV natively (since version 91). Connect it to SilentSuite through the [SilentSuite Bridge](./dav-bridge.md).

## Prerequisites

1. **Thunderbird 91 or later** (earlier versions require the TbSync add-on).
2. [SilentSuite Bridge](./dav-bridge.md) installed and running on your machine.
3. Your SilentSuite email and password.

## Add Calendars

1. In Thunderbird, switch to the **Calendar** view.
2. Right-click the calendar list (or click **+**) > **New Calendar**.
3. Select **On the Network**.
4. Enter:
   - **Username**: your SilentSuite email
   - **Location**: `http://localhost:37358/your@email.com/`
5. Click **Find Calendars**.
6. When prompted for a password, enter your **SilentSuite password**.
7. Select the calendars you want and click **Subscribe**.

## Add Address Books

1. Switch to the **Address Book** view.
2. Go to **File > New > CardDAV Address Book**.
3. Enter:
   - **Username**: your SilentSuite email
   - **Location**: `http://localhost:37358/your@email.com/`
4. Click **Continue**.
5. Enter your **SilentSuite password** when prompted.
6. Select the address books to add.

## Add Task Lists

Task lists appear automatically alongside calendars. Any VTODO-capable collection will show up in Thunderbird's task view after adding calendars.

## Thunderbird Before Version 91

For older versions, install these add-ons:

1. [TbSync](https://addons.thunderbird.net/en-us/thunderbird/addon/tbsync/)
2. [DAV provider for TbSync](https://addons.thunderbird.net/en-us/thunderbird/addon/dav-4-tbsync/)

Then:

1. Go to **Edit > TbSync** (or **Tools > TbSync**).
2. Click **Add new DAV account > Manual**.
3. Enter:
   - CalDAV server: `http://localhost:37358/`
   - CardDAV server: `http://localhost:37358/`
   - Username: your SilentSuite email
   - Password: your SilentSuite password
4. Click **Add**.

## Troubleshooting

### "Could not find any calendars"

Make sure the bridge is running. Verify by opening `http://localhost:37358/.web/` in your browser. If the dashboard loads, the bridge is working.

### Password rejected

Use your **SilentSuite password** (the same one you use to log into the SilentSuite web app).

### Calendar not updating

Thunderbird's CalDAV sync interval is 30 minutes by default. To change it: right-click the calendar > **Properties** > **Refresh calendar every X minutes**.

### Bridge not running

If Thunderbird can't connect, check:
1. Is the bridge running? Look for the tray icon or run `silentsuite-bridge --version`.
2. Start the bridge: `silentsuite-bridge`
3. Check the dashboard: `http://localhost:37358/.web/`

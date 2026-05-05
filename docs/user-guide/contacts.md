# Contacts

Your address book lives at [app.silentsuite.io/contacts](https://app.silentsuite.io/contacts). Names, emails, phone numbers, addresses, notes, photos — every field is encrypted on your device before sync.

## Add a Contact

1. Click **+ Add Contact**.
2. Fill in the fields you want — at minimum a name. Email, phone, address, organisation, birthday, notes, and photo are all optional.
3. Save. The contact is serialized to vCard (`VCARD`), encrypted, and synced.

## Edit / Delete

Open a contact, edit its fields, save. Or open and delete. Changes are re-encrypted and synced.

## Search

The search box at the top of the contacts list filters by name, email, phone, or organisation. Search runs against your locally decrypted data, so it's fast and works offline.

## Import

**Settings → Import** accepts `.vcf` files (vCard 3.0 and 4.0). Parsing is local-only — the file content never leaves your browser unencrypted. Multi-contact files are supported (one big `.vcf` with many `BEGIN:VCARD` blocks).

## Export

**Settings → Export** gives you:

- **Contacts (`.vcf`)** — all contacts as a single vCard file
- **Everything (`.zip`)** — calendars, contacts, and tasks together

Both are built from your locally decrypted data.

## Bridge / CardDAV clients

With the [desktop bridge](./getting-started.md#desktop-caldav--carddav-via-the-bridge) installed, any CardDAV client (Thunderbird, Apple Contacts, GNOME Contacts, Evolution) can read and write the same contacts through `localhost:37358`.

## Sharing

Shared address books between accounts are not supported in v0.1.0-beta. Your contacts are visible only to you, across your own devices.

## Limits in this beta

- A single default contacts collection per account. Managing multiple address books is on the roadmap (see [issue #88](https://github.com/silent-suite/silentsuite/issues/88)).
- No OAuth-based one-click import from Google or iCloud yet — file-based `.vcf` import only. (On the roadmap.)

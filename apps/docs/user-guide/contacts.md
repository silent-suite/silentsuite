# How to Manage Your Contacts

Your contacts are end-to-end encrypted. Only your devices can read them.

Contacts can be organized into multiple address books. Each address book is a separate encrypted collection that syncs across your devices and compatible CardDAV clients.

## Add a Contact

1. Open the Contacts view.
2. Tap or click "Add Contact."
3. Enter the contact details (name, email, phone, address, notes).
4. Save. The contact is encrypted on your device and synced.

## Edit a Contact

1. Open the contact you want to change.
2. Make your changes.
3. Save. The updated contact is re-encrypted and synced to your other devices.

## Favorites

Select the star beside a contact and use the **Favorites** view to filter starred contacts from visible address books. Favorites use the shared vCard contract; Android synchronization requires a SilentSuite Android version that supports contact favorites. In a shared address book the value is global to all members; writable members can change it and read-only members cannot.

Favorite status remains inside the end-to-end encrypted vCard content, not plaintext collection metadata, indexes, or logs. Offline web changes use encrypted local item content plus a content-free queue record. An online failure rolls the star back. Read-only address books cannot be changed.

## Delete a Contact

1. Open the contact.
2. Select delete.
3. The deletion syncs across all your devices.

## Import

You can import contacts from vCard (`.vcf`) and CSV files. This makes it straightforward to migrate from other services or consolidate contacts from multiple sources.

## Export

Export your contacts at any time. Your data belongs to you, and you can take it with you.

SilentSuite uses the private `X-SILENTSUITE-FAVORITE` vCard extension. The Bridge preserves received extensions, but favorite is not standardized across CardDAV. Generic CardDAV clients have no promised compatible favorite UI, and complete-card writers may remove unknown extensions.

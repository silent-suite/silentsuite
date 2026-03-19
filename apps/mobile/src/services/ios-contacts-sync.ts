import * as Contacts from 'expo-contacts';
import { Platform } from 'react-native';
import type { Contact } from '@silentsuite/core';

export async function requestContactsPermissions(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const { status } = await Contacts.requestPermissionsAsync();
  return status === 'granted';
}

export async function syncContactsToDevice(contacts: Contact[]): Promise<void> {
  // Get existing SilentSuite contacts (identified by notes field containing uid)
  const { data: deviceContacts } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Note, Contacts.Fields.Name],
  });
  
  const deviceContactMap = new Map<string, Contacts.Contact>();
  for (const dc of deviceContacts) {
    const uid = dc.note?.match(/silentsuite-uid:([^\s]+)/)?.[1];
    if (uid) deviceContactMap.set(uid, dc);
  }

  for (const contact of contacts) {
    const contactData: Partial<Contacts.Contact> = {
      contactType: Contacts.ContactTypes.Person,
      firstName: contact.name?.given || '',
      lastName: contact.name?.family || '',
      company: contact.organization || '',
      note: `silentsuite-uid:${contact.uid}`,
      phoneNumbers: contact.phones?.map((p) => ({ label: p.type || 'mobile', number: p.value })),
      emails: contact.emails?.map((e) => ({ label: e.type || 'home', email: e.value })),
    };

    const existing = deviceContactMap.get(contact.uid);
    const existingId = (existing as any)?.id;
    if (existing && existingId) {
      await Contacts.updateContactAsync({ ...contactData, id: existingId } as any);
    } else {
      await Contacts.addContactAsync(contactData as any);
    }
  }

  // Remove contacts that no longer exist in Etebase
  const etebaseUids = new Set(contacts.map((c) => c.uid));
  for (const [uid, deviceContact] of deviceContactMap) {
    const dcId = (deviceContact as any)?.id;
    if (!etebaseUids.has(uid!) && dcId) {
      await Contacts.removeContactAsync(dcId);
    }
  }
}

export async function removeSilentSuiteContacts(): Promise<void> {
  const { data: deviceContacts } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Note],
  });
  
  for (const dc of deviceContacts) {
    if (dc.note?.includes('silentsuite-uid:') && dc.id) {
      await Contacts.removeContactAsync(dc.id);
    }
  }
}

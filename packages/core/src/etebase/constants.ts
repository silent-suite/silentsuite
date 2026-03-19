export const COLLECTION_TYPE_CALENDAR = 'etebase.vevent' as const;
export const COLLECTION_TYPE_TASKS = 'etebase.vtodo' as const;
export const COLLECTION_TYPE_CONTACTS = 'etebase.vcard' as const;

export type CollectionType =
  | typeof COLLECTION_TYPE_CALENDAR
  | typeof COLLECTION_TYPE_TASKS
  | typeof COLLECTION_TYPE_CONTACTS;

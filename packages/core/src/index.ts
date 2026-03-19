// @silentsuite/core - Etebase SDK integration and data models

// Etebase client
export {
  initializeEtebase,
  signUp,
  logIn,
  restoreSession,
  saveSession,
  changePassword,
  logout,
} from './etebase/client.js';

// Etebase constants
export {
  COLLECTION_TYPE_CALENDAR,
  COLLECTION_TYPE_TASKS,
  COLLECTION_TYPE_CONTACTS,
} from './etebase/constants.js';
export type { CollectionType } from './etebase/constants.js';

// Etebase types
export type {
  SyncStatus,
  ChangeType,
  SyncChangeEvent,
  CollectionAccessLevel,
  SyncEngineOptions,
} from './etebase/types.js';

// Collection manager
export {
  createCollection,
  listCollections,
  getCollection,
  createItem,
  listItems,
  updateItem,
  deleteItem,
  batchUpload,
} from './etebase/collections.js';
export type { CollectionMeta, ItemListResponse } from './etebase/collections.js';

// Sync engine
export { SyncEngine } from './etebase/sync.js';

// Calendar event model
export {
  toVEvent,
  fromVEvent,
  serializeCalendarEvent,
  deserializeCalendarEvent,
  buildAlarmTrigger,
  parseAlarmTriggerMinutes,
} from './models/calendar-event.js';
export type { CalendarEvent } from './models/calendar-event.js';

// Task model
export {
  toVTodo,
  fromVTodo,
  serializeTask,
  deserializeTask,
} from './models/task.js';
export type { Task } from './models/task.js';

// Contact model
export {
  toVCard,
  fromVCard,
  serializeContact,
  deserializeContact,
  getContactInitials,
} from './models/contact.js';
export type { Contact } from './models/contact.js';

// Model types
export type { DateRange, Priority, SortOrder } from './models/types.js';

// iCal parser
export {
  parseVEvent,
  generateVEvent,
  parseVCalendar,
  generateVCalendar,
  parseVTodo,
  generateVTodo,
} from './utils/ical-parser.js';
export type { VEvent, VAlarm, VTodo } from './utils/ical-parser.js';

// vCard parser
export {
  parseVCard,
  generateVCard,
} from './utils/vcard-parser.js';
export type { VCard, VCardName, VCardPhone, VCardEmail, VCardAddress } from './utils/vcard-parser.js';

// Todoist CSV parser
export { parseTodoistCsv } from './utils/csv-parser.js';

// Recurrence expansion
export { expandRecurrence } from './utils/recurrence.js';

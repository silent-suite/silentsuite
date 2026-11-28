// @silentsuite/core - Etebase SDK integration and data models

// Etebase client
export {
  signUp,
  logIn,
  restoreSession,
  saveSession,
  getAccountFingerprint,
  changePassword,
  signLoginEmailChange,
  encodeLoginEmailChangeRequest,
  logout,
} from './etebase/client.js';
export type { LoginEmailChangeSignature } from './etebase/client.js';

// Etebase constants
export {
  COLLECTION_TYPE_CALENDAR,
  COLLECTION_TYPE_TASKS,
  COLLECTION_TYPE_CONTACTS,
  COLLECTION_TYPE_NOTES,
  COLLECTION_TYPE_PREFERENCES,
  COLLECTION_TYPE_LABEL_INDEX,
} from './etebase/constants.js';
export type { CollectionType } from './etebase/constants.js';

// Etebase types
export type {
  SyncStatus,
  ChangeType,
  SyncChangeEvent,
  CollectionAccessLevel,
  SyncEngineOptions,
  ItemMeta,
} from './etebase/types.js';

// Collection manager
export {
  createCollection,
  listCollections,
  getCollection,
  updateCollectionMeta,
  deleteCollection,
  createItem,
  listItems,
  updateItem,
  deleteItem,
  savedRevisionOf,
  fetchItemFresh,
  updateItemIfUnchanged,
  deleteItemIfUnchanged,
  deleteCollectionIfUnchanged,
} from './etebase/collections.js';
export type { CollectionMeta, CollectionMetaUpdate, ConditionalDeleteResult, ConditionalUpdateResult, ItemListResponse } from './etebase/collections.js';

// Sharing / invitations
export {
  listIncomingInvitations,
  listOutgoingInvitations,
  acceptInvitation,
  rejectInvitation,
  cancelOutgoingInvitation,
  fetchUserProfile,
  inviteToCollection,
  getPublicKeyFingerprint,
  snapshotInvitation,
  listCollectionMembers,
  removeCollectionMember,
  leaveCollection,
  modifyCollectionMemberAccess,
} from './etebase/sharing.js';
export type {
  SharingAccessLevel,
  ListSharingOptions,
  UserProfile,
  CollectionMember,
} from './etebase/sharing.js';

// Sync engine
export { SyncEngine, isUnauthorizedError } from './etebase/sync.js';
export type { StokenAdvanceEvent } from './etebase/sync.js';

// Calendar event model
export {
  fromVEvent,
  serializeCalendarEvent,
  deserializeCalendarEvent,
  buildAlarmTrigger,
  parseAlarmTriggerMinutes,
  parseICalDateValue,
  splitRetainedRecurrenceDates,
  occurrenceEnd,
} from './models/calendar-event.js';
export type { CalendarEvent } from './models/calendar-event.js';

// Task model
export {
  toVTodo,
  serializeTask,
  deserializeTask,
  taskICalDateFromProperty,
} from './models/task.js';
export type { Task, TaskStatus, TaskICalDate, TaskICalDateKind } from './models/task.js';

// Contact model
export {
  toVCard,
  serializeContact,
  deserializeContact,
} from './models/contact.js';
export type { Contact } from './models/contact.js';

// Note model (Etebase Markdown notes / etebase.md.note)
export {
  isMarkdownNoteItem,
  noteToItemMeta,
  noteFromEtebaseItem,
  serializeNote,
  deserializeNote,
} from './models/note.js';
export type { Note } from './models/note.js';

// Model types
export type { DateRange, Priority, SortOrder } from './models/types.js';

// Synced preferences model
export {
  DEFAULT_SYNCED_PREFERENCES,
  createSyncedPreferences,
  getSyncedPreferenceValues,
  getSyncedPreferenceTimestamps,
  mergeSyncedPreferences,
  serializePreferences,
  deserializePreferences,
} from './models/preferences.js';
export type {
  SyncedPreferenceKey,
  TimeFormat,
  FirstDayOfWeek,
  DefaultReminder,
  DateFormat,
  DayBoundaryHour,
  SyncedPreferenceValues,
  SyncedPreferenceTimestamps,
  VersionedPreference,
  SyncedPreferencesV1,
} from './models/preferences.js';

// Synced label index model
export {
  createEmptyLabelIndex,
  recordLabelsUsed,
  mergeLabelIndexes,
  serializeLabelIndex,
  deserializeLabelIndex,
  suggestLabels,
} from './models/label-index.js';
export type {
  LabelIndexSource,
  SyncedLabelEntryV1,
  SyncedLabelIndexV1,
} from './models/label-index.js';

// iCal parser
export {
  parseVCalendar,
  generateVCalendar,
  parseVTodo,
} from './utils/ical-parser.js';
export type { VEvent, VAlarm, VTodo } from './utils/ical-parser.js';

// vCard parser
export {
  parseVCard,
} from './utils/vcard-parser.js';
export type { VCard, VCardName, VCardPhone, VCardEmail, VCardAddress } from './utils/vcard-parser.js';

// Todoist CSV parser
export { parseTodoistCsv, parseTodoistDate } from './utils/csv-parser.js';
export { isKnownTimeZone, resolveTimeZone, decodeTimeZone } from './utils/zoned-time.js';
export { parseICalDurationSeconds } from './utils/ical-duration.js';

// Recurrence expansion
export { untilDateBefore, untilTimeBefore, occurrenceWallClock } from './utils/recurrence.js';
export type { RecurrenceOptions } from './utils/recurrence.js';
export {
  isFloatingICalDateTime,
  recurrenceTimeZone,
  expandEventRecurrence,
  gapWallClock,
  validStartWallClock,
  eventOccurrenceWallClock,
  recurrenceRuleFrom,
  overridesWithout,
  overridesBefore,
  overridesInForm,
} from './models/calendar-event.js';
export type { StartForm } from './models/calendar-event.js';

// Generated Birthdays calendar (pure contract helpers; contracts/birthday-calendar)
export {
  BIRTHDAY_MARKER_TYPE,
  BIRTHDAY_EVENT_UID_PREFIX,
  BIRTHDAY_MAX_RERUNS,
  parseBirthdayMarker,
  birthdayMarkerContent,
  normalizeBirthday,
  birthdayFromVCard,
  birthdayEventUid,
  isGeneratedBirthdayUid,
  birthdayEventFields,
  birthdayEventContent,
  parseBirthdayEventFields,
  isCurrentBirthdayEvent,
  birthdayEventsFromSource,
  planBirthdayCalendar,
  decideAfterBirthdayRun,
} from './birthdays/birthday-calendar.js';
export type {
  BirthdayMarkerState,
  MonthDay,
  ContactBirthday,
  BirthdayEvent,
  BirthdayEventFields,
  BirthdaySnapshotItem,
  BirthdaySourceSnapshot,
  BirthdaySourceResult,
  BirthdayCalendarSnapshot,
  BirthdayCalendarPlan,
  BirthdayPlanResult,
  BirthdayPostCheck,
} from './birthdays/birthday-calendar.js';

export { WINDOWS_TO_IANA } from './utils/windows-zones.js';

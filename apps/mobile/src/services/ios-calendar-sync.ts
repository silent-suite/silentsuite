import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import type { CalendarEvent } from '@silentsuite/core';

const CALENDAR_NAME = 'SilentSuite';
const CALENDAR_COLOR = '#34d399';

let silentSuiteCalendarId: string | null = null;

export async function requestCalendarPermissions(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  return status === 'granted';
}

export async function getOrCreateCalendar(): Promise<string> {
  if (silentSuiteCalendarId) return silentSuiteCalendarId;

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find((c) => c.title === CALENDAR_NAME && c.source?.name === CALENDAR_NAME);

  if (existing) {
    silentSuiteCalendarId = existing.id;
    return existing.id;
  }

  // Find the default calendar source (local)
  let defaultCalendarSource: any;
  if (Platform.OS === 'ios') {
    const defaultCal = await Calendar.getDefaultCalendarAsync();
    if (defaultCal) {
      defaultCalendarSource = defaultCal.source;
    } else {
      // Fallback: find a local source
      const allCalendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const localSource = allCalendars.find((c) => c.source?.type === 'local')?.source;
      defaultCalendarSource = localSource ?? { isLocalAccount: true, name: CALENDAR_NAME, type: Calendar.CalendarType.LOCAL as any };
    }
  } else {
    defaultCalendarSource = { isLocalAccount: true, name: CALENDAR_NAME, type: Calendar.CalendarType.LOCAL as any };
  }

  const id = await Calendar.createCalendarAsync({
    title: CALENDAR_NAME,
    color: CALENDAR_COLOR,
    entityType: Calendar.EntityTypes.EVENT,
    sourceId: (defaultCalendarSource as any)?.id,
    source: defaultCalendarSource as any,
    name: CALENDAR_NAME,
    ownerAccount: 'silentsuite',
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
  });

  silentSuiteCalendarId = id;
  return id;
}

export async function syncEventsToDevice(events: CalendarEvent[]): Promise<void> {
  const calId = await getOrCreateCalendar();
  
  // Get existing device events in this calendar
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const end = new Date();
  end.setFullYear(end.getFullYear() + 2);
  
  const deviceEvents = await Calendar.getEventsAsync([calId], start, end);
  const deviceEventMap = new Map(deviceEvents.map((e) => [e.notes?.match(/uid:([^\s]+)/)?.[1], e]));

  for (const event of events) {
    const existingDevice = deviceEventMap.get(event.uid);
    
    const eventData: Partial<Calendar.Event> = {
      title: event.title,
      startDate: new Date(event.startDate),
      endDate: new Date(event.endDate),
      allDay: event.allDay,
      location: event.location || undefined,
      notes: `${event.description || ''}\nuid:${event.uid}`.trim(),
      calendarId: calId,
    };

    if (existingDevice) {
      await Calendar.updateEventAsync(existingDevice.id, eventData);
    } else {
      await Calendar.createEventAsync(calId, eventData as any);
    }
  }

  // Delete device events that no longer exist in Etebase
  const etebaseUids = new Set(events.map((e) => e.uid));
  for (const [uid, deviceEvent] of deviceEventMap) {
    if (uid && !etebaseUids.has(uid)) {
      await Calendar.deleteEventAsync(deviceEvent.id);
    }
  }
}

export async function deleteSilentSuiteCalendar(): Promise<void> {
  if (silentSuiteCalendarId) {
    await Calendar.deleteCalendarAsync(silentSuiteCalendarId);
    silentSuiteCalendarId = null;
  }
}

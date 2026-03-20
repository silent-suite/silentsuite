/**
 * Sync Actions — bridges domain stores to Etebase server.
 *
 * Each action:
 * 1. Updates the local Zustand store (optimistic UI)
 * 2. Serializes the PIM object to iCal/vCard
 * 3. Creates/updates/deletes the Etebase item
 * 4. Replaces the temp local ID with the Etebase item UID
 *
 * These are called from screen components instead of raw store methods.
 */
import { useCalendarStore } from '../stores/calendar-store';
import { useContactStore } from '../stores/contact-store';
import { useTaskStore } from '../stores/task-store';
import { useEtebaseStore } from '../stores/etebase-store';
import { useSyncStore } from '../stores/sync-store';
import type { CalendarEvent, Contact, Task } from '@silentsuite/core';

// --- Calendar ---

export async function createEvent(event: CalendarEvent): Promise<string> {
  const calStore = useCalendarStore.getState();
  const etebase = useEtebaseStore.getState();

  // Optimistic local add
  calStore.addEvent(event);

  try {
    const { serializeCalendarEvent } = await import('@silentsuite/core');
    const content = serializeCalendarEvent(event);
    const uid = await etebase.createItem('calendar', content);

    // Replace temp ID with Etebase UID
    calStore.updateEvent(event.id, { id: uid, uid });
    return uid;
  } catch (e: any) {
    console.error('Failed to create event in Etebase:', e);
    // Remove the optimistic add on failure
    calStore.removeEvent(event.id);
    throw e;
  }
}

export async function updateEvent(event: CalendarEvent): Promise<void> {
  const calStore = useCalendarStore.getState();
  const etebase = useEtebaseStore.getState();

  // Store previous state for rollback
  const previous = calStore.events.find((e) => e.id === event.id);

  // Optimistic local update
  calStore.updateEvent(event.id, event);

  try {
    const { serializeCalendarEvent } = await import('@silentsuite/core');
    const content = serializeCalendarEvent(event);
    await etebase.updateItem('calendar', event.id, content);
  } catch (e: any) {
    console.error('Failed to update event in Etebase:', e);
    if (previous) calStore.updateEvent(event.id, previous);
    throw e;
  }
}

export async function deleteEvent(eventId: string): Promise<void> {
  const calStore = useCalendarStore.getState();
  const etebase = useEtebaseStore.getState();

  // Store for rollback
  const removed = calStore.events.find((e) => e.id === eventId);

  // Optimistic local remove
  calStore.removeEvent(eventId);

  try {
    await etebase.deleteItem('calendar', eventId);
  } catch (e: any) {
    console.error('Failed to delete event in Etebase:', e);
    if (removed) calStore.addEvent(removed);
    throw e;
  }
}

// --- Contacts ---

export async function createContact(contact: Contact): Promise<string> {
  const conStore = useContactStore.getState();
  const etebase = useEtebaseStore.getState();

  conStore.addContact(contact);

  try {
    const { serializeContact } = await import('@silentsuite/core');
    const content = serializeContact(contact);
    const uid = await etebase.createItem('contacts', content);

    conStore.updateContact(contact.id, { id: uid, uid });
    return uid;
  } catch (e: any) {
    console.error('Failed to create contact in Etebase:', e);
    conStore.removeContact(contact.id);
    throw e;
  }
}

export async function updateContact(contact: Contact): Promise<void> {
  const conStore = useContactStore.getState();
  const etebase = useEtebaseStore.getState();

  const previous = conStore.contacts.find((c) => c.id === contact.id);
  conStore.updateContact(contact.id, contact);

  try {
    const { serializeContact } = await import('@silentsuite/core');
    const content = serializeContact(contact);
    await etebase.updateItem('contacts', contact.id, content);
  } catch (e: any) {
    console.error('Failed to update contact in Etebase:', e);
    if (previous) conStore.updateContact(contact.id, previous);
    throw e;
  }
}

export async function deleteContact(contactId: string): Promise<void> {
  const conStore = useContactStore.getState();
  const etebase = useEtebaseStore.getState();

  const removed = conStore.contacts.find((c) => c.id === contactId);
  conStore.removeContact(contactId);

  try {
    await etebase.deleteItem('contacts', contactId);
  } catch (e: any) {
    console.error('Failed to delete contact in Etebase:', e);
    if (removed) conStore.addContact(removed);
    throw e;
  }
}

// --- Tasks ---

export async function createTask(task: Task): Promise<string> {
  const tskStore = useTaskStore.getState();
  const etebase = useEtebaseStore.getState();

  tskStore.addTask(task);

  try {
    const { serializeTask } = await import('@silentsuite/core');
    const content = serializeTask(task);
    const uid = await etebase.createItem('tasks', content);

    tskStore.updateTask(task.id, { id: uid, uid });
    return uid;
  } catch (e: any) {
    console.error('Failed to create task in Etebase:', e);
    tskStore.removeTask(task.id);
    throw e;
  }
}

export async function updateTask(task: Task): Promise<void> {
  const tskStore = useTaskStore.getState();
  const etebase = useEtebaseStore.getState();

  const previous = tskStore.tasks.find((t) => t.id === task.id);
  tskStore.updateTask(task.id, task);

  try {
    const { serializeTask } = await import('@silentsuite/core');
    const content = serializeTask(task);
    await etebase.updateItem('tasks', task.id, content);
  } catch (e: any) {
    console.error('Failed to update task in Etebase:', e);
    if (previous) tskStore.updateTask(task.id, previous);
    throw e;
  }
}

export async function deleteTask(taskId: string): Promise<void> {
  const tskStore = useTaskStore.getState();
  const etebase = useEtebaseStore.getState();

  const removed = tskStore.tasks.find((t) => t.id === taskId);
  tskStore.removeTask(taskId);

  try {
    await etebase.deleteItem('tasks', taskId);
  } catch (e: any) {
    console.error('Failed to delete task in Etebase:', e);
    if (removed) tskStore.addTask(removed);
    throw e;
  }
}

export async function toggleTaskComplete(task: Task): Promise<void> {
  const updated = { ...task, completed: !task.completed, updated_at: new Date() };
  await updateTask(updated);
}

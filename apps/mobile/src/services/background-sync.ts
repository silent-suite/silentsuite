import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

const BACKGROUND_SYNC_TASK = 'SILENTSUITE_BACKGROUND_SYNC';

// Define the background task
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // Dynamic import to avoid loading heavy deps at task registration time
    const { useEtebaseStore } = await import('../stores/etebase-store');
    const { useCalendarStore } = await import('../stores/calendar-store');
    const { useContactStore } = await import('../stores/contact-store');
    const { useTaskStore } = await import('../stores/task-store');

    const etebase = useEtebaseStore.getState();
    if (!etebase.isInitialized) {
      await etebase.initialize();
    }

    // Fetch latest items from all collections
    const calItems = await etebase.fetchAllItems('calendar');
    const conItems = await etebase.fetchAllItems('contacts');
    const tskItems = await etebase.fetchAllItems('tasks');

    // Parse and update stores
    const { deserializeCalendarEvent } = await import('@silentsuite/core');
    const { deserializeContact } = await import('@silentsuite/core');
    const { deserializeTask } = await import('@silentsuite/core');

    useCalendarStore.getState().setEvents(calItems.map(i => deserializeCalendarEvent(i.content)));
    useContactStore.getState().setContacts(conItems.map(i => deserializeContact(i.content)));
    useTaskStore.getState().setTasks(tskItems.map(i => deserializeTask(i.content)));

    // Sync to device if bridge mode
    if (Platform.OS === 'ios') {
      const { syncEventsToDevice } = await import('./ios-calendar-sync');
      const { syncContactsToDevice } = await import('./ios-contacts-sync');
      await syncEventsToDevice(useCalendarStore.getState().events);
      await syncContactsToDevice(useContactStore.getState().contacts);
    }

    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.error('Background sync failed:', e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  const status = await BackgroundFetch.getStatusAsync();
  if (status === BackgroundFetch.BackgroundFetchStatus.Denied) {
    console.warn('Background fetch is denied by the OS');
    return;
  }

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: 15 * 60, // 15 minutes
    stopOnTerminate: false,
    startOnBoot: true,
  });
}

export async function unregisterBackgroundSync(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (isRegistered) {
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}

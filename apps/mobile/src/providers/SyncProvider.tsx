import React, { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/auth-store';
import { useEtebaseStore } from '../stores/etebase-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useContactStore } from '../stores/contact-store';
import { useTaskStore } from '../stores/task-store';
import { useSyncStore } from '../stores/sync-store';

/**
 * SyncProvider orchestrates the full data pipeline:
 *   auth (isAuthenticated) → etebase init → fetch all items → populate domain stores
 *
 * Wraps the authenticated portion of the app. When the user logs in,
 * this provider initializes the Etebase SDK, creates/fetches collections,
 * loads all items, and pushes them into the Zustand domain stores.
 */
export function SyncProvider({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isInitialized = useEtebaseStore((s) => s.isInitialized);
  const isInitializing = useEtebaseStore((s) => s.isInitializing);
  const initialize = useEtebaseStore((s) => s.initialize);
  const destroy = useEtebaseStore((s) => s.destroy);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      // User logged out — clear etebase state
      destroy();
      hasRunRef.current = false;
      return;
    }

    if (isInitialized || isInitializing || hasRunRef.current) return;
    hasRunRef.current = true;

    initializeAndLoad();
  }, [isAuthenticated, isInitialized, isInitializing]);

  async function initializeAndLoad() {
    const syncStore = useSyncStore.getState();
    syncStore.setStatus('syncing');

    try {
      // 1. Initialize Etebase SDK (restore session, fetch/create collections)
      await initialize();

      // 2. Fetch all items from all three collections
      const etebase = useEtebaseStore.getState();
      const [calItems, conItems, tskItems] = await Promise.all([
        etebase.fetchAllItems('calendar'),
        etebase.fetchAllItems('contacts'),
        etebase.fetchAllItems('tasks'),
      ]);

      // 3. Deserialize and push into domain stores
      const core = await import('@silentsuite/core');

      const events = calItems
        .map((item) => {
          try { return core.deserializeCalendarEvent(item.content); }
          catch (e) { console.warn('Failed to parse calendar event:', item.uid, e); return null; }
        })
        .filter(Boolean) as any[];

      const contacts = conItems
        .map((item) => {
          try { return core.deserializeContact(item.content); }
          catch (e) { console.warn('Failed to parse contact:', item.uid, e); return null; }
        })
        .filter(Boolean) as any[];

      const tasks = tskItems
        .map((item) => {
          try { return core.deserializeTask(item.content); }
          catch (e) { console.warn('Failed to parse task:', item.uid, e); return null; }
        })
        .filter(Boolean) as any[];

      useCalendarStore.getState().setEvents(events);
      useContactStore.getState().setContacts(contacts);
      useTaskStore.getState().setTasks(tasks);

      syncStore.setSynced();
    } catch (e: any) {
      console.error('SyncProvider initialization failed:', e);
      syncStore.setError(e.message || 'Sync failed');
      hasRunRef.current = false; // allow retry
    }
  }

  return <>{children}</>;
}

/**
 * Trigger a full sync cycle — fetch fresh data from server and update stores.
 * Call this from pull-to-refresh or manual sync button.
 */
export async function triggerFullSync() {
  const etebase = useEtebaseStore.getState();
  const syncStore = useSyncStore.getState();

  if (!etebase.isInitialized) return;

  syncStore.setStatus('syncing');
  try {
    const [calItems, conItems, tskItems] = await Promise.all([
      etebase.fetchAllItems('calendar'),
      etebase.fetchAllItems('contacts'),
      etebase.fetchAllItems('tasks'),
    ]);

    const core = await import('@silentsuite/core');

    useCalendarStore.getState().setEvents(
      calItems.map((i) => { try { return core.deserializeCalendarEvent(i.content); } catch { return null; } }).filter(Boolean) as any[]
    );
    useContactStore.getState().setContacts(
      conItems.map((i) => { try { return core.deserializeContact(i.content); } catch { return null; } }).filter(Boolean) as any[]
    );
    useTaskStore.getState().setTasks(
      tskItems.map((i) => { try { return core.deserializeTask(i.content); } catch { return null; } }).filter(Boolean) as any[]
    );

    syncStore.setSynced();
  } catch (e: any) {
    syncStore.setError(e.message || 'Sync failed');
  }
}

import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { useCalendarStore } from './calendar-store';
import { useContactStore } from './contact-store';
import { useTaskStore } from './task-store';
import { mmkv } from './mmkv-storage';

const ETEBASE_SESSION_KEY = 'etebase_session';
const ETEBASE_USER_KEY = 'etebase_user';
const ETEBASE_SERVER_URL = 'https://server.silentsuite.io';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  isRestoring: boolean;
  user: string | null;
  error: string | null;
  etebaseSession: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: false,
  isRestoring: true,
  user: null,
  error: null,
  etebaseSession: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const { logIn, saveSession } = await import('@silentsuite/core');
      const account = await logIn(ETEBASE_SERVER_URL, email, password);
      const session = await saveSession(account);

      // Persist to secure storage
      await SecureStore.setItemAsync(ETEBASE_SESSION_KEY, session);
      await SecureStore.setItemAsync(ETEBASE_USER_KEY, email);

      set({
        isAuthenticated: true,
        user: email,
        etebaseSession: session,
        isLoading: false,
        error: null,
      });
    } catch (e: any) {
      const message = e?.message || 'Login failed. Check your credentials and try again.';
      set({ error: message, isLoading: false });
    }
  },

  logout: async () => {
    try {
      const session = get().etebaseSession;
      if (session) {
        const { restoreSession, logout: etebaseLogout } = await import('@silentsuite/core');
        try {
          const account = await restoreSession(ETEBASE_SERVER_URL, session);
          await etebaseLogout(account);
        } catch {
          // Ignore logout failures — session might already be invalid
        }
      }
    } catch {
      // Ignore import failures during logout
    }

    // Clear secure storage
    await SecureStore.deleteItemAsync(ETEBASE_SESSION_KEY);
    await SecureStore.deleteItemAsync(ETEBASE_USER_KEY);

    // Clear domain stores
    useCalendarStore.getState().setEvents([]);
    useContactStore.getState().setContacts([]);
    useTaskStore.getState().setTasks([]);

    // Clear MMKV cache
    mmkv.clearAll();

    set({
      isAuthenticated: false,
      user: null,
      etebaseSession: null,
      error: null,
    });
  },

  restoreSession: async () => {
    set({ isRestoring: true });
    try {
      const session = await SecureStore.getItemAsync(ETEBASE_SESSION_KEY);
      const user = await SecureStore.getItemAsync(ETEBASE_USER_KEY);

      if (session && user) {
        // Validate that the session is still usable
        const { restoreSession } = await import('@silentsuite/core');
        await restoreSession(ETEBASE_SERVER_URL, session);

        set({
          isAuthenticated: true,
          user,
          etebaseSession: session,
          isRestoring: false,
        });
      } else {
        set({ isRestoring: false });
      }
    } catch (e) {
      // Session invalid or expired — user needs to log in again
      await SecureStore.deleteItemAsync(ETEBASE_SESSION_KEY);
      await SecureStore.deleteItemAsync(ETEBASE_USER_KEY);
      set({ isRestoring: false });
    }
  },
}));

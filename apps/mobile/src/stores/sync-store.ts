import { create } from 'zustand';

type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

interface SyncState {
  status: SyncStatus;
  lastSyncedAt: Date | null;
  error: string | null;

  setStatus: (status: SyncStatus) => void;
  setSynced: () => void;
  setError: (error: string) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  lastSyncedAt: null,
  error: null,

  setStatus: (status) => set({ status }),
  setSynced: () => set({ status: 'synced', lastSyncedAt: new Date(), error: null }),
  setError: (error) => set({ status: 'error', error }),
}));

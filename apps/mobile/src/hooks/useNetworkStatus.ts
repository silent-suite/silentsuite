import { useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { useSyncStore } from '../stores/sync-store';

/**
 * Monitors network connectivity and updates sync store status.
 * When going offline, sets status to 'offline'.
 * When coming back online, triggers status to 'idle' (SyncProvider handles actual sync).
 */
export function useNetworkStatus() {
  const setStatus = useSyncStore((s) => s.setStatus);
  const currentStatus = useSyncStore((s) => s.status);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (!state.isConnected) {
        setStatus('offline');
      } else if (currentStatus === 'offline') {
        // Came back online — set to idle so SyncProvider can pick it up
        setStatus('idle');
      }
    });

    return () => unsubscribe();
  }, [currentStatus]);
}

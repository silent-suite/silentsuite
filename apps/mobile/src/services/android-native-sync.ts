import { NativeModules, Platform } from 'react-native';

/**
 * TypeScript interface for the Kotlin NativeSyncModule.
 *
 * The actual Kotlin implementation (NativeSyncModule.kt) is created when
 * the RN app's Android project is set up with the Kotlin sync adapter.
 * This interface provides type-safe access from JavaScript.
 *
 * For now, these are no-op stubs that will be wired when B4.2 integrates
 * the Kotlin sync adapter into the RN Android build.
 */
interface NativeSyncModuleInterface {
  triggerSync(): Promise<void>;
  getSyncStatus(): Promise<{
    lastSyncTime: number;
    isSyncing: boolean;
    errorMessage: string | null;
    calendarCount: number;
    contactCount: number;
    taskCount: number;
  }>;
  setBridgeMode(enabled: boolean): Promise<void>;
}

// Try to get the native module, fall back to stubs
const NativeSyncModuleRaw = NativeModules.NativeSyncModule;

const NativeSyncModuleStub: NativeSyncModuleInterface = {
  triggerSync: async () => { console.log('NativeSyncModule.triggerSync() stub — native module not available'); },
  getSyncStatus: async () => ({
    lastSyncTime: 0,
    isSyncing: false,
    errorMessage: 'Native sync module not available',
    calendarCount: 0,
    contactCount: 0,
    taskCount: 0,
  }),
  setBridgeMode: async (_enabled: boolean) => { console.log('NativeSyncModule.setBridgeMode() stub'); },
};

export const NativeSyncModule: NativeSyncModuleInterface =
  Platform.OS === 'android' && NativeSyncModuleRaw
    ? NativeSyncModuleRaw
    : NativeSyncModuleStub;

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const BRIDGE_MODE_KEY = 'bridge_mode_enabled';

export async function isBridgeModeEnabled(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(BRIDGE_MODE_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

export async function enableBridgeMode(): Promise<void> {
  if (Platform.OS === 'ios') {
    const { requestCalendarPermissions } = await import('./ios-calendar-sync');
    const { requestContactsPermissions } = await import('./ios-contacts-sync');
    const { registerBackgroundSync } = await import('./background-sync');

    const calPerm = await requestCalendarPermissions();
    const conPerm = await requestContactsPermissions();

    if (!calPerm || !conPerm) {
      throw new Error('Calendar and contacts permissions are required for bridge mode');
    }

    await registerBackgroundSync();
  } else if (Platform.OS === 'android') {
    const { NativeSyncModule } = await import('./android-native-sync');
    await NativeSyncModule.setBridgeMode(true);
  }

  await SecureStore.setItemAsync(BRIDGE_MODE_KEY, 'true');
}

export async function disableBridgeMode(): Promise<void> {
  if (Platform.OS === 'ios') {
    const { deleteSilentSuiteCalendar } = await import('./ios-calendar-sync');
    const { removeSilentSuiteContacts } = await import('./ios-contacts-sync');
    const { unregisterBackgroundSync } = await import('./background-sync');

    await deleteSilentSuiteCalendar();
    await removeSilentSuiteContacts();
    await unregisterBackgroundSync();
  } else if (Platform.OS === 'android') {
    const { NativeSyncModule } = await import('./android-native-sync');
    await NativeSyncModule.setBridgeMode(false);
  }

  await SecureStore.setItemAsync(BRIDGE_MODE_KEY, 'false');
}

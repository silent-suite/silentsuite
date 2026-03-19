import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSyncStore } from '../stores/sync-store';
import { colors } from '../theme';

const statusConfig = {
  idle: { color: colors.gray500, label: '' },
  syncing: { color: '#3b82f6', label: 'Syncing...' },
  synced: { color: colors.emerald, label: 'Synced' },
  error: { color: '#ef4444', label: 'Sync error' },
  offline: { color: colors.gray500, label: 'Offline' },
} as const;

export function SyncIndicator() {
  const { status, lastSyncedAt } = useSyncStore();

  if (status === 'idle' || status === 'synced') {
    // Don't show indicator when everything is fine (unless very recently synced)
    if (status === 'synced' && lastSyncedAt) {
      const secAgo = (Date.now() - lastSyncedAt.getTime()) / 1000;
      if (secAgo > 5) return null;
    } else {
      return null;
    }
  }

  const config = statusConfig[status];

  return (
    <View style={[styles.container, { backgroundColor: config.color + '20' }]}>
      {status === 'syncing' && <ActivityIndicator size="small" color={config.color} />}
      <View style={[styles.dot, { backgroundColor: config.color }]} />
      <Text style={[styles.label, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 4, paddingHorizontal: 12, gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 12, fontWeight: '500' },
});

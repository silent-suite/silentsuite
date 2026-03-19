import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Switch, Platform } from 'react-native';
import { colors } from '../../theme';
import { useAuthStore } from '../../stores/auth-store';
import { isBridgeModeEnabled, enableBridgeMode, disableBridgeMode } from '../../services/bridge-mode';

export function SettingsScreen() {
  const { logout, user } = useAuthStore();
  const [bridgeMode, setBridgeMode] = useState(false);
  const [bridgeLoading, setBridgeLoading] = useState(false);

  useEffect(() => {
    isBridgeModeEnabled().then(setBridgeMode);
  }, []);

  const handleBridgeToggle = async (enabled: boolean) => {
    if (enabled) {
      Alert.alert(
        'Enable Bridge Mode',
        Platform.OS === 'ios'
          ? 'SilentSuite will sync your encrypted data to your phone\'s Calendar and Contacts apps. This requires calendar and contacts permissions.'
          : 'SilentSuite will sync your encrypted data to your phone\'s calendar, contacts, and task apps via the background sync adapter.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Enable',
            onPress: async () => {
              setBridgeLoading(true);
              try {
                await enableBridgeMode();
                setBridgeMode(true);
              } catch (e: any) {
                Alert.alert('Error', e.message || 'Could not enable bridge mode');
              }
              setBridgeLoading(false);
            },
          },
        ]
      );
    } else {
      Alert.alert(
        'Disable Bridge Mode',
        'This will remove SilentSuite events and contacts from your phone\'s native apps. Your data is still safe in SilentSuite.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable',
            style: 'destructive',
            onPress: async () => {
              setBridgeLoading(true);
              try {
                await disableBridgeMode();
                setBridgeMode(false);
              } catch (e: any) {
                Alert.alert('Error', e.message || 'Could not disable bridge mode');
              }
              setBridgeLoading(false);
            },
          },
        ]
      );
    }
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <View style={styles.container}>
      {user ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <Text style={styles.email}>{user}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Mode</Text>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>
              {Platform.OS === 'ios' ? 'Sync to iOS apps' : 'Sync to Android apps'}
            </Text>
            <Text style={styles.toggleDescription}>
              {bridgeMode
                ? 'Your data syncs to your phone\'s native calendar, contacts, and task apps.'
                : 'Your data is only accessible inside SilentSuite and at app.silentsuite.io.'}
            </Text>
          </View>
          <Switch
            value={bridgeMode}
            onValueChange={handleBridgeToggle}
            disabled={bridgeLoading}
            trackColor={{ true: colors.emerald }}
          />
        </View>
      </View>

      <Pressable style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy, padding: 16 },
  section: { backgroundColor: colors.navyLight, borderRadius: 12, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: '600', color: colors.gray400, textTransform: 'uppercase', marginBottom: 8 },
  email: { fontSize: 16, color: colors.white },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { fontSize: 16, fontWeight: '500', color: colors.white },
  toggleDescription: { fontSize: 13, color: colors.gray400, marginTop: 4, lineHeight: 18 },
  logoutButton: { backgroundColor: 'rgba(239,68,68,0.15)', padding: 16, borderRadius: 12, alignItems: 'center' },
  logoutText: { color: colors.red500, fontSize: 16, fontWeight: '600' },
});

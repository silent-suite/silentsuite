import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Switch, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuthStore } from '../../stores/auth-store';
import { useTheme } from '../../hooks/useTheme';
import { isBridgeModeEnabled, enableBridgeMode, disableBridgeMode } from '../../services/bridge-mode';
import type { SettingsStackParamList } from '../../navigation/types';

type SettingsNavProp = NativeStackNavigationProp<SettingsStackParamList, 'SettingsHome'>;

export function SettingsScreen() {
  const { colors: theme } = useTheme();
  const navigation = useNavigation<SettingsNavProp>();
  const { logout, user } = useAuthStore();
  const [bridgeMode, setBridgeMode] = useState(false);
  const [bridgeLoading, setBridgeLoading] = useState(false);

  useEffect(() => {
    isBridgeModeEnabled().then(setBridgeMode);
  }, []);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background, padding: 16 },
    section: { backgroundColor: theme.surface, borderRadius: 12, padding: 16, marginBottom: 16 },
    sectionTitle: { fontSize: 12, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', marginBottom: 8 },
    email: { fontSize: 16, color: theme.text },
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    toggleLabel: { fontSize: 16, fontWeight: '500', color: theme.text },
    toggleDescription: { fontSize: 13, color: theme.textSecondary, marginTop: 4, lineHeight: 18 },
    logoutButton: { backgroundColor: 'rgba(239,68,68,0.15)', padding: 16, borderRadius: 12, alignItems: 'center' },
    logoutText: { color: theme.error, fontSize: 16, fontWeight: '600' },
    changePasswordRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      marginTop: 12,
    },
    changePasswordLabel: { fontSize: 16, fontWeight: '500', color: theme.text },
    changePasswordChevron: { fontSize: 18, color: theme.textSecondary },
  }), [theme]);

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
          <Pressable
            style={styles.changePasswordRow}
            onPress={() => navigation.navigate('ChangePassword')}
          >
            <Text style={styles.changePasswordLabel}>Change Password</Text>
            <Text style={styles.changePasswordChevron}>›</Text>
          </Pressable>
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
            trackColor={{ true: theme.accent }}
          />
        </View>
      </View>

      <Pressable style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

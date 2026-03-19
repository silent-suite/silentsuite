import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors } from '../theme';

interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onDismiss, onRetry }: ErrorBannerProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        {onRetry && (
          <Pressable onPress={onRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        )}
        {onDismiss && (
          <Pressable onPress={onDismiss}>
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: 'rgba(239,68,68,0.15)', padding: 12, marginHorizontal: 12, marginTop: 8, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  message: { color: colors.red500, fontSize: 13, flex: 1 },
  actions: { flexDirection: 'row', gap: 12, marginLeft: 8 },
  retryText: { color: colors.emerald, fontSize: 13, fontWeight: '600' },
  dismissText: { color: colors.gray400, fontSize: 13 },
});

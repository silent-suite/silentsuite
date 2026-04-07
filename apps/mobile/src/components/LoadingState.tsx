import React, { useMemo } from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useTheme } from '../hooks/useTheme';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  const { colors: theme } = useTheme();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
    message: { fontSize: 14, color: theme.textSecondary, marginTop: 12 },
  }), [theme]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

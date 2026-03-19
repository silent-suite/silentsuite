import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { useAuthStore } from './src/stores/auth-store';
import { colors } from './src/theme';
import { useNetworkStatus } from './src/hooks/useNetworkStatus';

const silentSuiteDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.emerald,
    background: colors.navy,
    card: colors.navy,
    text: colors.white,
    border: colors.navyLight,
  },
};

const silentSuiteLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: '#10b981',
    background: '#ffffff',
    card: '#ffffff',
    text: '#111827',
    border: '#e5e7eb',
  },
};

export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const isRestoring = useAuthStore((s) => s.isRestoring);
  const colorScheme = useColorScheme();

  useEffect(() => {
    restoreSession();
  }, []);

  useNetworkStatus();

  // Font loading note: Inter font files should be placed in assets/fonts/
  // For now, the app uses system fonts which look good on both iOS and Android.
  // To add Inter: download from fonts.google.com, place .ttf files in assets/fonts/,
  // then uncomment: Font.loadAsync({ 'Inter': require('./assets/fonts/Inter-Regular.ttf') })

  if (isRestoring) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.emerald} />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={colorScheme === 'light' ? silentSuiteLightTheme : silentSuiteDarkTheme}>
        <RootNavigator />
        <StatusBar style="light" />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.navy, justifyContent: 'center', alignItems: 'center' },
});

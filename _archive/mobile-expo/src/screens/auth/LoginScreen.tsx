import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Linking, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { useAuthStore } from '../../stores/auth-store';

export function LoginScreen() {
  const { colors: theme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    inner: { flex: 1 },
    content: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
    title: { fontSize: 28, fontWeight: '700', color: theme.text, textAlign: 'center', marginBottom: 8 },
    subtitle: { fontSize: 14, color: theme.textSecondary, textAlign: 'center', marginBottom: 24 },
    error: { backgroundColor: 'rgba(239,68,68,0.15)', color: theme.error, padding: 12, borderRadius: 8, marginBottom: 16, textAlign: 'center' },
    input: { backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, fontSize: 16, marginBottom: 12, borderWidth: 1, borderColor: theme.border },
    spinner: { marginTop: 12 },
    link: { marginTop: 16, alignItems: 'center' },
    linkText: { color: theme.accent, fontSize: 14 },
  }), [theme]);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    await login(email.trim(), password);
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.inner} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.content}>
          <Text style={styles.title}>Sign In</Text>
          <Text style={styles.subtitle}>Enter your SilentSuite credentials</Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={theme.textSecondary}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={theme.textSecondary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
          />

          <Button
            title={isLoading ? 'Signing in...' : 'Sign In'}
            onPress={handleLogin}
            disabled={isLoading}
          />
          {isLoading && <ActivityIndicator style={styles.spinner} color={theme.accent} />}

          <Pressable onPress={() => Linking.openURL('https://app.silentsuite.io')} style={styles.link}>
            <Text style={styles.linkText}>Don't have an account? Sign up</Text>
          </Pressable>

          <Pressable onPress={() => Linking.openURL('https://app.silentsuite.io/forgot-password')} style={styles.link}>
            <Text style={styles.linkText}>Forgot password?</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

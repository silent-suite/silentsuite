import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Linking, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../../theme';
import { Button } from '../../components/Button';
import { useAuthStore } from '../../stores/auth-store';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);

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
            placeholderTextColor={colors.gray500}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.gray500}
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
          {isLoading && <ActivityIndicator style={styles.spinner} color={colors.emerald} />}

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  inner: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.white, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.gray400, textAlign: 'center', marginBottom: 24 },
  error: { backgroundColor: 'rgba(239,68,68,0.15)', color: colors.red500, padding: 12, borderRadius: 8, marginBottom: 16, textAlign: 'center' },
  input: { backgroundColor: colors.navyLight, color: colors.white, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, fontSize: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.gray700 },
  spinner: { marginTop: 12 },
  link: { marginTop: 16, alignItems: 'center' },
  linkText: { color: colors.emerald, fontSize: 14 },
});

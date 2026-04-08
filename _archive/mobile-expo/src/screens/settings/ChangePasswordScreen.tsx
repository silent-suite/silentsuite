import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useAuthStore } from '../../stores/auth-store';
import { useTheme } from '../../hooks/useTheme';

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Must contain a number';
  return null;
}

export function ChangePasswordScreen() {
  const { colors: theme } = useTheme();
  const changePassword = useAuthStore((s) => s.changePassword);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: theme.background },
        scroll: { flexGrow: 1, padding: 24 },
        title: {
          fontSize: 20,
          fontWeight: '700',
          color: theme.text,
          marginBottom: 6,
        },
        subtitle: {
          fontSize: 14,
          color: theme.textSecondary,
          marginBottom: 28,
          lineHeight: 20,
        },
        label: {
          fontSize: 13,
          fontWeight: '500',
          color: theme.textSecondary,
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        },
        input: {
          backgroundColor: theme.surface,
          color: theme.text,
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderRadius: 8,
          fontSize: 16,
          marginBottom: 4,
          borderWidth: 1,
          borderColor: theme.border,
        },
        inputError: {
          borderColor: '#ef4444',
        },
        fieldError: {
          color: '#ef4444',
          fontSize: 12,
          marginBottom: 14,
        },
        fieldContainer: {
          marginBottom: 16,
        },
        apiErrorBox: {
          backgroundColor: 'rgba(239,68,68,0.15)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
        },
        apiErrorText: {
          color: '#ef4444',
          fontSize: 14,
          textAlign: 'center',
        },
        successBox: {
          backgroundColor: 'rgba(52,211,153,0.15)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
        },
        successText: {
          color: theme.accent,
          fontSize: 14,
          textAlign: 'center',
        },
        button: {
          backgroundColor: theme.accent,
          padding: 16,
          borderRadius: 12,
          alignItems: 'center',
          marginTop: 8,
        },
        buttonDisabled: {
          opacity: 0.6,
        },
        buttonText: {
          color: theme.background,
          fontSize: 16,
          fontWeight: '700',
        },
      }),
    [theme]
  );

  const handleSubmit = async () => {
    // Clear previous state
    setApiError(null);
    setSuccess(false);

    // Client-side validation
    const errors: typeof fieldErrors = {};

    if (!currentPassword.trim()) {
      errors.currentPassword = 'Current password is required';
    }

    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError) {
      errors.newPassword = newPasswordError;
    }

    if (newPassword !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsLoading(true);

    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setApiError(err?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Change Password</Text>
        <Text style={styles.subtitle}>
          Enter your current password and choose a new one.
        </Text>

        {/* Current Password */}
        <View style={styles.fieldContainer}>
          <Text style={styles.label}>Current Password</Text>
          <TextInput
            style={[styles.input, fieldErrors.currentPassword ? styles.inputError : null]}
            placeholder="Current password"
            placeholderTextColor={theme.textSecondary}
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
          />
          {fieldErrors.currentPassword ? (
            <Text style={styles.fieldError}>{fieldErrors.currentPassword}</Text>
          ) : null}
        </View>

        {/* New Password */}
        <View style={styles.fieldContainer}>
          <Text style={styles.label}>New Password</Text>
          <TextInput
            style={[styles.input, fieldErrors.newPassword ? styles.inputError : null]}
            placeholder="New password (min 8 chars)"
            placeholderTextColor={theme.textSecondary}
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
          />
          {fieldErrors.newPassword ? (
            <Text style={styles.fieldError}>{fieldErrors.newPassword}</Text>
          ) : null}
        </View>

        {/* Confirm New Password */}
        <View style={styles.fieldContainer}>
          <Text style={styles.label}>Confirm New Password</Text>
          <TextInput
            style={[styles.input, fieldErrors.confirmPassword ? styles.inputError : null]}
            placeholder="Confirm new password"
            placeholderTextColor={theme.textSecondary}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
          />
          {fieldErrors.confirmPassword ? (
            <Text style={styles.fieldError}>{fieldErrors.confirmPassword}</Text>
          ) : null}
        </View>

        {/* API Error */}
        {apiError ? (
          <View style={styles.apiErrorBox}>
            <Text style={styles.apiErrorText}>{apiError}</Text>
          </View>
        ) : null}

        {/* Success */}
        {success ? (
          <View style={styles.successBox}>
            <Text style={styles.successText}>Password updated successfully.</Text>
          </View>
        ) : null}

        {/* Submit Button */}
        <Pressable
          style={[styles.button, isLoading ? styles.buttonDisabled : null]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={theme.background} />
          ) : (
            <Text style={styles.buttonText}>Update Password</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

import React, { useMemo } from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '../hooks/useTheme';

interface ButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  style?: ViewStyle;
}

export function Button({ title, onPress, disabled, variant = 'primary', style }: ButtonProps) {
  const { colors: theme } = useTheme();

  const styles = useMemo(() => StyleSheet.create({
    button: { backgroundColor: theme.accent, paddingVertical: 14, paddingHorizontal: 24, borderRadius: 8, alignItems: 'center' },
    secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.accent },
    disabled: { opacity: 0.5 },
    text: { color: theme.background, fontSize: 16, fontWeight: '600' },
    secondaryText: { color: theme.accent },
  }), [theme]);

  return (
    <Pressable
      style={[
        styles.button,
        variant === 'secondary' && styles.secondary,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.text, variant === 'secondary' && styles.secondaryText]}>
        {title}
      </Text>
    </Pressable>
  );
}

export const colors = {
  navy: '#1B2838',
  navyLight: '#243447',
  emerald: '#34d399',
  emeraldDark: '#10b981',
  white: '#ffffff',
  gray50: '#f9fafb',
  gray100: '#f3f4f6',
  gray200: '#e5e7eb',
  gray300: '#d1d5db',
  gray400: '#9ca3af',
  gray500: '#6b7280',
  gray600: '#4b5563',
  gray700: '#374151',
  gray800: '#1f2937',
  gray900: '#111827',
  red500: '#ef4444',
  orange500: '#f97316',
  blue500: '#3b82f6',
} as const;

export const darkColors = {
  background: colors.navy,
  surface: colors.navyLight,
  text: colors.white,
  textSecondary: colors.gray400,
  accent: colors.emerald,
  border: colors.gray700,
  error: colors.red500,
} as const;

export const lightColors = {
  background: colors.white,
  surface: colors.gray50,
  text: colors.gray900,
  textSecondary: colors.gray500,
  accent: colors.emeraldDark,
  border: colors.gray200,
  error: colors.red500,
} as const;

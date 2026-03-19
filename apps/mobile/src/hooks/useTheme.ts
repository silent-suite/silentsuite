import { useColorScheme } from 'react-native';
import { darkColors, lightColors } from '../theme';

export type ThemeColors = typeof darkColors | typeof lightColors;

export function useTheme(): { colors: ThemeColors; isDark: boolean } {
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== 'light'; // default to dark
  return {
    colors: isDark ? darkColors : lightColors,
    isDark,
  };
}

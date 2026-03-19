import React from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors } from '../../theme';
import { Button } from '../../components/Button';
import type { AuthStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<AuthStackParamList, 'Welcome'>;

export function WelcomeScreen() {
  const navigation = useNavigation<Nav>();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>SilentSuite</Text>
        <Text style={styles.subtitle}>
          End-to-end encrypted sync for your calendar, contacts, and tasks.
        </Text>

        <View style={styles.features}>
          <FeatureRow text="Syncs seamlessly with your phone's apps" />
          <FeatureRow text="Your data is encrypted before it leaves your device" />
          <FeatureRow text="Runs quietly in the background" />
        </View>
      </View>

      <View style={styles.footer}>
        <Button title="Get Started" onPress={() => navigation.navigate('Login')} />
      </View>
    </SafeAreaView>
  );
}

function FeatureRow({ text }: { text: string }) {
  return (
    <View style={styles.featureRow}>
      <Text style={styles.featureDot}>{'•'}</Text>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  title: { fontSize: 32, fontWeight: '700', color: colors.white, textAlign: 'center', marginBottom: 12 },
  subtitle: { fontSize: 16, color: colors.gray400, textAlign: 'center', lineHeight: 24, marginBottom: 40 },
  features: { gap: 16 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: colors.navyLight, padding: 16, borderRadius: 12 },
  featureDot: { color: colors.emerald, fontSize: 18, lineHeight: 22 },
  featureText: { flex: 1, color: colors.white, fontSize: 14, lineHeight: 22 },
  footer: { paddingHorizontal: 32, paddingBottom: 16 },
});

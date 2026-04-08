import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Linking, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useContactStore } from '../../stores/contact-store';
import { deleteContact as syncDeleteContact } from '../../services/sync-actions';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';

function getInitials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function ContactDetailScreen({ navigation, route }: any) {
  const { colors: theme } = useTheme();
  const { contacts } = useContactStore();
  const contact = contacts.find((c) => c.id === route.params.contactId);
  const { error, showError, dismissError } = useErrorToast();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    scroll: { flex: 1, padding: 16 },
    header: { alignItems: 'center', marginBottom: 24 },
    avatarLarge: { width: 80, height: 80, borderRadius: 40, backgroundColor: theme.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
    avatarText: { fontSize: 28, fontWeight: '700', color: theme.background },
    name: { fontSize: 24, fontWeight: '700', color: theme.text },
    org: { fontSize: 14, color: theme.textSecondary, marginTop: 4 },
    fieldRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
    fieldLabel: { fontSize: 12, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', marginBottom: 4 },
    fieldValue: { fontSize: 16, color: theme.text },
    notFound: { color: theme.textSecondary, textAlign: 'center', marginTop: 40 },
    footer: { padding: 16, borderTopWidth: 1, borderTopColor: theme.border },
  }), [theme]);

  if (!contact) {
    return <View style={styles.container}><Text style={styles.notFound}>Contact not found</Text></View>;
  }

  const handleDelete = () => {
    Alert.alert('Delete Contact', `Delete "${contact.displayName}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await syncDeleteContact(contact.id);
          navigation.goBack();
        } catch (e: any) {
          showError(e.message || 'Operation failed');
        }
      } },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {error && <ErrorBanner message={error} onDismiss={dismissError} />}
      <ScrollView style={styles.scroll}>
        <View style={styles.header}>
          <View style={styles.avatarLarge}>
            <Text style={styles.avatarText}>{getInitials(contact.displayName || '?')}</Text>
          </View>
          <Text style={styles.name}>{contact.displayName}</Text>
          {contact.organization ? <Text style={styles.org}>{contact.organization}</Text> : null}
        </View>

        {contact.phones?.map((p, i) => (
          <Pressable key={i} style={styles.fieldRow} onPress={() => Linking.openURL(`tel:${p.value}`)}>
            <Text style={styles.fieldLabel}>{p.type || 'Phone'}</Text>
            <Text style={styles.fieldValue}>{p.value}</Text>
          </Pressable>
        ))}

        {contact.emails?.map((e, i) => (
          <Pressable key={i} style={styles.fieldRow} onPress={() => Linking.openURL(`mailto:${e.value}`)}>
            <Text style={styles.fieldLabel}>{e.type || 'Email'}</Text>
            <Text style={styles.fieldValue}>{e.value}</Text>
          </Pressable>
        ))}

        {contact.addresses?.map((a, i) => (
          <View key={i} style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{a.type || 'Address'}</Text>
            <Text style={styles.fieldValue}>{[a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ')}</Text>
          </View>
        ))}

        {contact.notes ? (
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Notes</Text>
            <Text style={styles.fieldValue}>{contact.notes}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button title="Edit" onPress={() => navigation.navigate('ContactForm', { contactId: contact.id })} />
        <View style={{ height: 8 }} />
        <Button title="Delete" variant="secondary" onPress={handleDelete} />
      </View>
    </SafeAreaView>
  );
}

import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useContactStore } from '../../stores/contact-store';
import { createContact as syncCreateContact, updateContact as syncUpdateContact } from '../../services/sync-actions';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';
import type { Contact } from '@silentsuite/core';

export function ContactFormScreen({ navigation, route }: any) {
  const { colors: theme } = useTheme();
  const { contacts } = useContactStore();
  const editId = route.params?.contactId;
  const existing = editId ? contacts.find((c) => c.id === editId) : null;

  const [givenName, setGivenName] = useState(existing?.name?.given || '');
  const [familyName, setFamilyName] = useState(existing?.name?.family || '');
  const [phones, setPhones] = useState<Array<{type: string; value: string}>>(
    existing?.phones?.length ? existing.phones : [{ type: 'mobile', value: '' }]
  );
  const [emails, setEmails] = useState<Array<{type: string; value: string}>>(
    existing?.emails?.length ? existing.emails : [{ type: 'home', value: '' }]
  );
  const [organization, setOrganization] = useState(existing?.organization || '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const { error, showError, dismissError } = useErrorToast();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, gap: 12 },
    input: { backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, fontSize: 16 },
    multiline: { minHeight: 80, textAlignVertical: 'top' },
    sectionLabel: { fontSize: 14, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
    fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    removeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(239,68,68,0.15)', justifyContent: 'center', alignItems: 'center' },
    removeBtnText: { color: theme.error, fontSize: 18, fontWeight: '600' },
    addBtn: { paddingVertical: 8 },
    addBtnText: { color: theme.accent, fontSize: 14, fontWeight: '500' },
    footer: { padding: 16, borderTopWidth: 1, borderTopColor: theme.border },
  }), [theme]);

  const handleSave = async () => {
    const displayName = [givenName, familyName].filter(Boolean).join(' ');
    if (!displayName.trim()) return;

    try {
      const now = new Date();
      const filteredPhones = phones.filter(p => p.value.trim());
      const filteredEmails = emails.filter(e => e.value.trim());

      if (existing) {
        await syncUpdateContact({...existing, displayName, name: { prefix: '', given: givenName, family: familyName, suffix: '' }, emails: filteredEmails, phones: filteredPhones, organization, notes, updated_at: now});
      } else {
        const id = `con_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const contact: Contact = {
          id,
          uid: id,
          displayName,
          name: { prefix: '', given: givenName, family: familyName, suffix: '' },
          phones: filteredPhones,
          emails: filteredEmails,
          addresses: [],
          organization,
          title: '',
          notes,
          birthday: null,
          photoUrl: null,
          created_at: now,
          updated_at: now,
        };
        await syncCreateContact(contact);
      }
      navigation.goBack();
    } catch (e: any) {
      showError(e.message || 'Operation failed');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {error && <ErrorBanner message={error} onDismiss={dismissError} />}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <TextInput style={styles.input} placeholder="First name" placeholderTextColor={theme.textSecondary} value={givenName} onChangeText={setGivenName} autoFocus />
        <TextInput style={styles.input} placeholder="Last name" placeholderTextColor={theme.textSecondary} value={familyName} onChangeText={setFamilyName} />

        <Text style={styles.sectionLabel}>Phone</Text>
        {phones.map((p, i) => (
          <View key={i} style={styles.fieldRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Phone number"
              placeholderTextColor={theme.textSecondary}
              value={p.value}
              onChangeText={(v) => { const updated = [...phones]; updated[i] = { ...p, value: v }; setPhones(updated); }}
              keyboardType="phone-pad"
            />
            {phones.length > 1 && (
              <Pressable onPress={() => setPhones(phones.filter((_, j) => j !== i))} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>×</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable onPress={() => setPhones([...phones, { type: 'mobile', value: '' }])} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+ Add phone</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>Email</Text>
        {emails.map((e, i) => (
          <View key={i} style={styles.fieldRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Email address"
              placeholderTextColor={theme.textSecondary}
              value={e.value}
              onChangeText={(v) => { const updated = [...emails]; updated[i] = { ...e, value: v }; setEmails(updated); }}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            {emails.length > 1 && (
              <Pressable onPress={() => setEmails(emails.filter((_, j) => j !== i))} style={styles.removeBtn}>
                <Text style={styles.removeBtnText}>×</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Pressable onPress={() => setEmails([...emails, { type: 'home', value: '' }])} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+ Add email</Text>
        </Pressable>

        <TextInput style={styles.input} placeholder="Organization" placeholderTextColor={theme.textSecondary} value={organization} onChangeText={setOrganization} />
        <TextInput style={[styles.input, styles.multiline]} placeholder="Notes" placeholderTextColor={theme.textSecondary} value={notes} onChangeText={setNotes} multiline numberOfLines={3} />
      </ScrollView>
      <View style={styles.footer}>
        <Button title={existing ? 'Update Contact' : 'Create Contact'} onPress={handleSave} disabled={!givenName.trim() && !familyName.trim()} />
      </View>
    </SafeAreaView>
  );
}

import React, { useMemo } from 'react';
import { View, Text, TextInput, SectionList, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { useContactStore } from '../../stores/contact-store';
import { useSyncStore } from '../../stores/sync-store';
import { triggerFullSync } from '../../providers/SyncProvider';
import { useTheme } from '../../hooks/useTheme';
import type { Contact } from '@silentsuite/core';

function getInitials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function ContactsScreen({ navigation }: any) {
  const { colors: theme } = useTheme();
  const { contacts, searchQuery, setSearchQuery, getFilteredContacts } = useContactStore();
  const syncStatus = useSyncStore((s) => s.status);
  const filtered = getFilteredContacts();

  // Group by first letter
  const sections = useMemo(() => {
    const grouped: Record<string, Contact[]> = {};
    for (const c of filtered) {
      const letter = (c.displayName || '?')[0].toUpperCase();
      if (!grouped[letter]) grouped[letter] = [];
      grouped[letter].push(c);
    }
    return Object.keys(grouped).sort().map(letter => ({ title: letter, data: grouped[letter] }));
  }, [filtered]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    searchBar: { backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 16, paddingVertical: 12, margin: 12, borderRadius: 8, fontSize: 16 },
    sectionHeader: { fontSize: 14, fontWeight: '700', color: theme.accent, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: theme.background },
    contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.accent, justifyContent: 'center', alignItems: 'center' },
    avatarText: { fontSize: 14, fontWeight: '700', color: theme.background },
    contactName: { fontSize: 16, fontWeight: '500', color: theme.text },
    contactSub: { fontSize: 13, color: theme.textSecondary, marginTop: 2 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: theme.text, marginBottom: 4 },
    emptySubtitle: { fontSize: 14, color: theme.textSecondary },
    fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: theme.accent, justifyContent: 'center', alignItems: 'center', elevation: 4 },
    fabText: { fontSize: 28, color: theme.background, fontWeight: '600', marginTop: -2 },
  }), [theme]);

  const renderContact = ({ item }: { item: Contact }) => (
    <Pressable
      style={styles.contactRow}
      onPress={() => navigation.navigate('ContactDetail', { contactId: item.id })}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{getInitials(item.displayName || '?')}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.contactName}>{item.displayName}</Text>
        {item.emails?.[0] && <Text style={styles.contactSub}>{item.emails[0].value}</Text>}
      </View>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchBar}
        placeholder="Search contacts..."
        placeholderTextColor={theme.textSecondary}
        value={searchQuery}
        onChangeText={setSearchQuery}
      />
      {sections.length === 0 ? (
        <ScrollView
          contentContainerStyle={{ flex: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={syncStatus === 'syncing'}
              onRefresh={triggerFullSync}
              tintColor={theme.accent}
            />
          }
        >
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No contacts yet</Text>
            <Text style={styles.emptySubtitle}>Add your first contact</Text>
          </View>
        </ScrollView>
      ) : (
        <SectionList
          sections={sections}
          renderItem={renderContact}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={syncStatus === 'syncing'}
              onRefresh={triggerFullSync}
              tintColor={theme.accent}
            />
          }
        />
      )}
      <Pressable
        style={styles.fab}
        onPress={() => navigation.navigate('ContactForm')}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

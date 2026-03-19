import React from 'react';
import { View, Text, TextInput, SectionList, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { useContactStore } from '../../stores/contact-store';
import { useSyncStore } from '../../stores/sync-store';
import { triggerFullSync } from '../../providers/SyncProvider';
import { colors } from '../../theme';
import type { Contact } from '@silentsuite/core';

function getInitials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function ContactsScreen({ navigation }: any) {
  const { contacts, searchQuery, setSearchQuery, getFilteredContacts } = useContactStore();
  const syncStatus = useSyncStore((s) => s.status);
  const filtered = getFilteredContacts();

  // Group by first letter
  const sections = React.useMemo(() => {
    const grouped: Record<string, Contact[]> = {};
    for (const c of filtered) {
      const letter = (c.displayName || '?')[0].toUpperCase();
      if (!grouped[letter]) grouped[letter] = [];
      grouped[letter].push(c);
    }
    return Object.keys(grouped).sort().map(letter => ({ title: letter, data: grouped[letter] }));
  }, [filtered]);

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
        placeholderTextColor={colors.gray500}
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
              tintColor="#34d399"
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
              tintColor="#34d399"
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  searchBar: { backgroundColor: colors.navyLight, color: colors.white, paddingHorizontal: 16, paddingVertical: 12, margin: 12, borderRadius: 8, fontSize: 16 },
  sectionHeader: { fontSize: 14, fontWeight: '700', color: colors.emerald, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: colors.navy },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.emerald, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 14, fontWeight: '700', color: colors.navy },
  contactName: { fontSize: 16, fontWeight: '500', color: colors.white },
  contactSub: { fontSize: 13, color: colors.gray400, marginTop: 2 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.white, marginBottom: 4 },
  emptySubtitle: { fontSize: 14, color: colors.gray500 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.emerald, justifyContent: 'center', alignItems: 'center', elevation: 4 },
  fabText: { fontSize: 28, color: colors.navy, fontWeight: '600', marginTop: -2 },
});

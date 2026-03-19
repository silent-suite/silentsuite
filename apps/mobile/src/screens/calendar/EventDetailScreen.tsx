import React from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCalendarStore } from '../../stores/calendar-store';
import { deleteEvent as syncDeleteEvent } from '../../services/sync-actions';
import { colors } from '../../theme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';

export function EventDetailScreen({ navigation, route }: any) {
  const { events } = useCalendarStore();
  const event = events.find((e) => e.id === route.params.eventId);
  const { error, showError, dismissError } = useErrorToast();

  if (!event) {
    return (
      <View style={styles.container}>
        <Text style={styles.notFound}>Event not found</Text>
      </View>
    );
  }

  const handleDelete = () => {
    Alert.alert('Delete Event', `Delete "${event.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await syncDeleteEvent(event.id);
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
        <Text style={styles.title}>{event.title}</Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Date</Text>
          <Text style={styles.infoValue}>
            {new Date(event.startDate).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </Text>
        </View>

        {!event.allDay && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Time</Text>
            <Text style={styles.infoValue}>
              {new Date(event.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' — '}
              {new Date(event.endDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}

        {event.recurrenceRule && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Repeats</Text>
            <Text style={styles.infoValue}>
              {event.recurrenceRule.replace('FREQ=', '').toLowerCase().replace(/^\w/, (c: string) => c.toUpperCase())}
            </Text>
          </View>
        )}

        {event.location ? (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Location</Text>
            <Text style={styles.infoValue}>{event.location}</Text>
          </View>
        ) : null}

        {event.description ? (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Description</Text>
            <Text style={styles.infoValue}>{event.description}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button title="Edit" onPress={() => navigation.navigate('EventForm', { eventId: event.id })} />
        <View style={{ height: 8 }} />
        <Button title="Delete" variant="secondary" onPress={handleDelete} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: colors.white, marginBottom: 24 },
  infoRow: { marginBottom: 16 },
  infoLabel: { fontSize: 12, fontWeight: '600', color: colors.gray400, textTransform: 'uppercase', marginBottom: 4 },
  infoValue: { fontSize: 16, color: colors.white, lineHeight: 22 },
  notFound: { color: colors.gray500, textAlign: 'center', marginTop: 40 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: colors.gray700 },
});

import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { useCalendarStore } from '../../stores/calendar-store';
import { useSyncStore } from '../../stores/sync-store';
import { triggerFullSync } from '../../providers/SyncProvider';
import { colors } from '../../theme';
import type { CalendarEvent } from '@silentsuite/core';

export function CalendarScreen({ navigation }: any) {
  const { events, selectedDate, setSelectedDate } = useCalendarStore();
  const syncStatus = useSyncStore((s) => s.status);
  const [markedDates, setMarkedDates] = useState<Record<string, any>>({});

  const dateStr = selectedDate.toISOString().split('T')[0];

  const markedDatesObj = useMemo(() => {
    const marks: Record<string, any> = {};
    for (const event of events) {
      const d = new Date(event.startDate).toISOString().split('T')[0];
      marks[d] = { ...(marks[d] || {}), marked: true, dotColor: colors.emerald };
    }
    marks[dateStr] = { ...(marks[dateStr] || {}), selected: true, selectedColor: colors.emerald };
    return marks;
  }, [events, dateStr]);

  const dayEvents = useMemo(() => {
    return events.filter((e) => {
      const d = new Date(e.startDate).toISOString().split('T')[0];
      return d === dateStr;
    });
  }, [events, dateStr]);

  const renderEvent = ({ item }: { item: CalendarEvent }) => (
    <Pressable
      style={styles.eventCard}
      onPress={() => navigation.navigate('EventDetail', { eventId: item.id })}
    >
      <View style={styles.eventDot} />
      <View style={{ flex: 1 }}>
        <Text style={styles.eventTitle}>{item.title}</Text>
        {item.allDay ? (
          <Text style={styles.eventTime}>All day</Text>
        ) : (
          <Text style={styles.eventTime}>
            {new Date(item.startDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' — '}
            {new Date(item.endDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
        {item.recurrenceRule && <Text style={styles.eventRecurrence}>Repeats</Text>}
      </View>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <Calendar
        markedDates={markedDatesObj}
        onDayPress={(day: any) => setSelectedDate(new Date(day.dateString + 'T12:00:00'))}
        theme={{
          backgroundColor: colors.navy,
          calendarBackground: colors.navy,
          textSectionTitleColor: colors.gray400,
          dayTextColor: colors.white,
          todayTextColor: colors.emerald,
          monthTextColor: colors.white,
          arrowColor: colors.emerald,
          textDisabledColor: colors.gray700,
          selectedDayBackgroundColor: colors.emerald,
          selectedDayTextColor: colors.navy,
        }}
      />
      {dayEvents.length === 0 ? (
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
            <Text style={styles.emptyText}>No events on this day</Text>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={dayEvents}
          renderItem={renderEvent}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
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
        onPress={() => navigation.navigate('EventForm')}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  list: { padding: 16 },
  eventCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.navyLight, borderRadius: 12, padding: 16, marginBottom: 8, gap: 12 },
  eventDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.emerald },
  eventTitle: { fontSize: 16, fontWeight: '600', color: colors.white },
  eventTime: { fontSize: 13, color: colors.gray400, marginTop: 2 },
  eventRecurrence: { fontSize: 11, color: '#34d399', marginTop: 2 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: colors.gray500, fontSize: 14 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.emerald, justifyContent: 'center', alignItems: 'center', elevation: 4 },
  fabText: { fontSize: 28, color: colors.navy, fontWeight: '600', marginTop: -2 },
});

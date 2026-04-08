import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { Calendar } from 'react-native-calendars';
import { useCalendarStore } from '../../stores/calendar-store';
import { useSyncStore } from '../../stores/sync-store';
import { triggerFullSync } from '../../providers/SyncProvider';
import { useTheme } from '../../hooks/useTheme';
import type { CalendarEvent } from '@silentsuite/core';

export function CalendarScreen({ navigation }: any) {
  const { colors: theme } = useTheme();
  const { events, selectedDate, setSelectedDate } = useCalendarStore();
  const syncStatus = useSyncStore((s) => s.status);

  const dateStr = selectedDate.toISOString().split('T')[0];

  const markedDatesObj = useMemo(() => {
    const marks: Record<string, any> = {};
    for (const event of events) {
      const d = new Date(event.startDate).toISOString().split('T')[0];
      marks[d] = { ...(marks[d] || {}), marked: true, dotColor: theme.accent };
    }
    marks[dateStr] = { ...(marks[dateStr] || {}), selected: true, selectedColor: theme.accent };
    return marks;
  }, [events, dateStr, theme.accent]);

  const dayEvents = useMemo(() => {
    return events.filter((e) => {
      const d = new Date(e.startDate).toISOString().split('T')[0];
      return d === dateStr;
    });
  }, [events, dateStr]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    list: { padding: 16 },
    eventCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.surface, borderRadius: 12, padding: 16, marginBottom: 8, gap: 12 },
    eventDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.accent },
    eventTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
    eventTime: { fontSize: 13, color: theme.textSecondary, marginTop: 2 },
    eventRecurrence: { fontSize: 11, color: theme.accent, marginTop: 2 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: theme.textSecondary, fontSize: 14 },
    fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: theme.accent, justifyContent: 'center', alignItems: 'center', elevation: 4 },
    fabText: { fontSize: 28, color: theme.background, fontWeight: '600', marginTop: -2 },
  }), [theme]);

  const calendarTheme = useMemo(() => ({
    backgroundColor: theme.background,
    calendarBackground: theme.background,
    textSectionTitleColor: theme.textSecondary,
    dayTextColor: theme.text,
    todayTextColor: theme.accent,
    monthTextColor: theme.text,
    arrowColor: theme.accent,
    textDisabledColor: theme.border,
    selectedDayBackgroundColor: theme.accent,
    selectedDayTextColor: theme.background,
  }), [theme]);

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
        theme={calendarTheme}
      />
      {dayEvents.length === 0 ? (
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
              tintColor={theme.accent}
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

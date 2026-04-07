import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Switch, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useCalendarStore } from '../../stores/calendar-store';
import { createEvent as syncCreateEvent, updateEvent as syncUpdateEvent } from '../../services/sync-actions';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';
import type { CalendarEvent } from '@silentsuite/core';

export function EventFormScreen({ navigation, route }: any) {
  const { colors: theme } = useTheme();
  const { events } = useCalendarStore();
  const editId = route.params?.eventId;
  const existing = editId ? events.find((e) => e.id === editId) : null;

  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [location, setLocation] = useState(existing?.location || '');
  const [allDay, setAllDay] = useState(existing?.allDay || false);
  const [startDate, setStartDate] = useState(existing ? new Date(existing.startDate) : new Date());
  const [endDate, setEndDate] = useState(existing ? new Date(existing.endDate) : new Date(Date.now() + 3600000));
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [recurrence, setRecurrence] = useState<string | null>(existing?.recurrenceRule || null);
  const { error, showError, dismissError } = useErrorToast();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    scroll: { flex: 1 },
    scrollContent: { padding: 16 },
    titleInput: { fontSize: 22, fontWeight: '600', color: theme.text, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border, marginBottom: 16 },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
    dateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.border },
    label: { fontSize: 16, color: theme.text },
    dateText: { fontSize: 14, color: theme.accent },
    input: { backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, fontSize: 16, marginTop: 12 },
    multiline: { minHeight: 100, textAlignVertical: 'top' },
    recurrenceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    recurrenceBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: theme.surface },
    recurrenceBtnActive: { backgroundColor: theme.accent },
    recurrenceText: { fontSize: 13, color: theme.textSecondary },
    recurrenceTextActive: { color: theme.background, fontWeight: '600' },
    footer: { padding: 16, borderTopWidth: 1, borderTopColor: theme.border },
  }), [theme]);

  const handleSave = async () => {
    if (!title.trim()) return;

    try {
      const now = new Date();
      if (existing) {
        await syncUpdateEvent({...existing, title: title.trim(), description, location, allDay, startDate, endDate, recurrenceRule: recurrence, updated: now});
      } else {
        const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const event: CalendarEvent = {
          id,
          uid: id,
          title: title.trim(),
          description,
          location,
          allDay,
          startDate,
          endDate,
          recurrenceRule: recurrence,
          exceptions: [],
          alarms: [],
          created: now,
          updated: now,
        };
        await syncCreateEvent(event);
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
        <TextInput
          style={styles.titleInput}
          placeholder="Event title"
          placeholderTextColor={theme.textSecondary}
          value={title}
          onChangeText={setTitle}
          autoFocus
        />

        <View style={styles.row}>
          <Text style={styles.label}>All day</Text>
          <Switch value={allDay} onValueChange={setAllDay} trackColor={{ true: theme.accent }} />
        </View>

        <Pressable style={styles.dateRow} onPress={() => setShowStartPicker(true)}>
          <Text style={styles.label}>Start</Text>
          <Text style={styles.dateText}>
            {startDate.toLocaleDateString()} {!allDay && startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </Pressable>
        {showStartPicker && (
          <DateTimePicker
            value={startDate}
            mode={allDay ? 'date' : 'datetime'}
            onChange={(_, date) => { setShowStartPicker(Platform.OS === 'ios'); if (date) setStartDate(date); }}
          />
        )}

        <Pressable style={styles.dateRow} onPress={() => setShowEndPicker(true)}>
          <Text style={styles.label}>End</Text>
          <Text style={styles.dateText}>
            {endDate.toLocaleDateString()} {!allDay && endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </Pressable>
        {showEndPicker && (
          <DateTimePicker
            value={endDate}
            mode={allDay ? 'date' : 'datetime'}
            onChange={(_, date) => { setShowEndPicker(Platform.OS === 'ios'); if (date) setEndDate(date); }}
          />
        )}

        <Text style={styles.label}>Repeat</Text>
        <View style={styles.recurrenceRow}>
          {(['none', 'daily', 'weekly', 'monthly', 'yearly'] as const).map((freq) => (
            <Pressable
              key={freq}
              style={[styles.recurrenceBtn, (freq === 'none' ? recurrence === null : recurrence === `FREQ=${freq.toUpperCase()}`) && styles.recurrenceBtnActive]}
              onPress={() => setRecurrence(freq === 'none' ? null : `FREQ=${freq.toUpperCase()}`)}
            >
              <Text style={[styles.recurrenceText, (freq === 'none' ? recurrence === null : recurrence === `FREQ=${freq.toUpperCase()}`) && styles.recurrenceTextActive]}>
                {freq === 'none' ? 'None' : freq.charAt(0).toUpperCase() + freq.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          style={styles.input}
          placeholder="Location"
          placeholderTextColor={theme.textSecondary}
          value={location}
          onChangeText={setLocation}
        />

        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Description"
          placeholderTextColor={theme.textSecondary}
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={4}
        />
      </ScrollView>

      <View style={styles.footer}>
        <Button title={existing ? 'Update Event' : 'Create Event'} onPress={handleSave} disabled={!title.trim()} />
      </View>
    </SafeAreaView>
  );
}

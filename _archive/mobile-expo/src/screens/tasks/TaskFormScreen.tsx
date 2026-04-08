import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useTaskStore } from '../../stores/task-store';
import { createTask as syncCreateTask, updateTask as syncUpdateTask } from '../../services/sync-actions';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';
import type { Task, Priority } from '@silentsuite/core';

const priorities: Priority[] = ['low', 'medium', 'high', 'urgent'];
const priorityColors: Record<string, string> = { low: '#9ca3af', medium: '#3b82f6', high: '#f97316', urgent: '#ef4444' };

export function TaskFormScreen({ navigation, route }: any) {
  const { colors: theme } = useTheme();
  const { tasks } = useTaskStore();
  const editId = route.params?.taskId;
  const existing = editId ? tasks.find((t) => t.id === editId) : null;

  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [priority, setPriority] = useState<Priority>(existing?.priority || 'medium');
  const [dueDate, setDueDate] = useState<Date | null>(existing?.due_date ? new Date(existing.due_date) : null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const { error, showError, dismissError } = useErrorToast();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    scroll: { flex: 1 },
    scrollContent: { padding: 16 },
    titleInput: { fontSize: 22, fontWeight: '600', color: theme.text, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border, marginBottom: 16 },
    label: { fontSize: 14, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', marginBottom: 8, marginTop: 16 },
    priorityRow: { flexDirection: 'row', gap: 8 },
    priorityBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, backgroundColor: theme.surface },
    priorityText: { fontSize: 13, color: theme.textSecondary, textTransform: 'capitalize' },
    dateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.border },
    dateText: { fontSize: 14, color: theme.accent },
    clearDate: { fontSize: 13, color: theme.error, marginTop: 4 },
    input: { backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 8, fontSize: 16, marginTop: 16 },
    multiline: { minHeight: 100, textAlignVertical: 'top' },
    footer: { padding: 16, borderTopWidth: 1, borderTopColor: theme.border },
  }), [theme]);

  const handleSave = async () => {
    if (!title.trim()) return;
    try {
      const now = new Date();
      if (existing) {
        await syncUpdateTask({...existing, title: title.trim(), description, priority, due_date: dueDate, updated_at: now});
      } else {
        const id = `tsk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const task: Task = { id, uid: id, title: title.trim(), description, due_date: dueDate, priority, completed: false, created_at: now, updated_at: now };
        await syncCreateTask(task);
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
        <TextInput style={styles.titleInput} placeholder="Task title" placeholderTextColor={theme.textSecondary} value={title} onChangeText={setTitle} autoFocus />

        <Text style={styles.label}>Priority</Text>
        <View style={styles.priorityRow}>
          {priorities.map((p) => (
            <Pressable key={p} style={[styles.priorityBtn, priority === p && { backgroundColor: priorityColors[p] }]} onPress={() => setPriority(p)}>
              <Text style={[styles.priorityText, priority === p && { color: '#ffffff' }]}>{p}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.dateRow} onPress={() => setShowDatePicker(true)}>
          <Text style={styles.label}>Due date</Text>
          <Text style={styles.dateText}>{dueDate ? dueDate.toLocaleDateString() : 'None'}</Text>
        </Pressable>
        {dueDate && (
          <Pressable onPress={() => setDueDate(null)}>
            <Text style={styles.clearDate}>Clear due date</Text>
          </Pressable>
        )}
        {showDatePicker && (
          <DateTimePicker
            value={dueDate || new Date()}
            mode="date"
            onChange={(_, date) => { setShowDatePicker(Platform.OS === 'ios'); if (date) setDueDate(date); }}
          />
        )}

        <TextInput style={[styles.input, styles.multiline]} placeholder="Description" placeholderTextColor={theme.textSecondary} value={description} onChangeText={setDescription} multiline numberOfLines={4} />
      </ScrollView>
      <View style={styles.footer}>
        <Button title={existing ? 'Update Task' : 'Create Task'} onPress={handleSave} disabled={!title.trim()} />
      </View>
    </SafeAreaView>
  );
}

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTaskStore } from '../../stores/task-store';
import { deleteTask as syncDeleteTask, toggleTaskComplete as syncToggleComplete } from '../../services/sync-actions';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useErrorToast } from '../../hooks/useErrorToast';

const priorityColors: Record<string, string> = { low: '#9ca3af', medium: '#3b82f6', high: '#f97316', urgent: '#ef4444' };

export function TaskDetailScreen({ navigation, route }: any) {
  const { colors: theme } = useTheme();
  const { tasks } = useTaskStore();
  const task = tasks.find((t) => t.id === route.params.taskId);
  const { error, showError, dismissError } = useErrorToast();

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    scroll: { flex: 1, padding: 16 },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 },
    title: { fontSize: 22, fontWeight: '700', color: theme.text, flex: 1, marginRight: 12 },
    titleDone: { textDecorationLine: 'line-through', color: theme.textSecondary },
    priorityBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
    priorityText: { fontSize: 12, fontWeight: '600', color: '#ffffff', textTransform: 'capitalize' },
    statusRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
    statusLabel: { fontSize: 14, color: theme.textSecondary },
    statusValue: { fontSize: 14, fontWeight: '600' },
    fieldRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
    fieldLabel: { fontSize: 12, fontWeight: '600', color: theme.textSecondary, textTransform: 'uppercase', marginBottom: 4 },
    fieldValue: { fontSize: 16, color: theme.text, lineHeight: 22 },
    notFound: { color: theme.textSecondary, textAlign: 'center', marginTop: 40 },
    footer: { padding: 16, borderTopWidth: 1, borderTopColor: theme.border },
  }), [theme]);

  if (!task) return <View style={styles.container}><Text style={styles.notFound}>Task not found</Text></View>;

  const handleDelete = () => {
    Alert.alert('Delete Task', `Delete "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await syncDeleteTask(task.id);
          navigation.goBack();
        } catch (e: any) {
          showError(e.message || 'Operation failed');
        }
      } },
    ]);
  };

  const handleToggleComplete = async () => {
    try {
      await syncToggleComplete(task);
    } catch (e: any) {
      showError(e.message || 'Operation failed');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {error && <ErrorBanner message={error} onDismiss={dismissError} />}
      <ScrollView style={styles.scroll}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, task.completed && styles.titleDone]}>{task.title}</Text>
          <View style={[styles.priorityBadge, { backgroundColor: priorityColors[task.priority] || theme.textSecondary }]}>
            <Text style={styles.priorityText}>{task.priority}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Status</Text>
          <Text style={[styles.statusValue, { color: task.completed ? theme.accent : theme.textSecondary }]}>
            {task.completed ? 'Completed' : 'Pending'}
          </Text>
        </View>

        {task.due_date && (
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Due date</Text>
            <Text style={styles.fieldValue}>{new Date(task.due_date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
          </View>
        )}

        {task.description ? (
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Description</Text>
            <Text style={styles.fieldValue}>{task.description}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button title={task.completed ? 'Mark Incomplete' : 'Mark Complete'} onPress={handleToggleComplete} />
        <View style={{ height: 8 }} />
        <Button title="Edit" variant="secondary" onPress={() => navigation.navigate('TaskForm', { taskId: task.id })} />
        <View style={{ height: 8 }} />
        <Button title="Delete" variant="secondary" onPress={handleDelete} />
      </View>
    </SafeAreaView>
  );
}

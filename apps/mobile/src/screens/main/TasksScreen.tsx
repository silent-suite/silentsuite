import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, ScrollView, RefreshControl, StyleSheet, Pressable, Switch } from 'react-native';
import { useTaskStore } from '../../stores/task-store';
import { useSyncStore } from '../../stores/sync-store';
import { triggerFullSync } from '../../providers/SyncProvider';
import { toggleTaskComplete as syncToggleComplete } from '../../services/sync-actions';
import { colors } from '../../theme';
import type { Task } from '@silentsuite/core';

type SortBy = 'due_date' | 'priority' | 'title';

const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityColors = { urgent: '#ef4444', high: '#f97316', medium: '#3b82f6', low: '#9ca3af' };

export function TasksScreen({ navigation }: any) {
  const { tasks } = useTaskStore();
  const syncStatus = useSyncStore((s) => s.status);
  const [showCompleted, setShowCompleted] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('due_date');

  const sortedTasks = useMemo(() => {
    let filtered = showCompleted ? tasks : tasks.filter(t => !t.completed);
    return [...filtered].sort((a, b) => {
      if (sortBy === 'priority') return (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
      if (sortBy === 'due_date') {
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      }
      return a.title.localeCompare(b.title);
    });
  }, [tasks, showCompleted, sortBy]);

  const renderTask = ({ item }: { item: Task }) => (
    <Pressable
      style={styles.taskRow}
      onPress={() => navigation.navigate('TaskDetail', { taskId: item.id })}
    >
      <Pressable onPress={() => syncToggleComplete(item)} hitSlop={8}>
        <View style={[styles.checkbox, item.completed && styles.checkboxChecked]}>
          {item.completed && <Text style={styles.checkmark}>✓</Text>}
        </View>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={[styles.taskTitle, item.completed && styles.taskTitleDone]}>{item.title}</Text>
        {item.due_date && (
          <Text style={styles.taskDue}>{new Date(item.due_date).toLocaleDateString()}</Text>
        )}
      </View>
      <View style={[styles.priorityDot, { backgroundColor: priorityColors[item.priority] || colors.gray500 }]} />
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.sortRow}>
          {(['due_date', 'priority', 'title'] as SortBy[]).map((s) => (
            <Pressable key={s} style={[styles.sortBtn, sortBy === s && styles.sortBtnActive]} onPress={() => setSortBy(s)}>
              <Text style={[styles.sortBtnText, sortBy === s && styles.sortBtnTextActive]}>
                {s === 'due_date' ? 'Date' : s === 'priority' ? 'Priority' : 'Name'}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.filterRow}>
          <Text style={styles.filterLabel}>Show completed</Text>
          <Switch value={showCompleted} onValueChange={setShowCompleted} trackColor={{ true: colors.emerald }} />
        </View>
      </View>

      {sortedTasks.length === 0 ? (
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
            <Text style={styles.emptyTitle}>No tasks yet</Text>
            <Text style={styles.emptySubtitle}>Tap + to add your first task</Text>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={sortedTasks}
          renderItem={renderTask}
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

      <Pressable style={styles.fab} onPress={() => navigation.navigate('TaskForm')}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  toolbar: { paddingHorizontal: 12, paddingTop: 8 },
  sortRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  sortBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.navyLight },
  sortBtnActive: { backgroundColor: colors.emerald },
  sortBtnText: { fontSize: 13, color: colors.gray400 },
  sortBtnTextActive: { color: colors.navy, fontWeight: '600' },
  filterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  filterLabel: { fontSize: 14, color: colors.gray400 },
  list: { padding: 12 },
  taskRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.navyLight, borderRadius: 12, padding: 16, marginBottom: 8, gap: 12 },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.gray500, justifyContent: 'center', alignItems: 'center' },
  checkboxChecked: { backgroundColor: colors.emerald, borderColor: colors.emerald },
  checkmark: { color: colors.navy, fontSize: 14, fontWeight: '700' },
  taskTitle: { fontSize: 16, fontWeight: '500', color: colors.white },
  taskTitleDone: { textDecorationLine: 'line-through', color: colors.gray500 },
  taskDue: { fontSize: 13, color: colors.gray400, marginTop: 2 },
  priorityDot: { width: 8, height: 8, borderRadius: 4 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.white, marginBottom: 4 },
  emptySubtitle: { fontSize: 14, color: colors.gray500 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.emerald, justifyContent: 'center', alignItems: 'center', elevation: 4 },
  fabText: { fontSize: 28, color: colors.navy, fontWeight: '600', marginTop: -2 },
});

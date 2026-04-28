import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { CalendarScreen } from '../screens/main/CalendarScreen';
import { EventDetailScreen } from '../screens/calendar/EventDetailScreen';
import { EventFormScreen } from '../screens/calendar/EventFormScreen';
import { ContactsScreen } from '../screens/main/ContactsScreen';
import { ContactDetailScreen } from '../screens/contacts/ContactDetailScreen';
import { ContactFormScreen } from '../screens/contacts/ContactFormScreen';
import { TasksScreen } from '../screens/main/TasksScreen';
import { TaskDetailScreen } from '../screens/tasks/TaskDetailScreen';
import { TaskFormScreen } from '../screens/tasks/TaskFormScreen';
import { SettingsScreen } from '../screens/main/SettingsScreen';
import { ChangePasswordScreen } from '../screens/settings/ChangePasswordScreen';
import { useTheme } from '../hooks/useTheme';

const Tab = createBottomTabNavigator();
const CalStack = createNativeStackNavigator();
const ConStack = createNativeStackNavigator();
const TskStack = createNativeStackNavigator();
const SetStack = createNativeStackNavigator();

function CalendarStack() {
  const { colors: theme } = useTheme();
  const screenOpts = {
    headerStyle: { backgroundColor: theme.background },
    headerTintColor: theme.text,
  };
  return (
    <CalStack.Navigator screenOptions={screenOpts}>
      <CalStack.Screen name="CalendarHome" component={CalendarScreen} options={{ title: 'Calendar' }} />
      <CalStack.Screen name="EventDetail" component={EventDetailScreen} options={{ title: 'Event' }} />
      <CalStack.Screen name="EventForm" component={EventFormScreen} options={{ title: 'Event' }} />
    </CalStack.Navigator>
  );
}

function ContactsStack() {
  const { colors: theme } = useTheme();
  const screenOpts = {
    headerStyle: { backgroundColor: theme.background },
    headerTintColor: theme.text,
  };
  return (
    <ConStack.Navigator screenOptions={screenOpts}>
      <ConStack.Screen name="ContactsHome" component={ContactsScreen} options={{ title: 'Contacts' }} />
      <ConStack.Screen name="ContactDetail" component={ContactDetailScreen} options={{ title: 'Contact' }} />
      <ConStack.Screen name="ContactForm" component={ContactFormScreen} options={{ title: 'Contact' }} />
    </ConStack.Navigator>
  );
}

function TasksStack() {
  const { colors: theme } = useTheme();
  const screenOpts = {
    headerStyle: { backgroundColor: theme.background },
    headerTintColor: theme.text,
  };
  return (
    <TskStack.Navigator screenOptions={screenOpts}>
      <TskStack.Screen name="TasksHome" component={TasksScreen} options={{ title: 'Tasks' }} />
      <TskStack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task' }} />
      <TskStack.Screen name="TaskForm" component={TaskFormScreen} options={{ title: 'Task' }} />
    </TskStack.Navigator>
  );
}

function SettingsStack() {
  const { colors: theme } = useTheme();
  const screenOpts = {
    headerStyle: { backgroundColor: theme.background },
    headerTintColor: theme.text,
  };
  return (
    <SetStack.Navigator screenOptions={screenOpts}>
      <SetStack.Screen name="SettingsHome" component={SettingsScreen} options={{ title: 'Settings' }} />
      <SetStack.Screen name="ChangePassword" component={ChangePasswordScreen} options={{ title: 'Change Password' }} />
    </SetStack.Navigator>
  );
}

export function MainTabs() {
  const { colors: theme } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.background, borderTopColor: theme.surface },
      }}
    >
      <Tab.Screen name="Calendar" component={CalendarStack} options={{ tabBarLabel: 'Calendar' }} />
      <Tab.Screen name="Contacts" component={ContactsStack} options={{ tabBarLabel: 'Contacts' }} />
      <Tab.Screen name="Tasks" component={TasksStack} options={{ tabBarLabel: 'Tasks' }} />
      <Tab.Screen
        name="Settings"
        component={SettingsStack}
        options={{ tabBarLabel: 'Settings', headerShown: false }}
      />
    </Tab.Navigator>
  );
}

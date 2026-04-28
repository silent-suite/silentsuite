export type AuthStackParamList = {
  Welcome: undefined;
  Login: undefined;
};

export type MainTabParamList = {
  Calendar: undefined;
  Contacts: undefined;
  Tasks: undefined;
  Settings: undefined;
};

export type CalendarStackParamList = {
  CalendarHome: undefined;
  EventDetail: { eventId: string };
  EventForm: { eventId?: string } | undefined;
};

export type ContactsStackParamList = {
  ContactsHome: undefined;
  ContactDetail: { contactId: string };
  ContactForm: { contactId?: string } | undefined;
};

export type TasksStackParamList = {
  TasksHome: undefined;
  TaskDetail: { taskId: string };
  TaskForm: { taskId?: string } | undefined;
};

export type SettingsStackParamList = {
  SettingsHome: undefined;
  ChangePassword: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};

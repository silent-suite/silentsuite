# How to Manage Your Tasks

Your tasks are end-to-end encrypted. Only your devices can read them.

In the web app your tasks are at [app.silentsuite.io/tasks](https://app.silentsuite.io/tasks). Title, due date, priority and notes are all encrypted on your device before sync.

## Task Lists

Tasks are organized into task lists (also called collections). You can create multiple lists to separate work, personal, and other categories. Each list syncs independently across your devices.

## Create a Task

1. Open the Tasks view.
2. Tap or click "Add Task."
3. Enter the task details: title, due date, priority (low, medium, high or urgent), and notes.
4. Save. The task is encrypted on your device and synced.

## Complete a Task

1. Tap or click the checkbox next to the task.
2. The completion status syncs across all your devices.

Click the checkbox again to reopen the task.

## Edit a Task

1. Open the task you want to change.
2. Make your changes.
3. Save. The updated task is re-encrypted and synced.

## Delete a Task

1. Open the task.
2. Select delete.
3. The deletion syncs across all your devices.

## Import

**Settings → Import** accepts `.ics` files with `VTODO` entries and `.csv` files. The file is parsed in your browser, so its contents never reach the server unencrypted.

If you imported into the wrong place, use **Settings → Import → Manage imported data** to clear a task list's tasks or delete an extra task list and everything inside it.

## Export

**Settings → Export** offers:

- **Tasks (`.ics`)**: all tasks as a single iCalendar file with `VTODO` entries
- **Everything (`.zip`)**: calendars, contacts and tasks together, plus your notebooks as Markdown files when you have any ([Notes](./notes.md#export))

## Standards

Tasks use the VTODO standard (part of the iCalendar specification). SilentSuite supports [Tasks.org](./apps/tasks-org.md) on Android and documented desktop task clients via the [SilentSuite Bridge](./apps/dav-bridge.md), which serves each task list as its own task collection on `localhost:37358`.

## Limits

- Start and due dates are shown and edited as calendar days. Times and time zones (`TZID`) set in other apps or imported from `.ics` files are kept when you rename, complete or otherwise edit a task, but picking a new date in SilentSuite saves it as a date without a time.
- There are no subtasks or dependencies: each task list is flat.

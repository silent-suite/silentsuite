import { describe, expect, it } from 'vitest';
import { deserializeCalendarEvent, serializeCalendarEvent, parseAlarmTriggerMinutes, buildAlarmTrigger } from './calendar-event.js';

describe('event reminders survive unrelated edits', () => {
  it.each([
    ['ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT15M', 'DESCRIPTION:End reminder'],
    ['ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20261117T090000Z'],
    ['ACTION:AUDIO', 'TRIGGER:-PT1H30M', 'REPEAT:2', 'DURATION:PT1M', 'ATTACH;FMTTYPE=audio/basic:https://example.test/sound', 'X-ALARM-ID:one'],
    ['ACTION:EMAIL', 'TRIGGER:-P1DT2H', 'ATTENDEE:mailto:test@example.test', 'SUMMARY:Reminder', 'DESCRIPTION:Details'],
  ])('keeps the full source alarm %j', (...properties) => {
    const alarm = ['BEGIN:VALARM', ...properties, 'END:VALARM'].join('\r\n');
    const event = deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:alarm', 'DTSTART:20261117T150000Z', 'DTEND:20261117T160000Z', alarm, 'END:VEVENT'].join('\r\n'));
    expect(serializeCalendarEvent({ ...event, title: 'Changed title' })).toContain(alarm);
  });

  it.each([
    ['-PT1H30M', 90], ['-P1DT2H', 1560], ['-P2W', 20160], ['-PT900S', 15], ['PT0S', 0], ['+PT15M', -15], ['PT15M', -15], ['-PT30S', 0.5],
  ])('reads the complete duration %s', (trigger, minutes) => {
    expect(parseAlarmTriggerMinutes(trigger)).toBe(minutes);
  });

  it.each(['P', 'PT', '-PT1Hjunk', 'P1W2D', 'PT1M2H', '20261117T090000Z'])('distinguishes invalid %s from zero', (trigger) => {
    expect(parseAlarmTriggerMinutes(trigger)).toBeNull();
  });

  it('writes a reminder at start', () => expect(buildAlarmTrigger(0)).toBe('PT0S'));
});

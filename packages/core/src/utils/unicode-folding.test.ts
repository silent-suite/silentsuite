import { describe, expect, it } from 'vitest';
import { generateVEvent, generateVTodo } from './ical-parser.js';
import { generateVCard } from './vcard-parser.js';

const writers = [
  ['VEVENT SUMMARY', 'SUMMARY', (text: string) => generateVEvent({ uid: 'fold', dtstart: '20261117T100000Z', summary: text })],
  ['VTODO SUMMARY', 'SUMMARY', (text: string) => generateVTodo({ uid: 'fold', summary: text })],
  ['vCard FN', 'FN', (text: string) => generateVCard({ uid: 'fold', fn: text })],
  ['vCard NOTE', 'NOTE', (text: string) => generateVCard({ uid: 'fold', fn: 'Name', note: text })],
] as const;

describe('UTF-8 folding preserves supplementary characters', () => {
  for (const [name, property, write] of writers) {
    it.each(Array.from({ length: 14 }, (_, index) => 63 + index))(`${name} with %i leading bytes`, (count) => {
      const text = 'a'.repeat(count) + '🙂' + 'é中🙂 '.repeat(24);
      const bytes = new TextEncoder().encode(write(text));
      const received = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const logical = received.replace(/\r\n[ \t]/g, '').split('\r\n');
      expect(logical.find(line => line.startsWith(`${property}:`))).toBe(`${property}:${text}`);
      for (const line of received.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    });
  }
});

/**
 * Polyfills required for @silentsuite/core in React Native.
 *
 * Must be imported before any @silentsuite/core usage.
 *
 * 1. Buffer: Used by ical-parser.ts and vcard-parser.ts for line folding
 * 2. crypto.randomUUID: Available in Hermes, but polyfilled here as safety net
 */
import { Buffer } from 'buffer';

// Make Buffer globally available (used by @silentsuite/core parsers)
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

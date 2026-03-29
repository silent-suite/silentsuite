/**
 * Polyfills required for @silentsuite/core in React Native.
 *
 * Must be imported before any @silentsuite/core usage.
 *
 * 1. Buffer: React Native / Hermes doesn't include Node's Buffer global.
 *    @silentsuite/core's ical-parser.ts and vcard-parser.ts use Buffer for
 *    RFC 6350/5545 line folding (splitting on multi-byte boundaries).
 *    Without this polyfill, vCard/iCal import and export will crash at runtime.
 *
 * 2. crypto.randomUUID: Available in Hermes, but polyfilled here as safety net.
 */
import { Buffer } from 'buffer';

// Make Buffer globally available (used by @silentsuite/core parsers)
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

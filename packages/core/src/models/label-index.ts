export type LabelIndexSource = 'calendar' | 'tasks' | 'contacts';

export interface SyncedLabelEntryV1 {
  label: string;
  count: number;
  lastUsedAt: string;
  sources?: Partial<Record<LabelIndexSource, number>>;
}

export interface SyncedLabelIndexV1 {
  version: 1;
  updatedAt: string;
  labels: Record<string, SyncedLabelEntryV1>;
}

const VALID_SOURCES: LabelIndexSource[] = ['calendar', 'tasks', 'contacts'];
const DEFAULT_DATE = '1970-01-01T00:00:00.000Z';

export function normalizeLabelKey(label: string): string {
  return label.trim().toLocaleLowerCase();
}

function normalizeDisplayLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DATE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? DEFAULT_DATE : date.toISOString();
}

function newerIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function normalizeSources(value: unknown): Partial<Record<LabelIndexSource, number>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Partial<Record<LabelIndexSource, number>> = {};
  for (const source of VALID_SOURCES) {
    const count = normalizeCount((value as Record<string, unknown>)[source]);
    if (count > 0) result[source] = count;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeEntry(a: SyncedLabelEntryV1, b: SyncedLabelEntryV1): SyncedLabelEntryV1 {
  const sources: Partial<Record<LabelIndexSource, number>> = {};
  for (const source of VALID_SOURCES) {
    const count = Math.max(a.sources?.[source] ?? 0, b.sources?.[source] ?? 0);
    if (count > 0) sources[source] = count;
  }
  const lastUsedAt = newerIso(a.lastUsedAt, b.lastUsedAt);
  return {
    label: a.lastUsedAt === lastUsedAt ? a.label : b.label,
    count: Math.max(a.count, b.count),
    lastUsedAt,
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
  };
}

export function createEmptyLabelIndex(now: Date = new Date(0)): SyncedLabelIndexV1 {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    labels: {},
  };
}

export function normalizeLabelIndex(input: unknown): SyncedLabelIndexV1 {
  if (!input || typeof input !== 'object') return createEmptyLabelIndex();
  const raw = input as Record<string, unknown>;
  const labels: Record<string, SyncedLabelEntryV1> = {};
  const rawLabels = raw.labels && typeof raw.labels === 'object'
    ? (raw.labels as Record<string, unknown>)
    : {};

  for (const [rawKey, rawEntry] of Object.entries(rawLabels)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const hasLabelField = Object.prototype.hasOwnProperty.call(entry, 'label');
    const label = hasLabelField ? normalizeDisplayLabel(entry.label) : normalizeDisplayLabel(rawKey);
    if (!label) continue;
    const key = normalizeLabelKey(label);
    if (!key) continue;
    const normalized: SyncedLabelEntryV1 = {
      label,
      count: normalizeCount(entry.count),
      lastUsedAt: normalizeDate(entry.lastUsedAt),
      ...(normalizeSources(entry.sources) ? { sources: normalizeSources(entry.sources) } : {}),
    };
    labels[key] = labels[key] ? mergeEntry(labels[key], normalized) : normalized;
  }

  return {
    version: 1,
    updatedAt: normalizeDate(raw.updatedAt),
    labels,
  };
}

export function recordLabelsUsed(
  index: SyncedLabelIndexV1,
  source: LabelIndexSource,
  rawLabels: string[],
  now: Date = new Date(),
): SyncedLabelIndexV1 {
  const normalized = normalizeLabelIndex(index);
  const timestamp = now.toISOString();
  const labels = { ...normalized.labels };
  const seen = new Set<string>();

  for (const raw of rawLabels) {
    const label = normalizeDisplayLabel(raw);
    if (!label) continue;
    const key = normalizeLabelKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const existing = labels[key];
    const sources = { ...(existing?.sources ?? {}) };
    sources[source] = (sources[source] ?? 0) + 1;
    labels[key] = {
      label: existing?.label ?? label,
      count: (existing?.count ?? 0) + 1,
      lastUsedAt: timestamp,
      sources,
    };
  }

  return {
    version: 1,
    updatedAt: timestamp,
    labels,
  };
}

export function mergeLabelIndexes(...indexes: unknown[]): SyncedLabelIndexV1 {
  let merged = createEmptyLabelIndex();
  for (const input of indexes) {
    const index = normalizeLabelIndex(input);
    const labels = { ...merged.labels };
    for (const [key, entry] of Object.entries(index.labels)) {
      labels[key] = labels[key] ? mergeEntry(labels[key], entry) : entry;
    }
    merged = {
      version: 1,
      updatedAt: newerIso(merged.updatedAt, index.updatedAt),
      labels,
    };
  }
  return merged;
}

export function serializeLabelIndex(index: SyncedLabelIndexV1): string {
  return JSON.stringify(normalizeLabelIndex(index));
}

export function deserializeLabelIndex(content: string): SyncedLabelIndexV1 | null {
  try {
    return normalizeLabelIndex(JSON.parse(content));
  } catch {
    return null;
  }
}

export function suggestLabels(
  index: SyncedLabelIndexV1,
  query = '',
  existingLabels: string[] = [],
  limit = 8,
): string[] {
  const normalized = normalizeLabelIndex(index);
  const needle = normalizeLabelKey(query);
  const existing = new Set(existingLabels.map(normalizeLabelKey));
  return Object.entries(normalized.labels)
    .filter(([key, entry]) => !existing.has(key) && (!needle || key.includes(needle) || entry.label.toLocaleLowerCase().includes(needle)))
    .sort(([, a], [, b]) => {
      if (b.count !== a.count) return b.count - a.count;
      const timeDelta = new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return a.label.localeCompare(b.label);
    })
    .slice(0, Math.max(0, limit))
    .map(([, entry]) => entry.label);
}

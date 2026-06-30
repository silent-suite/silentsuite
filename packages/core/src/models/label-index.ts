export const LABEL_INDEX_KIND = 'silentsuite.labelindex.v1';

export interface LabelIndexEntry {
  label: string;
  count: number;
  lastUsedAt: number;
}

export interface LabelIndexV1 {
  kind: typeof LABEL_INDEX_KIND;
  schemaVersion: 1;
  updatedAt: number;
  labels: Record<string, LabelIndexEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

export function normalizeLabelKey(label: string): string {
  return normalizeLabel(label).toLocaleLowerCase();
}

export function createLabelIndex(entries: LabelIndexEntry[] = [], now = Date.now()): LabelIndexV1 {
  const index: LabelIndexV1 = {
    kind: LABEL_INDEX_KIND,
    schemaVersion: 1,
    updatedAt: 0,
    labels: {},
  };
  for (const entry of entries) {
    const label = normalizeLabel(entry.label);
    if (!label) continue;
    const key = normalizeLabelKey(label);
    const lastUsedAt = timestamp(entry.lastUsedAt, now);
    const existing = index.labels[key];
    index.labels[key] = {
      label: existing?.lastUsedAt && existing.lastUsedAt > lastUsedAt ? existing.label : label,
      count: Math.max(existing?.count ?? 0, count(entry.count)),
      lastUsedAt: Math.max(existing?.lastUsedAt ?? 0, lastUsedAt),
    };
  }
  index.updatedAt = Math.max(now, ...Object.values(index.labels).map((entry) => entry.lastUsedAt), 0);
  return index;
}

export function normalizeLabelIndex(input: unknown): LabelIndexV1 {
  const root = isRecord(input) ? input : {};
  if ('kind' in root && root.kind !== LABEL_INDEX_KIND) {
    throw new Error('Invalid label index kind');
  }
  const labels = isRecord(root.labels) ? root.labels : {};
  const entries: LabelIndexEntry[] = [];
  for (const value of Object.values(labels)) {
    if (!isRecord(value) || typeof value.label !== 'string') continue;
    const label = normalizeLabel(value.label);
    if (!label) continue;
    entries.push({
      label,
      count: count(value.count, 0),
      lastUsedAt: timestamp(value.lastUsedAt, timestamp(root.updatedAt, 0)),
    });
  }
  const normalized = createLabelIndex(entries, timestamp(root.updatedAt, 0));
  normalized.updatedAt = Math.max(timestamp(root.updatedAt, 0), ...Object.values(normalized.labels).map((entry) => entry.lastUsedAt), 0);
  return normalized;
}

export function mergeLabelIndexes(indexes: LabelIndexV1[]): LabelIndexV1 {
  const merged = createLabelIndex([], 0);
  for (const index of indexes) {
    const normalized = normalizeLabelIndex(index);
    for (const [key, incoming] of Object.entries(normalized.labels)) {
      const existing = merged.labels[key];
      const shouldUseIncomingLabel = !existing
        || incoming.count > existing.count
        || (incoming.count === existing.count && incoming.lastUsedAt >= existing.lastUsedAt);
      merged.labels[key] = {
        label: shouldUseIncomingLabel ? incoming.label : existing.label,
        // Counts are approximate ranking signals. Use max rather than summing so
        // repeated cold-start merges are idempotent.
        count: Math.max(existing?.count ?? 0, incoming.count),
        lastUsedAt: Math.max(existing?.lastUsedAt ?? 0, incoming.lastUsedAt),
      };
    }
    merged.updatedAt = Math.max(merged.updatedAt, normalized.updatedAt);
  }
  merged.updatedAt = Math.max(merged.updatedAt, ...Object.values(merged.labels).map((entry) => entry.lastUsedAt), 0);
  return merged;
}

export function recordLabelsUsed(index: LabelIndexV1, labels: string[], now = Date.now()): LabelIndexV1 {
  const next = mergeLabelIndexes([index]);
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (!label) continue;
    const key = normalizeLabelKey(label);
    const existing = next.labels[key];
    next.labels[key] = {
      label,
      count: (existing?.count ?? 0) + 1,
      lastUsedAt: Math.max(existing?.lastUsedAt ?? 0, now),
    };
  }
  next.updatedAt = Math.max(next.updatedAt, now);
  return next;
}

export function getLabelSuggestions(index: LabelIndexV1, query = '', limit = 8, excluded: string[] = []): string[] {
  const normalized = normalizeLabelIndex(index);
  const q = normalizeLabelKey(query);
  const excludedKeys = new Set(excluded.map(normalizeLabelKey));
  return Object.entries(normalized.labels)
    .filter(([key]) => !excludedKeys.has(key) && (!q || key.includes(q)))
    .sort(([, a], [, b]) => (b.count - a.count) || (b.lastUsedAt - a.lastUsedAt) || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(([, entry]) => entry.label);
}

export function serializeLabelIndex(index: LabelIndexV1): string {
  return JSON.stringify(normalizeLabelIndex(index));
}

export function deserializeLabelIndex(content: string): LabelIndexV1 {
  return normalizeLabelIndex(JSON.parse(content) as unknown);
}

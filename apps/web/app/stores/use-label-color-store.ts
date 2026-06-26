import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const LABEL_COLOR_PALETTE = [
  '#10b981', // emerald
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

export type LabelColorMap = Record<string, string>

interface LabelColorState {
  colors: LabelColorMap
  setLabelColor: (label: string, color: string) => void
  removeLabelColor: (label: string) => void
}

function labelKey(label: string): string {
  return label.trim().toLowerCase()
}

export function normalizeLabelColor(color: string): string | null {
  const trimmed = color.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null
}

export function defaultLabelColor(label: string): string {
  const key = labelKey(label)
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0
  }
  return LABEL_COLOR_PALETTE[Math.abs(hash) % LABEL_COLOR_PALETTE.length]!
}

export function getLabelColor(label: string, colors: LabelColorMap = {}): string {
  const key = labelKey(label)
  const stored = key ? normalizeLabelColor(colors[key] ?? '') : null
  return stored ?? defaultLabelColor(label)
}

export function labelTextColor(color: string): '#0f172a' | '#ffffff' {
  const normalized = normalizeLabelColor(color) ?? LABEL_COLOR_PALETTE[0]!
  const red = Number.parseInt(normalized.slice(1, 3), 16)
  const green = Number.parseInt(normalized.slice(3, 5), 16)
  const blue = Number.parseInt(normalized.slice(5, 7), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return luminance > 0.62 ? '#0f172a' : '#ffffff'
}

export const useLabelColorStore = create<LabelColorState>()(
  persist(
    (set) => ({
      colors: {},
      setLabelColor: (label, color) => {
        const key = labelKey(label)
        const normalized = normalizeLabelColor(color)
        if (!key || !normalized) return
        set((state) => ({
          colors: {
            ...state.colors,
            [key]: normalized,
          },
        }))
      },
      removeLabelColor: (label) => {
        const key = labelKey(label)
        if (!key) return
        set((state) => {
          const { [key]: _removed, ...colors } = state.colors
          return { colors }
        })
      },
    }),
    {
      name: 'silentsuite-label-colors',
    },
  ),
)
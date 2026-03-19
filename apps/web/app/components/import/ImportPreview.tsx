'use client'

import { CheckCircle2, Loader2 } from 'lucide-react'

interface PreviewItem {
  title: string
  subtitle?: string
}

interface ImportPreviewProps {
  items: PreviewItem[]
  type: 'events' | 'tasks' | 'contacts'
  onImport: () => void
  onCancel: () => void
  isImporting: boolean
  importedCount: number | null
}

export default function ImportPreview({
  items,
  type,
  onImport,
  onCancel,
  isImporting,
  importedCount,
}: ImportPreviewProps) {
  if (importedCount !== null) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg bg-[rgb(var(--primary))]/10 p-6">
        <CheckCircle2 className="h-10 w-10 text-[rgb(var(--primary))]" />
        <p className="text-sm font-medium text-[rgb(var(--primary))]">
          {importedCount} {type} imported
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-[rgb(var(--foreground))]">
        {items.length} {type} found
      </p>

      <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg bg-[rgb(var(--surface))]/50 p-2">
        {items.slice(0, 10).map((item, i) => (
          <div
            key={i}
            className="rounded-md px-3 py-2 text-sm hover:bg-[rgb(var(--surface))]"
          >
            <p className="text-[rgb(var(--foreground))]">{item.title}</p>
            {item.subtitle && (
              <p className="text-xs text-[rgb(var(--muted))]">{item.subtitle}</p>
            )}
          </div>
        ))}
        {items.length > 10 && (
          <p className="px-3 py-2 text-xs text-[rgb(var(--muted))]">
            …and {items.length - 10} more
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onImport}
          disabled={isImporting}
          className="inline-flex items-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--primary-hover))] disabled:opacity-50"
        >
          {isImporting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isImporting ? 'Importing…' : `Import ${items.length} ${type}`}
        </button>
        <button
          onClick={onCancel}
          disabled={isImporting}
          className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

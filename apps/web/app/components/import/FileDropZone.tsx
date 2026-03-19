'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, File as FileIcon } from 'lucide-react'

interface FileDropZoneProps {
  accept: string
  onFiles: (files: File[]) => void
  multiple?: boolean
}

export default function FileDropZone({ accept, onFiles, multiple = true }: FileDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      const arr = Array.from(files)
      setSelectedFiles(arr)
      onFiles(arr)
    },
    [onFiles],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const acceptExtensions = accept
    .split(',')
    .map((a) => a.trim())
    .join(', ')

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex w-full cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${
          isDragOver
            ? 'border-[rgb(var(--primary))] bg-[rgb(var(--primary))]/10'
            : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))]/50 hover:border-[rgb(var(--muted))]/50 hover:bg-[rgb(var(--surface))]'
        }`}
      >
        <Upload
          className={`h-8 w-8 ${isDragOver ? 'text-[rgb(var(--primary))]' : 'text-[rgb(var(--muted))]'}`}
        />
        <div className="text-center">
          <p className="text-sm font-medium text-[rgb(var(--foreground))]">
            Drop files here or click to browse
          </p>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">
            Accepted: {acceptExtensions}
          </p>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      {selectedFiles.length > 0 && (
        <div className="space-y-1">
          {selectedFiles.map((file, i) => (
            <div
              key={`${file.name}-${i}`}
              className="flex items-center gap-2 rounded-md bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))]"
            >
              <FileIcon className="h-4 w-4 shrink-0 text-[rgb(var(--primary))]" />
              <span className="truncate">{file.name}</span>
              <span className="ml-auto shrink-0 text-xs text-[rgb(var(--muted))]">
                {(file.size / 1024).toFixed(1)} KB
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

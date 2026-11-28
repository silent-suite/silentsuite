import type { Metadata } from 'next'
import { SettingsShell } from './settings-shell'

// Server layout so /settings gets its own document title before the client header runs.
export const metadata: Metadata = {
  title: 'Settings | SilentSuite',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>
}

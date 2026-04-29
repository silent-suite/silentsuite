import { Shield, CalendarDays, CheckSquare, Users, Settings, Plus, Search, Phone, Mail, MapPin, Briefcase } from 'lucide-react'
import { BottomNav } from './MockCalendar'

const NAV = [
  { icon: CalendarDays, label: 'Calendar' },
  { icon: CheckSquare, label: 'Tasks' },
  { icon: Users, label: 'Contacts', active: true },
  { icon: Settings, label: 'Settings' },
]

interface Contact {
  initials: string
  name: string
  subtitle: string
  email: string
  hue: string
}

const CONTACTS: Contact[] = [
  { initials: 'AR', name: 'Alex Rodriguez',  subtitle: 'Engineer · Acme',         email: 'alex@acme.io',          hue: '#34d399' },
  { initials: 'EW', name: 'Emma Wilson',     subtitle: 'Designer',                email: 'emma@studio.dev',       hue: '#a78bfa' },
  { initials: 'LW', name: 'Liu Wei',         subtitle: 'Founder · Stack Studio',  email: 'wei@stackstudio.com',   hue: '#60a5fa' },
  { initials: 'MS', name: 'Maria Schmidt',   subtitle: 'Lead Engineer · Acme',    email: 'maria.s@acme.io',       hue: '#f472b6' },
  { initials: 'SC', name: 'Sarah Chen',      subtitle: 'Product Lead · Mistral',  email: 'sarah.chen@mistral.ai', hue: '#34d399' },
  { initials: 'TA', name: 'Tom Anderson',    subtitle: 'Architect · Stripe',      email: 't.anderson@stripe.com', hue: '#f59e0b' },
]

const SELECTED_INDEX = 3 // Maria

export function MockContactsDesktop() {
  const selected = CONTACTS[SELECTED_INDEX]
  return (
    <div className="flex h-[520px] text-navy-200 font-sans select-none">
      {/* Sidebar */}
      <aside className="w-44 border-r border-white/5 bg-navy-900/60 flex flex-col">
        <div className="px-4 h-12 flex items-center gap-2 border-b border-white/5">
          <div className="w-6 h-6 rounded bg-teal-400/15 border border-teal-400/30 flex items-center justify-center flex-shrink-0">
            <Shield className="w-3.5 h-3.5 text-teal-400" />
          </div>
          <span className="text-white text-sm font-semibold">SilentSuite</span>
        </div>

        <div className="px-3 py-3 border-b border-white/5">
          <div className="text-[10px] uppercase tracking-wide text-navy-500 mb-2">Address books</div>
          <ul className="space-y-1.5 text-xs text-navy-200">
            <li className="flex items-center justify-between"><span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-sm bg-teal-400" /> Personal</span><span className="text-navy-500 text-[10px]">128</span></li>
            <li className="flex items-center justify-between"><span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-sm bg-amber-400" /> Work</span><span className="text-navy-500 text-[10px]">42</span></li>
            <li className="flex items-center justify-between"><span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400" /> Family</span><span className="text-navy-500 text-[10px]">11</span></li>
          </ul>
        </div>

        <nav className="px-2 py-2 flex-1">
          <ul className="space-y-0.5">
            {NAV.map(({ icon: Icon, label, active }) => (
              <li key={label}>
                <div
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
                    active ? 'bg-teal-400/10 text-teal-300 font-semibold' : 'text-navy-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </div>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* List column */}
      <div className="w-72 border-r border-white/5 flex flex-col">
        <div className="h-12 px-3 flex items-center border-b border-white/5">
          <div className="flex items-center w-full gap-2 px-2.5 py-1 rounded-md bg-navy-900 border border-white/5">
            <Search className="w-3.5 h-3.5 text-navy-400" />
            <input
              readOnly
              defaultValue="Search 181 contacts"
              className="flex-1 bg-transparent text-xs text-navy-300 placeholder:text-navy-500 outline-none"
            />
          </div>
        </div>
        <ul className="overflow-y-auto">
          {CONTACTS.map((c, i) => (
            <li
              key={c.name}
              className={`flex items-center gap-2.5 px-3 py-2.5 border-b border-white/5 cursor-default ${
                i === SELECTED_INDEX ? 'bg-teal-400/5 border-l-2 border-l-teal-400' : ''
              }`}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0"
                style={{ backgroundColor: `${c.hue}33`, border: `1px solid ${c.hue}66` }}
              >
                <span style={{ color: c.hue }}>{c.initials}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white truncate">{c.name}</div>
                <div className="text-[10px] text-navy-400 truncate">{c.email}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Detail column */}
      <div className="flex-1 flex flex-col bg-navy-950/60">
        <div className="h-12 px-4 flex items-center justify-between border-b border-white/5">
          <span className="text-xs text-navy-400">Contact details</span>
          <button className="text-[10px] text-teal-400">Edit</button>
        </div>
        <div className="flex-1 px-6 py-6 overflow-hidden">
          <div className="flex items-center gap-4 mb-6">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-lg font-semibold flex-shrink-0"
              style={{ backgroundColor: `${selected.hue}33`, border: `1px solid ${selected.hue}66` }}
            >
              <span style={{ color: selected.hue }}>{selected.initials}</span>
            </div>
            <div>
              <div className="text-lg font-semibold text-white">{selected.name}</div>
              <div className="text-xs text-navy-400">{selected.subtitle}</div>
            </div>
          </div>

          <div className="space-y-3 text-xs">
            <ContactRow icon={Phone} label="Mobile" value="+49 30 123 456 78" />
            <ContactRow icon={Mail} label="Email" value={selected.email} />
            <ContactRow icon={Briefcase} label="Company" value="Acme Inc · Lead Engineer" />
            <ContactRow icon={MapPin} label="Address" value="Skalitzer Str. 68, 10997 Berlin" />
          </div>

          <div className="mt-6 pt-4 border-t border-white/5">
            <div className="text-[10px] uppercase tracking-wide text-navy-500 mb-1">Notes</div>
            <p className="text-xs text-navy-300 leading-relaxed">
              Met at OpenSource Berlin. Open to collaborate on calendar
              federation. Prefers Signal over email.
            </p>
          </div>
        </div>
        <div className="h-6 border-t border-white/5 px-3 flex items-center justify-between text-[10px] text-navy-500">
          <span>Encrypted vCard · synced 2m ago</span>
          <span>181 contacts</span>
        </div>
      </div>
    </div>
  )
}

function ContactRow({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded-md bg-navy-900 border border-white/5 flex items-center justify-center flex-shrink-0">
        <Icon className="w-3.5 h-3.5 text-teal-400" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-navy-500">{label}</div>
        <div className="text-white truncate">{value}</div>
      </div>
    </div>
  )
}

export function MockContactsMobile() {
  return (
    <div className="flex flex-col h-full text-navy-200 font-sans select-none">
      <div className="px-4 pt-7 pb-2 flex items-center justify-between bg-navy-950">
        <div>
          <div className="text-[10px] text-navy-400 uppercase tracking-wide">Address book</div>
          <div className="text-base font-semibold text-white">Contacts</div>
        </div>
        <button className="w-7 h-7 rounded-full bg-teal-400 text-navy-950 flex items-center justify-center">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-navy-900 border border-white/5">
          <Search className="w-3.5 h-3.5 text-navy-400" />
          <span className="text-[11px] text-navy-500">Search</span>
        </div>
      </div>

      <ul className="flex-1 overflow-hidden px-2">
        {CONTACTS.map((c) => (
          <li
            key={c.name}
            className="flex items-center gap-2.5 px-2 py-2 border-b border-white/5"
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
              style={{ backgroundColor: `${c.hue}33`, border: `1px solid ${c.hue}66` }}
            >
              <span style={{ color: c.hue }}>{c.initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white truncate">{c.name}</div>
              <div className="text-[10px] text-navy-400 truncate">{c.subtitle}</div>
            </div>
          </li>
        ))}
      </ul>

      <BottomNav active="Contacts" />
    </div>
  )
}

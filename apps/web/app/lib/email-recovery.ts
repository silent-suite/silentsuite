import { z } from 'zod'

const COMMON_EMAIL_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'proton.me',
  'protonmail.com',
  'icloud.com',
]

const COMMON_DOMAIN_TYPOS: Record<string, string> = {
  'gmai.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.om': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'outlook.con': 'outlook.com',
  'yaho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'protonmail.co': 'protonmail.com',
  'protonmail.con': 'protonmail.com',
  'proton.me.com': 'proton.me',
  'iclould.com': 'icloud.com',
  'icoud.com': 'icloud.com',
  'icloud.co': 'icloud.com',
  'icloud.con': 'icloud.com',
}

export type EmailDomainTypoWarning = {
  typedDomain: string
  suggestedDomain: string
  message: string
}

export function normalizeEmailForComparison(email: string): string {
  return email.trim().toLowerCase()
}

function domainFromEmail(email: string): string | null {
  const normalized = normalizeEmailForComparison(email)
  const atIndex = normalized.lastIndexOf('@')
  if (atIndex < 0 || atIndex === normalized.length - 1) return null
  return normalized.slice(atIndex + 1)
}

function oneEditAway(left: string, right: string): boolean {
  if (left === right) return false
  if (Math.abs(left.length - right.length) > 1) return false

  let edits = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (left.length > right.length) {
      i += 1
    } else if (right.length > left.length) {
      j += 1
    } else {
      i += 1
      j += 1
    }
  }

  if (i < left.length || j < right.length) edits += 1
  return edits === 1
}

export function findCommonEmailDomainTypo(email: string): EmailDomainTypoWarning | null {
  const typedDomain = domainFromEmail(email)
  if (!typedDomain) return null

  const suggestedDomain = COMMON_DOMAIN_TYPOS[typedDomain]
    ?? COMMON_EMAIL_DOMAINS.find((domain) => oneEditAway(typedDomain, domain))

  if (!suggestedDomain || suggestedDomain === typedDomain) return null

  return {
    typedDomain,
    suggestedDomain,
    message: `Did you mean ${suggestedDomain}?`,
  }
}

export const signupEmailSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
    confirmEmail: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
  })
  .refine((data) => normalizeEmailForComparison(data.email) === normalizeEmailForComparison(data.confirmEmail), {
    message: 'Email addresses do not match.',
    path: ['confirmEmail'],
  })

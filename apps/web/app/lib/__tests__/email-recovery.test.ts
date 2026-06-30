import { describe, expect, it } from 'vitest'
import {
  findCommonEmailDomainTypo,
  normalizeEmailForComparison,
  signupEmailSchema,
} from '../email-recovery'

describe('email recovery validation helpers', () => {
  it('normalizes email case and whitespace for comparison', () => {
    expect(normalizeEmailForComparison('  User@GMail.COM ')).toBe('user@gmail.com')
  })

  it('rejects malformed signup emails with public copy', () => {
    const result = signupEmailSchema.safeParse({ email: 'person@', confirmEmail: 'person@' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Enter a valid email address.')
  })

  it('rejects signup email confirmation mismatches after normalization', () => {
    const result = signupEmailSchema.safeParse({
      email: 'person@example.com',
      confirmEmail: 'person@other.com',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Email addresses do not match.')
  })

  it('accepts matching emails with different case and surrounding whitespace', () => {
    const result = signupEmailSchema.safeParse({
      email: ' Person@Example.com ',
      confirmEmail: 'person@example.COM',
    })
    expect(result.success).toBe(true)
  })

  it('warns when both pasted emails use a common typo domain', () => {
    expect(findCommonEmailDomainTypo('person@gmial.com')).toEqual({
      typedDomain: 'gmial.com',
      suggestedDomain: 'gmail.com',
      message: 'Did you mean gmail.com?',
    })
  })

  it('warns for common provider TLD mistakes', () => {
    expect(findCommonEmailDomainTypo('person@gmail.con')?.suggestedDomain).toBe('gmail.com')
  })
})

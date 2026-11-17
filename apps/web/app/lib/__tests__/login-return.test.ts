import { describe, expect, it } from 'vitest'
import { safeReturnTo } from '../login-return'

describe('safeReturnTo', () => {
  it.each([
    null,
    '',
    '/\\attacker.invalid',
    '/\t/attacker.invalid',
    '/\\\\/host.invalid',
    '/\t\\host.invalid',
    '/\n/host.invalid',
    '/\r/host.invalid',
    '\\/host.invalid',
    '//host.invalid',
    '///host.invalid',
    '/folder/..//host.invalid',
    `//${window.location.host}/tasks`,
    'https://host.invalid',
    'javascript:alert(1)',
    '/contacts\u007f',
    'tasks',
    ' /tasks',
  ])('falls back for an unsafe destination %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/calendar')
  })

  it.each(Array.from({ length: 32 }, (_, code) => code).concat(127))(
    'rejects ASCII control character %i anywhere in the destination',
    (code) => {
      const control = String.fromCharCode(code)
      for (const raw of [`${control}/tasks`, `/ta${control}sks`, `/tasks?q=${control}`, `/tasks#${control}`]) {
        expect(safeReturnTo(raw)).toBe('/calendar')
      }
    },
  )

  it('rejects a tab after search parameters have been decoded', () => {
    const params = new URLSearchParams('returnTo=%2F%09%2Fhost.invalid')
    expect(safeReturnTo(params.get('returnTo'))).toBe('/calendar')
  })

  it.each(['/login', '/login?x=1', '/login/x', '/login#x', '/tasks/../login', '/%2e/login'])(
    'prevents a return to the resolved login path %s',
    (raw) => {
      expect(safeReturnTo(raw)).toBe('/calendar')
    },
  )

  it.each(['/calendar', '/tasks', '/settings/subscription', '/contacts?list=abc#x', '/login-help'])(
    'preserves an app destination %s',
    (raw) => {
      expect(safeReturnTo(raw)).toBe(raw)
    },
  )

  it('returns the resolved pathname, query and fragment', () => {
    expect(safeReturnTo('/contacts/../tasks?list=abc#x')).toBe('/tasks?list=abc#x')
  })
})

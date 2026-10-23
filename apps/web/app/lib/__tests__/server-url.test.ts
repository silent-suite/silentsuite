import { describe, expect, it } from 'vitest'
import { normalizeServerUrl } from '@/app/lib/server-url'

describe('server URL normalization compatibility', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['server.example', 'https://server.example'],
    [' server.example/path/ ', 'https://server.example/path/'],
    ['https://server.example', 'https://server.example'],
    ['http://localhost:9000/base', 'http://localhost:9000/base'],
    ['HTTPS://SERVER.EXAMPLE', 'HTTPS://SERVER.EXAMPLE'],
    ['https://server.example/?a=1#part', 'https://server.example/?a=1#part'],
  ])('preserves normalization of %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected)
  })
})

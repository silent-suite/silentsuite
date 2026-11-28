// Picks white or navy text for a coloured background (calendar event chips),
// whichever has the higher WCAG 2 contrast ratio.

export const LIGHT_TEXT = '#ffffff'
export const DARK_TEXT = '#0a1018'

/** The calendar grid's page colour (--background in globals.css), which a translucent chip shows through. */
export const CHIP_SURFACES = { light: '#fcfdff', dark: '#0a1018' } as const

function expandHex(color: string): string | null {
  const match = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim())
  if (!match) return null
  const hex = match[1]!
  return hex.length <= 4 ? hex.split('').map((digit) => digit + digit).join('') : hex
}

function parseHex(color: string): [number, number, number] | null {
  const hex = expandHex(color)
  if (!hex) return null
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
}

function alphaOf(color: string): number {
  const hex = expandHex(color)
  return hex && hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHex(foreground)
  const bg = parseHex(background)
  if (!fg || !bg) return null
  const [light, dark] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}

/** The opaque colour a translucent `color` shows over the opaque `surface`, as #rrggbb. */
function composite(color: string, surface: string): string | null {
  const fg = parseHex(color)
  const bg = parseHex(surface)
  if (!fg || !bg) return null
  const alpha = alphaOf(color)
  return `#${fg.map((channel, index) => Math.round(channel * alpha + bg[index]! * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Text colour for a chip painted `background` over `surface`: a translucent colour is judged by
 * what it shows over that surface (a synced #ffffff00 is the page itself). Unparseable colours keep
 * white text.
 */
export function readableTextColor(background: string, surface: string = CHIP_SURFACES.light): typeof LIGHT_TEXT | typeof DARK_TEXT {
  const fill = composite(background, surface)
  if (!fill) return LIGHT_TEXT
  const light = contrastRatio(LIGHT_TEXT, fill)
  const dark = contrastRatio(DARK_TEXT, fill)
  if (light === null || dark === null) return LIGHT_TEXT
  return dark > light ? DARK_TEXT : LIGHT_TEXT
}

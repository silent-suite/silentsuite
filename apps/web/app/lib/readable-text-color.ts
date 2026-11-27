// Picks white or navy text for a coloured background (calendar event chips),
// whichever has the higher WCAG 2 contrast ratio.

export const LIGHT_TEXT = '#ffffff'
export const DARK_TEXT = '#0a1018'

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim())
  if (!match) return null
  let hex = match[1]!
  if (hex.length <= 4) hex = hex.split('').map((digit) => digit + digit).join('')
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
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

/** Alpha in #rgba/#rrggbbaa is ignored. Unparseable colours keep white text. */
export function readableTextColor(background: string): typeof LIGHT_TEXT | typeof DARK_TEXT {
  const light = contrastRatio(LIGHT_TEXT, background)
  const dark = contrastRatio(DARK_TEXT, background)
  if (light === null || dark === null) return LIGHT_TEXT
  return dark > light ? DARK_TEXT : LIGHT_TEXT
}

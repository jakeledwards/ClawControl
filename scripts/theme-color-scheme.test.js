import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('theme color schemes', () => {
  it('matches browser controls to the active application theme', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'index.css'), 'utf8')

    for (const [theme, colorScheme] of [['dark', 'dark'], ['light', 'light']]) {
      const match = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`))

      expect(match, `missing ${theme} theme block`).not.toBeNull()
      expect(match[1]).toMatch(new RegExp(`(?:^|\\n)\\s*color-scheme:\\s*${colorScheme}\\s*;`))
    }
  })
})

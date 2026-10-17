import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

// the store/extensions-page name is the brand alone — the pitch lives in the
// description, in every language
test('manifest_name is just "heatsync" in every locale', () => {
  const dir = new URL('../src/_locales/', import.meta.url)
  for (const l of readdirSync(dir)) {
    const m = JSON.parse(readFileSync(new URL(`${l}/messages.json`, dir), 'utf8'))
    expect(m.manifest_name.message).toBe('heatsync')
  }
})

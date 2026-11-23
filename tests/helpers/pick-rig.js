// The composer's pick wiring as the bundle has it, for a carved harness: the real draft store
// (src/lib/emote-refs.js) over one stand-in box, and the real lawPin (emote-law-send.js).
// Spread it into a harness's scope; `box` is the composer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { endDraftPicks, heldPick, keepPicksIn, pinPickedEmote } from '../../src/lib/emote-refs.js'

const LAW_SEND = readFileSync(join(import.meta.dir, '..', '..', 'src', 'multichat', 'emote-law-send.js'), 'utf8')
const at = LAW_SEND.indexOf('function lawPin(')
if (at === -1) throw new Error('lawPin not found in emote-law-send.js')
const LAW_PIN = LAW_SEND.slice(at, LAW_SEND.indexOf('\n}\n', at) + 2)

export function pickRig() {
  const box = {}
  const lawBox = () => box
  const lawPin = new Function('lawBox', 'pinPickedEmote', `${LAW_PIN}\nreturn lawPin`)(lawBox, pinPickedEmote)
  return { lawBox, lawPin, heldPick, endDraftPicks, keepPicksIn }
}

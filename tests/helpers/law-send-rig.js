// emote-law-send.js as the bundle runs it, over maps a test owns: for a suite that imports
// emotes.js as a module (its maps are that module's own, the adapter is a bundle global).
// `rig.legs` is the room of each platform the open tab sends to; `rig.box` is the composer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftPicks, endDraftPicks, pinPickedEmote, refOf } from '../../src/lib/emote-refs.js'
import { normalizeEmoteRefsForSend } from '../../src/lib/emote-refs-normalize.js'

const SRC = readFileSync(join(import.meta.dir, '..', '..', 'src', 'multichat', 'emote-law-send.js'), 'utf8')

export function lawSendRig({ viewerPersonalEmotes, emoteCache, channelEmoteCaches }) {
  const rig = { legs: { twitch: 'chan-a' }, box: {} }
  const scope = {
    hsEmoteLaw: globalThis.hsEmoteLaw,
    viewerPersonalEmotes,
    emoteCache,
    channelEmoteCaches,
    draftPicks,
    pinPickedEmote,
    refOf,
    normalizeEmoteRefsForSend,
    document: { getElementById: () => rig.box },
  }
  const names = Object.keys(scope)
  const api = new Function(
    ...names,
    'rig',
    `${SRC}\nlawOpenLegs = () => rig.legs\nreturn { lawChip, lawShip, lawStored, lawPin, lawBox }`,
  )(...names.map((k) => scope[k]), rig)
  rig.reset = () => {
    endDraftPicks(rig.box)
    rig.legs = { twitch: 'chan-a' }
  }
  return Object.assign(rig, api)
}

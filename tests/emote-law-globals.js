// The emote law and its overlay adapter, as the globals the multichat bundle gives emotes.js:
// `hsEmoteLaw` (shared/emote-law.ts bundled by scripts/lib/emote-law-bundle.mjs) and the free
// functions of src/multichat/emote-law-read.js and emote-rooms.js. Preloaded for every test (bunfig.toml), so a test
// that imports emotes.js runs the shipped code.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emoteLawSource, LAW_GLOBAL } from '../scripts/lib/emote-law-bundle.mjs'

const ROOT = join(import.meta.dir, '..')
const READ = readFileSync(join(ROOT, 'src', 'multichat', 'emote-law-read.js'), 'utf8')

globalThis[LAW_GLOBAL] = new Function(`${emoteLawSource(ROOT)}\nreturn ${LAW_GLOBAL}`)()
const { lawReadCtx, lawReadWord } = new Function(LAW_GLOBAL, `${READ}\nreturn { lawReadCtx, lawReadWord }`)(
  globalThis[LAW_GLOBAL],
)
const ROOMS = readFileSync(join(ROOT, 'src', 'multichat', 'emote-rooms.js'), 'utf8')
const rooms = new Function(`${ROOMS}\nreturn { channelLeg, channelRoomNames, channelLegPut, channelScanPut }`)()
// `_acPicKey` (input.js: a picture across size, format and host) is what emote-law-send.js stamps as
// the law's `pic`; a harness that carves that file gets it here as a global, as the bundle has it
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
const PIC = INPUT.slice(INPUT.indexOf('const _AC_PIC_RE ='), INPUT.indexOf('let _acRemoteToken'))
const { _acPicKey } = new Function(`${PIC}\nreturn { _acPicKey }`)()
// big emote-only lines: the row's read of a line and the rung it draws at (emote-big.js)
const BIG = readFileSync(join(ROOT, 'src', 'multichat', 'emote-big.js'), 'utf8')
const big = new Function(
  LAW_GLOBAL,
  'getSetting',
  `${BIG}\nreturn { hsReadEmoji, hsBigLine, hsBigRung, hsBigBoxW, hsBigRowOk, hsMarkBigRow }`,
)(globalThis[LAW_GLOBAL], (k) => globalThis.getSetting?.(k))
Object.assign(globalThis, { lawReadCtx, lawReadWord, _acPicKey, ...rooms, ...big })

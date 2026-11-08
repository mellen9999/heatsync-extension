// chat sounds — every audible cue (the @mention sound and highlight-rule sounds)
// plays from here: four synthesized presets, or one short audio file the user
// picked. Pure Web Audio on purpose. A content script is bound by the HOST
// page's CSP, and twitch/kick/youtube may refuse media from data:/blob:, so
// `new Audio(url)` can fail silently where a decoded buffer cannot.
//
// A picked file lives in chrome.storage.local (hs_sfx_*), not IndexedDB: a
// content script's IndexedDB belongs to the host page's origin, so a file
// picked on twitch would not exist on kick or youtube. storage.local is one
// extension-wide store with onChanged for cross-tab refresh, the extension
// already holds unlimitedStorage, and nothing here uses IndexedDB. The bytes
// stay on the device: rules keep only a name, and settings export/import and
// sync never carry the hs_sfx_* keys (see _SETTINGS_PRIVATE_KEY_RE).

const SFX_PRESETS = {
  ping: [
    { f: 880, t0: 0, d: 0.32 },
    { f: 1175, t0: 0.08, d: 0.24 },
  ],
  blip: [{ f: 1320, t0: 0, d: 0.12 }],
  knock: [
    { f: 200, t0: 0, d: 0.1 },
    { f: 200, t0: 0.13, d: 0.1 },
  ],
  chime: [
    { f: 660, t0: 0, d: 0.18 },
    { f: 880, t0: 0.09, d: 0.18 },
    { f: 1318, t0: 0.18, d: 0.26 },
  ],
}
const SFX_CUSTOM = 'custom'
const SFX_FALLBACK = 'ping' // what plays when a custom file is not on this device
const SFX_KEY_PREFIX = 'hs_sfx_'
const SFX_MENTION_KEY = `${SFX_KEY_PREFIX}mention`
const SFX_MAX_BYTES = 256 * 1024
const SFX_MAX_B64 = Math.ceil(SFX_MAX_BYTES / 3) * 4
const SFX_MAX_SECONDS = 10 // a file that rings for a minute on every match is a bug, not a sound
const SFX_NAME_MAX = 60
const SFX_THROTTLE_MS = 1200 // one cue per bucket per 1.2s — a raid of matches can't machine-gun
const SFX_STALE_MS = 1500 // a cue the browser would only let start later than this is dropped
const SFX_IDLE_MS = 2000 // grace before parking the audio context after the last tone
const SFX_SYNTH_PEAK = 0.35 // synth gain at volume 1 — today's loudness, unchanged
const SFX_BUF_CACHE_MAX = 6
const SFX_EXT_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba|webm)$/i

/** storage key holding a rule's own sound file */
function sfxRuleKey(ruleId) {
  return `${SFX_KEY_PREFIX}rule_${ruleId}`
}

/**
 * volume 0..1 → gain. Synth tones peak at volume × 0.35 (exactly what the
 * mention ping always did); a picked file plays at volume × its own level.
 */
function sfxGain(volume, custom) {
  const v = Math.min(1, Math.max(0, Number(volume) || 0))
  return custom ? v : v * SFX_SYNTH_PEAK
}

/** null when the file may be tried, else why not: 'type' | 'size' */
function sfxCheckFile(file) {
  if (!file || typeof file.size !== 'number') return 'type'
  const type = String(file.type || '')
  const isAudio = type ? type.startsWith('audio/') : SFX_EXT_RE.test(String(file.name || ''))
  if (!isAudio) return 'type'
  if (file.size > SFX_MAX_BYTES) return 'size'
  return null
}

function sfxCleanName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can carry control characters
  return (
    base
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, SFX_NAME_MAX) || 'sound'
  )
}

function _sfxToB64(buffer) {
  const u8 = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function _sfxFromB64(b64) {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8.buffer
}

// ── audio context ─────────────────────────────────────────────────────────────
// A running AudioContext holds the audio render thread and the output device
// open, so one mention used to leave a wakeup source running for the rest of
// the session. After the last tone the context parks itself (suspend), and the
// next cue resumes it.
let _sfxCtx = null
let _sfxIdleTimer = null
function _sfxGetCtx() {
  if (_sfxCtx) return _sfxCtx
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AC) return null
    _sfxCtx = new AC()
    return _sfxCtx
  } catch {
    return null
  }
}

/** Park the context once `tailSec` (end of the last scheduled sound) + grace has passed. */
function _sfxIdleArm(ctx, tailSec) {
  if (_sfxIdleTimer) {
    cleanup.clearTimeout(_sfxIdleTimer)
    _sfxIdleTimer = null
  }
  _sfxIdleTimer = cleanup.setTimeout(
    () => {
      _sfxIdleTimer = null
      try {
        if (ctx.state === 'running') ctx.suspend()?.catch?.(() => {})
      } catch {}
    },
    Math.max(0, tailSec * 1000) + SFX_IDLE_MS,
  )
}

/**
 * Run `play` once the context is running. Browsers keep a context suspended
 * until the page has had a user gesture, so resume() may stay pending for
 * minutes: a cue that only gets to start long after it was asked for is
 * dropped, not queued — a stale ping minutes later is worse than none. Never
 * throws, never rejects. Resolves true when `play` ran.
 */
function _sfxWhenRunning(ctx, requestedAt, play) {
  if (ctx.state === 'running') {
    play()
    return Promise.resolve(true)
  }
  let pending
  try {
    pending = ctx.resume()
  } catch {
    return Promise.resolve(false)
  }
  return Promise.resolve(pending)
    .then(() => {
      if (ctx.state !== 'running' || Date.now() - requestedAt > SFX_STALE_MS) return false
      play()
      return true
    })
    .catch(() => false)
}

// ── synth ─────────────────────────────────────────────────────────────────────
function _sfxSynth(ctx, name, volume) {
  const tones = SFX_PRESETS[name]
  try {
    _sfxIdleArm(ctx, Math.max(...tones.map((tone) => tone.t0 + tone.d)) + 0.02)
    const t = ctx.currentTime
    const peak = sfxGain(volume)
    for (const tone of tones) {
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0, t + tone.t0)
      gain.gain.linearRampToValueAtTime(peak, t + tone.t0 + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tone.t0 + tone.d)
      gain.connect(ctx.destination)
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(tone.f, t + tone.t0)
      o.connect(gain)
      o.start(t + tone.t0)
      o.stop(t + tone.t0 + tone.d + 0.02)
    }
  } catch {}
}

// The original @mention ping: both tones through ONE envelope, so the second
// one rides the first's decay. Kept as it always sounded — the filter-rule
// 'ping' preset gives each tone its own envelope and is a touch fuller.
function _sfxMentionPing(ctx, volume) {
  try {
    _sfxIdleArm(ctx, 0.32)
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(sfxGain(volume), now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    gain.connect(ctx.destination)
    const o1 = ctx.createOscillator()
    o1.type = 'sine'
    o1.frequency.setValueAtTime(880, now)
    o1.connect(gain)
    o1.start(now)
    o1.stop(now + 0.32)
    const o2 = ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.setValueAtTime(1175, now + 0.08)
    o2.connect(gain)
    o2.start(now + 0.08)
    o2.stop(now + 0.32)
  } catch {}
}

// ── picked files ──────────────────────────────────────────────────────────────
// Decoded buffers, newest last. Holds promises so two cues asking at once share
// one read+decode. Only successes stay: a miss is retried (one cheap storage
// read) so a file picked in another tab is heard on the very next cue.
const _sfxBufs = new Map()
let _sfxWired = false

function _sfxWireStorage() {
  if (_sfxWired) return
  _sfxWired = true
  try {
    cleanup.addListener(api.storage.onChanged, (changes, area) => {
      if (area !== 'local') return
      for (const k of Object.keys(changes)) if (k.startsWith(SFX_KEY_PREFIX)) _sfxBufs.delete(k)
    })
  } catch {}
}

function _sfxUsable(buf) {
  return !!buf && buf.duration > 0 && buf.duration <= SFX_MAX_SECONDS
}

function _sfxLoad(key, ctx) {
  _sfxWireStorage()
  const hit = _sfxBufs.get(key)
  if (hit) {
    _sfxBufs.delete(key)
    _sfxBufs.set(key, hit)
    return hit
  }
  const p = (async () => {
    try {
      const rec = (await api.storage.local.get(key))?.[key]
      if (!rec || typeof rec.b !== 'string' || !rec.b || rec.b.length > SFX_MAX_B64) return null
      const buf = await ctx.decodeAudioData(_sfxFromB64(rec.b))
      return _sfxUsable(buf) ? buf : null
    } catch {
      return null
    }
  })()
  _sfxBufs.set(key, p)
  p.then((buf) => {
    if (!buf && _sfxBufs.get(key) === p) _sfxBufs.delete(key)
  })
  while (_sfxBufs.size > SFX_BUF_CACHE_MAX) _sfxBufs.delete(_sfxBufs.keys().next().value)
  return p
}

/**
 * Read + validate a picked file. Resolves {ok:true, sound} or {ok:false, reason}
 * with reason one of 'type' | 'size' | 'decode' | 'long'. Nothing is stored yet:
 * the caller saves it (sfxSave) once the user commits, so an abandoned pick
 * leaves nothing behind.
 */
async function sfxPrepareFile(file) {
  const bad = sfxCheckFile(file)
  if (bad) return { ok: false, reason: bad }
  let bytes
  try {
    bytes = await file.arrayBuffer()
  } catch {
    return { ok: false, reason: 'decode' }
  }
  if (bytes.byteLength > SFX_MAX_BYTES) return { ok: false, reason: 'size' }
  const ctx = _sfxGetCtx()
  if (!ctx) return { ok: false, reason: 'decode' }
  let buf
  try {
    buf = await ctx.decodeAudioData(bytes.slice(0)) // decoding detaches its input
  } catch {
    return { ok: false, reason: 'decode' }
  }
  if (!(buf?.duration > 0)) return { ok: false, reason: 'decode' }
  if (buf.duration > SFX_MAX_SECONDS) return { ok: false, reason: 'long' }
  return { ok: true, sound: { n: sfxCleanName(file.name), t: String(file.type || ''), b: _sfxToB64(bytes), buf } }
}

/** Store a prepared sound under `key` on this device. Resolves true on success. */
async function sfxSave(key, sound) {
  try {
    await api.storage.local.set({ [key]: { n: sound.n, t: sound.t, b: sound.b } })
    _sfxBufs.delete(key)
    return true
  } catch {
    return false
  }
}

async function sfxRemove(key) {
  _sfxBufs.delete(key)
  try {
    await api.storage.local.remove(key)
  } catch {}
}

// ── playback ──────────────────────────────────────────────────────────────────
// Each bucket (the @mention sound, highlight-rule sounds) is rate-limited on its
// own and plays one picked file at a time: a newer cue cuts the older one off.
const _sfxLast = { mention: 0, rule: 0 }
const _sfxVoice = { mention: null, rule: null }

function _sfxPlayBuffer(ctx, buf, volume, bucket) {
  try {
    try {
      _sfxVoice[bucket]?.stop()
    } catch {}
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(sfxGain(volume, true), ctx.currentTime)
    src.connect(gain)
    gain.connect(ctx.destination)
    src.onended = () => {
      try {
        src.disconnect()
        gain.disconnect()
      } catch {}
      if (_sfxVoice[bucket] === src) _sfxVoice[bucket] = null
    }
    _sfxVoice[bucket] = src
    _sfxIdleArm(ctx, buf.duration + 0.05)
    src.start()
  } catch {}
}

/**
 * Play one cue. spec = { name, key, volume, buf }:
 *   name    'ping' | 'blip' | 'knock' | 'chime' | 'custom'  (anything else is silent)
 *   key     storage key of the picked file (custom only)
 *   volume  0..1
 *   buf     an already-decoded file, for previewing one not stored yet
 * bucket 'mention' | 'rule'. `preview` skips the rate limit — a person pressing
 * play asked for exactly that sound, now.
 * Resolves one of: 'played' | 'fallback' (custom file missing → ping played) |
 * 'silent' | 'throttled' | 'blocked' (no audio, or the browser would not start
 * it). Never throws.
 */
async function sfxPlay(spec, bucket, preview) {
  const volume = Number(spec?.volume)
  if (!(volume > 0)) return 'silent'
  const custom = spec.name === SFX_CUSTOM
  if (!custom && !SFX_PRESETS[spec.name]) return 'silent'
  if (!preview) {
    const now = Date.now()
    if (now - _sfxLast[bucket] < SFX_THROTTLE_MS) return 'throttled'
    _sfxLast[bucket] = now
  }
  const ctx = _sfxGetCtx()
  if (!ctx) return 'blocked'
  const requestedAt = Date.now()
  const buf = custom ? spec.buf || (spec.key ? await _sfxLoad(spec.key, ctx) : null) : null
  const fallback = custom && !buf
  const name = fallback ? SFX_FALLBACK : spec.name
  const play = buf
    ? () => _sfxPlayBuffer(ctx, buf, volume, bucket)
    : () => (bucket === 'mention' && name === 'ping' ? _sfxMentionPing(ctx, volume) : _sfxSynth(ctx, name, volume))
  if (!(await _sfxWhenRunning(ctx, requestedAt, play))) return 'blocked'
  return fallback ? 'fallback' : 'played'
}

export {
  SFX_CUSTOM,
  SFX_KEY_PREFIX,
  SFX_MAX_BYTES,
  SFX_MAX_SECONDS,
  SFX_MENTION_KEY,
  SFX_PRESETS,
  SFX_THROTTLE_MS,
  sfxCheckFile,
  sfxCleanName,
  sfxGain,
  sfxPlay,
  sfxPrepareFile,
  sfxRemove,
  sfxRuleKey,
  sfxSave,
}

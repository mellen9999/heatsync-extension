// Input - chat input, autocomplete, send message, reply state

// module scope resets on re-injection, so a fresh instance re-registers
// after the old one's teardown; window-scope survives takeover and leaves
// handlers dead until hard refresh
const _onceGuardsInput = {}

// Message history — up/down arrow recalls previously sent messages
const mcMessageHistory = []
const MC_HISTORY_MAX = 50
let mcHistoryIndex = -1
let mcHistoryDraft = ''

// Broken-image recovery for input-area emote imgs. Browser negatively caches
// failed image responses (proxy hiccup, CDN blip); without this hook the typed
// word renders forever as a broken-image placeholder in the composer.
// Strategy: retry once with a cache-bust to defeat the negative cache, then
// fall back to the alt text so the message still ships as plain text.
function attachInputEmoteErrorRecovery(img) {
  img.addEventListener('error', () => {
    if (img.dataset.hsRetried) {
      const t = document.createTextNode(img.alt || '')
      img.replaceWith(t)
      return
    }
    img.dataset.hsRetried = '1'
    img.src = `${img.src}${img.src.includes('?') ? '&' : '?'}r=${Date.now()}`
  })
}

// Brief red flash on input to indicate message can't be sent from this tab
function flashInputError(input) {
  if (!input) return
  input.style.background = 'var(--hs-danger-dim)'
  input.style.borderColor = 'var(--hs-danger)'
  setTimeout(() => {
    input.style.background = ''
    input.style.borderColor = ''
  }, 600)
}

// Per-emote operation lock to prevent race conditions from rapid clicking
const pendingEmoteOps = new Set()

// Cache own badge string from IRC messages for optimistic display.
// Per-channel: sub badge tier differs by streamer, so a single global ref
// stamped the wrong channel's sub badge onto synthetic celebrations.
let _ownBadges = ''
const _ownBadgesByChannel = new Map() // channelLower -> badges string
function ownBadgesFor(channel) {
  if (!channel) return _ownBadges
  return _ownBadgesByChannel.get(String(channel).toLowerCase()) || _ownBadges
}

// Echo dedup — suppress own message echoes from IRC/KickChat relay
// Uses a Set of {text, time} to handle rapid sends without overwriting
let _recentSentMessages = []
const SENT_DEDUP_WINDOW = 10000 // 10s — used by isSentEcho to suppress dual-send duplicates only
const SENT_HOST_WINDOW = 24 * 60 * 60 * 1000 // 24h — peekSentHost needs longer so badge survives refresh
const RECENT_SENT_KEY = 'hs_recent_sent'

function _pruneRecent(arr) {
  // Prune to the LONGER window so peekSentHost can attribute badges across
  // refreshes. isSentEcho applies its own tighter cutoff at lookup time.
  const cutoff = Date.now() - SENT_HOST_WINDOW
  return arr.filter((e) => e && e.time >= cutoff)
}

// Kick echoes a native emote back in its wire form, [emote:<id>:<name>], while
// we track what the user typed. Since the composer now rewrites kick emotes on
// the way out (kickifyEmoteText), the two forms differ by construction — and an
// echo that fails to match is an echo that renders a second time and never
// confirms the pending send. Compare with the tokens collapsed to their names.
// Guarded on the literal so the ~95% of traffic that carries no token pays
// nothing.
function _unkickEmotes(s) {
  const str = String(s ?? '')
  return str.indexOf('[emote:') === -1 ? str : str.replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
}
// Twitch prepends "@<login> " to reply echoes server-side, so a reply's echo
// text never equals the typed text. Entries flagged reply:true also match the
// echo with one leading @token stripped. Scoped to reply entries only — a
// non-reply entry never strips, so a stranger's "@you <same text>" can't get
// eaten unless YOUR send was itself a reply within the dedup window.
function _echoTextMatches(entry, msgText) {
  if (entry.text === msgText) return true
  const a = _unkickEmotes(entry.text)
  const b = _unkickEmotes(msgText)
  if (a === b) return true
  return !!entry.reply && b.replace(/^@\S+\s+/, '') === a
}

function trackSentMessage(text, hostOverride, synthId, echoes, reply) {
  _recentSentMessages.push({
    text,
    time: Date.now(),
    host: hostOverride || hostPlatform,
    synthId,
    echoes: echoes || 1,
    reply: !!reply,
  })
  _recentSentMessages = _pruneRecent(_recentSentMessages)
  // Cross-tab sync: kick.com tab and twitch.tv tab live in different
  // content-script contexts, so they each have their own array. Storage
  // mirrors the entry to every tab via onChanged so peekSentHost on the
  // OTHER host tagged the IRC echo with the correct origin host. ~50ms
  // sync latency easily wins the race against the ~100-300ms platform
  // chat round-trip.
  try {
    // Strip per-tab echo bookkeeping before persisting: each tab receives its
    // own echo stream and must account independently — a leaked counter would
    // make another tab suppress its FIRST (only rendered) copy of the message.
    chrome.storage.local.set({
      [RECENT_SENT_KEY]: _recentSentMessages.map(
        ({ suppressed, seenPlatforms, rendered, hydratedPlatforms, ...rest }) => rest,
      ),
    })
  } catch (_) {}
}

// Hydrate from storage on load + listen for cross-tab updates.
// Listener is tracked via cleanup so SPA reinit doesn't stack copies.
// recentSentHydrated Promise lets BG-history loaders await this before
// stamping platform badges — otherwise the storage-hydration race lets the
// echo render as the IRC echo's actual origin (twitch) instead of the
// sending host (kick).
let _recentSentHydrated = null
{
  let _hydrateResolve = null
  _recentSentHydrated = new Promise((r) => {
    _hydrateResolve = r
  })
  try {
    chrome.storage.local
      .get(RECENT_SENT_KEY)
      .then((data) => {
        const incoming = data?.[RECENT_SENT_KEY]
        if (Array.isArray(incoming)) _recentSentMessages = _pruneRecent(incoming)
      })
      .catch(() => {})
      .finally(() => {
        try {
          _hydrateResolve()
        } catch {}
      })
  } catch (_) {
    _hydrateResolve()
  }
}
try {
  if (!_onceGuardsInput.inputStorageListener) {
    const _inputStorageHandler = (changes, area) => {
      if (area !== 'local' || !changes[RECENT_SENT_KEY]) return
      const incoming = changes[RECENT_SENT_KEY].newValue
      if (!Array.isArray(incoming)) return
      // Merge our local writes with the incoming snapshot, keyed by
      // (text, exact time, synthId) so two rapid same-text sends stay two
      // entries — the old 1s time bucket collapsed them and broke echo
      // accounting. On a key tie the LOCAL entry wins (it's spread first and
      // ties don't replace), preserving this tab's own suppressed counters.
      const merged = new Map()
      for (const e of [..._recentSentMessages, ...incoming]) {
        if (!e?.text) continue
        const k = `${e.text}:${e.time || 0}:${e.synthId || ''}`
        const existing = merged.get(k)
        if (!existing || (existing.time || 0) < (e.time || 0)) merged.set(k, e)
      }
      _recentSentMessages = _pruneRecent([...merged.values()].sort((a, b) => a.time - b.time))
    }
    cleanup.addListener(chrome.storage.onChanged, _inputStorageHandler)
    _onceGuardsInput.inputStorageListener = true
  }
} catch (_) {}

// Normalise the platform tag an echo arrives with. Call sites pass literals
// ('twitch' | 'kick' | 'youtube'), but msg.platform elsewhere in the codebase
// uses 'yt' — one spelling here or the two are different buckets.
function _echoPlatformKey(p) {
  const s = String(p || '').toLowerCase()
  if (s === 'yt') return 'youtube'
  return s || 'unknown'
}

function isSentEcho(msgText, msgPlatform) {
  const cutoff = Date.now() - SENT_DEDUP_WINDOW
  const platform = _echoPlatformKey(msgPlatform)
  // FIFO oldest-first: each echo is claimed by the OLDEST send that hasn't
  // already taken an echo from THIS platform. The old newest-first scan locked
  // two same-text sends onto one entry, so the 2nd send's only echo was counted
  // as the 1st send's dual-send duplicate and silently dropped.
  for (let i = 0; i < _recentSentMessages.length; i++) {
    const entry = _recentSentMessages[i]
    // continue (not break): a cross-tab merge can briefly leave the array out
    // of time order, so one stale entry doesn't mean the rest are stale too.
    if (entry.time < cutoff) continue
    if (!_echoTextMatches(entry, msgText)) continue
    // Claim by PLATFORM, not by a count of expected echoes.
    //
    // The count came from the send targets the extension knew about
    // (sendToTwitch + sendToKick + sendToYoutube). Any echo the extension
    // didn't predict — a leg fanned out server-side, a relay, a target
    // resolved after the entry was tracked — overran that count, and an
    // overrun echo fell out of the loop and rendered as a SECOND copy of
    // your own message. Counting what actually arrives cannot undercount.
    const seen = entry.seenPlatforms || (entry.seenPlatforms = [])
    // This entry already took an echo from this platform, so this one belongs
    // to a LATER identical send (or a stranger repeating you) — keep looking.
    if (seen.includes(platform)) continue
    seen.push(platform)
    // Host-platform badge attribution happens separately via peekSentHost,
    // so we don't suppress on host mismatch — that would drop the only
    // echo when sending from one platform to a single-platform channel
    // on a different host (e.g. kick.com → twitch-only mellen).
    //
    // First echo of a send displays; every other platform's copy of that same
    // send is suppressed. The entry is kept (pruned at the 24h window) so
    // peekSentHost can still attribute badges.
    if (entry.rendered) return true
    entry.rendered = true
    return false
  }
  return false
}

// Retro-fold: fold own-send platform echoes that RENDERED BEFORE the
// cross-device origin_broadcast arrived. isSentEcho only folds echoes that
// arrive AFTER the entry exists — but a kick send from another device relays
// through THIS extension, so the local pusher echo often beats the phone's
// origin_tag round-trip and paints as a bare [K] row that isSentEcho never
// saw. Called right after trackSentMessage stores a broadcast entry: the
// earliest already-painted leg is retagged [H] and claims its platform; any
// later leg is the dual-send duplicate — DOM row removed + msg.hidden (the
// share-claim fold idiom) so buffer rebuilds don't resurrect it. Mirrors the
// site's reconcile scan (heatsync 25646584).
function retroFoldOwnEchoes() {
  const entry = _recentSentMessages[_recentSentMessages.length - 1]
  if (!entry || entry.host !== 'heatsync') return
  const msgsEl = document.getElementById('hs-mc-messages')
  if (!msgsEl) return
  const cutoff = Date.now() - SENT_DEDUP_WINDOW
  // Recent tail only — an echo that beat the broadcast is seconds old.
  const rows = Array.from(msgsEl.children).slice(-60)
  const legs = []
  for (const div of rows) {
    const m = div._hsMsg
    if (!m || m.hidden || !m.text) continue
    if ((m.time || 0) < cutoff) continue
    // Already-[H] rows were claimed at ingest (or by an earlier send's fold) —
    // never re-claim them, and never fold system rows.
    if (m.platform === 'heatsync' || m.type) continue
    if (!_echoTextMatches(entry, m.text)) continue
    const plat = _echoPlatformKey(m.platform || 'twitch')
    const seen = entry.seenPlatforms || (entry.seenPlatforms = [])
    if (seen.includes(plat)) continue
    seen.push(plat)
    legs.push({ div, m })
  }
  if (!legs.length) return
  // Survivor: prefer the TWITCH leg — its tmi-sent-ts orders consistently
  // with the (twitch-dominant) stream and it painted with the full badge
  // set. A kick echo often paints FIRST (it relays through this very ext)
  // but bare and with a laggier timestamp, which strands the row rows-up in
  // a busy chat since rows never move once placed.
  const survivor = legs.find((l) => (l.m.platform || 'twitch') === 'twitch') || legs[0]
  if (!entry.rendered) {
    entry.rendered = true
    const m = survivor.m
    m.badgePlatform = m.badgePlatform || m.platform
    m.platform = 'heatsync'
    const pb = survivor.div.querySelector('.hs-mc-platform-badge')
    if (pb) {
      pb.classList.remove('hs-mc-pb-twitch', 'hs-mc-pb-kick', 'hs-mc-pb-yt')
      pb.classList.add('hs-mc-pb-heatsync')
      pb.style.color = HS_PLAT_COLORS.heatsync
      pb.textContent = '[H]'
    }
  }
  for (const leg of legs) {
    if (leg === survivor && leg.m.platform === 'heatsync') continue
    // Every non-survivor leg is the dual-send duplicate.
    leg.m.hidden = true
    try {
      _unindexMessageDiv(leg.div)
    } catch (_) {}
    leg.div.remove()
  }
}

// Hydration twin of isSentEcho — folds the OTHER platform legs of one
// cross-device simulcast send when BG buffers replay history. isSentEcho's
// 10s window is anchored to NOW (live races only); replayed legs are
// minutes-to-hours old, so this matches the MESSAGE's own timestamp against
// the entry's send time instead. Same contract: first leg per entry renders,
// every other platform's leg folds. `hydratedPlatforms` is per-tab session
// bookkeeping — stripped before persist like seenPlatforms/rendered, so each
// tab accounts its own replay independently. Returns true → caller hides.
function claimHydratedEcho(msgText, msgPlatform, msgTime) {
  if (!msgTime) return false
  const platform = _echoPlatformKey(msgPlatform)
  for (let i = 0; i < _recentSentMessages.length; i++) {
    const entry = _recentSentMessages[i]
    if (Math.abs((entry.time || 0) - msgTime) > SENT_DEDUP_WINDOW) continue
    if (!_echoTextMatches(entry, msgText)) continue
    const seen = entry.hydratedPlatforms || (entry.hydratedPlatforms = [])
    if (seen.includes(platform)) continue
    seen.push(platform)
    return seen.length > 1 // first leg renders; later platforms fold
  }
  return false
}

// Peek a recent-sent entry by text WITHOUT consuming it. Used by the IRC/kick
// handlers to attribute the badge platform on the displayed echo. Returns the
// host platform string ('twitch' | 'kick' | 'yt') or null if no tracked send
// matches — letting echoes from elsewhere (e.g. heatsync.org website sends)
// keep whatever platform tag the server attached.
function peekSentHost(msgText) {
  // Use the longer SENT_HOST_WINDOW (24h) — badge attribution must survive
  // page refresh, BG buffer replay, and channel-switch hydration. The dedup
  // path (isSentEcho) uses the tighter 10s window separately.
  const cutoff = Date.now() - SENT_HOST_WINDOW
  for (let i = _recentSentMessages.length - 1; i >= 0; i--) {
    const entry = _recentSentMessages[i]
    // continue (not break): cross-tab storage merges can leave entries out of
    // time order, so a stale entry early in the reverse scan must not abort the
    // search before a valid newer match (mirrors isSentEcho). Array is capped.
    if (entry.time < cutoff) continue
    if (_echoTextMatches(entry, msgText)) return entry.host || null
  }
  return null
}

// Own-reply echo bar. A reply we send is echoed back by whichever read transport
// wins the race — the BG anon IRC socket or the native page tap — and only ONE
// of them reliably carries reply-parent-* tags on our own message, so the bar
// (m.replyTo) rendered intermittently: present when the tagged copy won, absent
// when the untagged one did (dominant in popout mode). Capture the parent
// context at send time and stamp it back onto our own echo when it arrives
// bare, making the bar transport-independent. Keyed by echo text (reply echoes
// carry twitch's "@login " prefix, matched via _echoTextMatches), 10s window.
let _recentOwnReplies = []
function rememberOwnReply(text, replyTo) {
  if (!text || !replyTo?.user) return
  _recentOwnReplies.push({ text, replyTo, time: Date.now() })
  const cutoff = Date.now() - SENT_DEDUP_WINDOW
  _recentOwnReplies = _recentOwnReplies.filter((e) => e.time >= cutoff)
}
function peekOwnReply(echoText) {
  if (!echoText || !_recentOwnReplies.length) return null
  const cutoff = Date.now() - SENT_DEDUP_WINDOW
  for (let i = _recentOwnReplies.length - 1; i >= 0; i--) {
    const e = _recentOwnReplies[i]
    if (e.time < cutoff) continue
    // reply:true so _echoTextMatches also strips the leading "@login " twitch
    // prepends onto reply echoes (mirrors isSentEcho/peekSentHost).
    if (_echoTextMatches({ text: e.text, reply: true }, echoText)) return e.replyTo
  }
  return null
}

// Stamp the reply bar back onto our own echo, for every read transport on every
// platform. Twitch's tagged copy only sometimes wins the race; kick's echo of
// our own send carries no reply payload; youtube has no reply threading at all.
// One helper so the three message handlers cannot drift — they did, and the two
// that never had it were why a reply sent on kick or youtube rendered bare.
//
// The CALLER must already have proved this echo is ours (a peekSentHost hit —
// text alone is not ownership, or a stranger repeating your line gets your
// reply bar). Never overwrites a replyTo the transport did carry.
function restoreOwnReplyBar(msg) {
  if (!msg || msg.replyTo) return
  const own = peekOwnReply(msg.text)
  if (own?.user) msg.replyTo = own
}

// ============================================
// PENDING-SEND TRACKER — round-trip confirmation
// ============================================
// Every send registers an entry keyed by synthId with a per-platform awaiting
// set. Echo arrival via the IRC/Kick read socket calls confirmPending(id,
// platform) which removes that platform from awaiting; the entry is only
// dismissed when the set drains. If the 7s timeout fires with anything still
// awaiting, the user sees a persistent notif with a one-click [retry].
//
// Per-platform tracking matters for dual-send: if twitch echoes but kick
// silently drops (or vice versa), the legacy "any echo = all good" logic
// would mask the dropped platform and the user would never know. The
// tracker exists precisely to catch silent drops — shadow-mute, integrity
// fails, mid-rejoin races leave no NOTICE, no error, just gone — and that
// guarantee only holds if we wait for every platform we sent to.
const pendingSends = new Map()
// Cap on retained sends. In-flight 'pending' entries clear on their echo (or
// their 20s timer); 'failed' entries linger for the retry notif and have no
// cleanup on toast dismiss/expiry, so they'd accumulate — each holding the
// message text — over a long session. markPendingFailed evicts the oldest
// FAILED entries beyond this, never touching in-flight ones.
const PENDING_SENDS_MAX = 50
// 20s: 12s was firing false positives when SW briefly suspended/restarted
// during the echo window. Real BG-restart cycles can take 5-15s before the
// anon socket rejoins and starts receiving PRIVMSGs again. 20s catches those
// while still flagging genuine silent drops (shadow-mute, AutoMod). Worst-
// case the user sees the toast 8s later than before — but doesn't see false
// alarms when their message actually went through.
const PENDING_ECHO_TIMEOUT_MS = 20000
// Expose for devtools
try {
  globalThis.__hsPendingSends = pendingSends
} catch (_) {}

function makeSynthId() {
  return `hs-pend-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

// Twitch/Kick chat commands the platform executes and acks via a NOTICE — they
// never echo back as a PRIVMSG, so the round-trip tracker must not await one or
// it fires a false "did not confirm" 20s after the command actually ran. These
// fall through handleSlashCommand (unwired) and get sent raw; the NOTICE is the
// real ack (success or rejection, surfaced by auth-irc). /me is NOT here — it
// echoes as a CTCP ACTION.
// Twitch chat commands that no longer exist over IRC (deprecated Feb 2023 —
// the same deprecation that broke /ban /timeout /unban /delete, which got real
// GQL handlers; these never did). Without a handler they fall through to a
// plain send and the broadcaster's own moderation command goes out as message
// text, so handleSlashCommand refuses them on twitch instead. They're also
// advertised nowhere now — this set only catches muscle memory. Wiring them
// for real means discovering each mutation and reading the result back, the
// way setTwitchChatMode does.
// Twitch killed these as IRC chat commands (Feb 2023); refused rather than sent
// as literal text. vip/unvip left OFF this list — they're now wired via GQL
// (VIPUser/UnVIPUser), so they must reach their handler instead of being refused.
const DEAD_TWITCH_CHAT_COMMANDS = new Set(['clear', 'color', 'raid', 'unraid', 'commercial', 'marker'])

const NON_ECHOING_CHAT_COMMANDS = new Set([
  'followers',
  'followersoff',
  'emoteonly',
  'emoteonlyoff',
  'subscribers',
  'subscribersoff',
  'slow',
  'slowoff',
  'uniquechat',
  'uniquechatoff',
  'r9kbeta',
  'r9kbetaoff',
  'clear',
  'color',
  'mod',
  'unmod',
  'vip',
  'unvip',
  'untimeout',
  'unban',
  'raid',
  'unraid',
  'commercial',
  'marker',
  'announce',
  'announceblue',
  'announcegreen',
  'announceorange',
  'announcepurple',
])
function isNonEchoingCommand(text) {
  if (typeof text !== 'string' || text[0] !== '/') return false
  const m = text.match(/^\/(\w+)/)
  return !!m && NON_ECHOING_CHAT_COMMANDS.has(m[1].toLowerCase())
}

function registerPendingSend({ text, channel, platforms, replyParentId, replyUser, noEcho }) {
  const synthId = makeSynthId()
  const entry = {
    synthId,
    text,
    channel,
    platforms,
    // Per-platform confirmation gate. Drains as echoes arrive; entry is only
    // dismissed when empty. Catches dual-send silent-drop of one platform.
    awaiting: new Set(platforms),
    replyParentId,
    // Reply author survives into the retry path — the yt leg rebuilds its
    // @mention from it (ytReplyText); msgId alone can't recover the name.
    replyUser: replyUser || null,
    sentAt: Date.now(),
    state: 'pending',
    noEcho: !!noEcho,
    timer: null,
  }
  entry.timer = cleanup.setTimeout(() => {
    const e = pendingSends.get(synthId)
    if (e?.state !== 'pending') return
    // Non-echoing platform commands get no PRIVMSG echo — the write already
    // succeeded, so retire silently rather than firing a false no_echo. Genuine
    // write failures still surface via the explicit markPendingFailed calls in
    // the send paths (auth_failed/send_failed).
    if (e.noEcho) {
      pendingSends.delete(synthId)
      return
    }
    markPendingFailed(synthId, 'no_echo')
  }, PENDING_ECHO_TIMEOUT_MS)
  pendingSends.set(synthId, entry)
  if (MC_DEBUG)
    try {
      console.log(
        '[heatsync-ext] pending registered:',
        JSON.stringify({
          text,
          channel,
          platforms,
          len: text.length,
          codes: [...text].slice(0, 30).map((c) => c.charCodeAt(0)),
        }),
      )
    } catch (_) {}
  return synthId
}

function confirmPending(synthId, platform) {
  const entry = pendingSends.get(synthId)
  if (!entry) return false
  if (platform) entry.awaiting.delete(platform)
  // Only dismiss once every awaited platform has echoed. Calls without a
  // platform arg (legacy/manual confirm paths) collapse the gate immediately.
  if (platform && entry.awaiting.size > 0) return true
  if (entry.timer) cleanup.clearTimeout(entry.timer)
  pendingSends.delete(synthId)
  try {
    HsNotifs.dismissByKey('send-pending', `send-pending:${synthId}`)
  } catch (_) {}
  return true
}

// Find a pending entry matching this echo text. Called from main.js's
// own-echo handlers. Tries exact match first; falls back to whitespace-
// normalized match (collapses NBSP/tabs/runs of spaces) which catches cases
// where the input serializer added/stripped a space the echo didn't, e.g.
// wysiwyg-chip + trailing text-node combinations.
function findPendingByEchoText(text) {
  if (!text || !pendingSends.size) return null
  for (const [id, entry] of pendingSends) {
    if (entry.state !== 'pending') continue
    if (_echoTextMatches({ text: entry.text, reply: !!entry.replyParentId }, text)) return id
  }
  const norm = (s) =>
    _unkickEmotes(s)
      .replace(/[ \s]+/g, ' ')
      .trim()
  const wantN = norm(text)
  if (!wantN) return null
  for (const [id, entry] of pendingSends) {
    if (entry.state !== 'pending') continue
    if (norm(entry.text) === wantN) return id
    // Reply echoes carry twitch's server-side "@login " prefix — match the
    // normalized remainder too (mirrors _echoTextMatches, reply entries only).
    if (entry.replyParentId && norm(text.replace(/^@\S+\s+/, '')) === norm(entry.text)) return id
  }
  if (MC_DEBUG)
    try {
      const dump = []
      for (const [, entry] of pendingSends) {
        if (entry.state !== 'pending') continue
        dump.push({
          pendingText: entry.text,
          pendingLen: entry.text.length,
          pendingCodes: [...entry.text].slice(0, 30).map((c) => c.charCodeAt(0)),
          pendingChannel: entry.channel,
        })
      }
      console.log(
        '[heatsync-ext] echo text-miss:',
        JSON.stringify({
          echoText: text,
          echoLen: text.length,
          echoCodes: [...text].slice(0, 30).map((c) => c.charCodeAt(0)),
          pending: dump,
        }),
      )
    } catch (_) {}
  return null
}

// Channel+username fallback. Called when text-match misses. Drains the
// oldest pending send for the given channel — Twitch echoes own PRIVMSGs
// back via the BG anon socket as broadcast-to-all, so a PRIVMSG with our
// own display-name arriving for a channel we have pending sends to means
// SOMETHING posted. Resolves the dominant false-positive class where text
// shape diverged between registration and echo (NBSP/serializer ordering).
function findPendingByChannelFifo(channel) {
  if (!channel || !pendingSends.size) return null
  const target = String(channel).toLowerCase().replace(/^#/, '')
  let bestId = null
  let bestSentAt = Infinity
  for (const [id, entry] of pendingSends) {
    if (entry.state !== 'pending') continue
    if (String(entry.channel).toLowerCase() !== target) continue
    if (entry.sentAt < bestSentAt) {
      bestId = id
      bestSentAt = entry.sentAt
    }
  }
  return bestId
}
try {
  globalThis.__hsFindPendingByChannelFifo = findPendingByChannelFifo
} catch (_) {}

function markPendingFailed(synthId, reason) {
  const entry = pendingSends.get(synthId)
  if (!entry) return
  if (entry.timer) cleanup.clearTimeout(entry.timer)
  entry.state = 'failed'
  entry.reason = reason
  if (reason === 'no_echo' && MC_DEBUG) {
    console.warn('[heatsync-ext] send no_echo:', {
      text: entry.text,
      channel: entry.channel,
      awaiting: [...entry.awaiting],
      elapsed: Date.now() - entry.sentAt,
    })
  }
  // Surface the persistent retry notif. dedupeKey=synthId so retry-then-fail-
  // again replaces in place rather than stacking.
  try {
    HsNotifs.emit('send-pending', {
      synthId,
      text: entry.text,
      channel: entry.channel,
      reason,
      // Unconfirmed platforms at failure time — lets the notif name WHICH
      // platform didn't confirm instead of always blaming twitch.
      platforms: [...entry.awaiting],
    })
  } catch (_) {}
  // Bound retention: dismissing/expiring the retry toast has no cleanup hook,
  // so never-retried failures would pile up holding message text. Evict the
  // oldest FAILED entries beyond the cap (kept only for retry) — recent ones a
  // user might still retry stay, and in-flight 'pending' entries are untouched.
  if (pendingSends.size > PENDING_SENDS_MAX) {
    for (const [id, e] of pendingSends) {
      if (id === synthId || e.state !== 'failed') continue
      pendingSends.delete(id)
      try {
        HsNotifs.dismissByKey('send-pending', `send-pending:${id}`)
      } catch (_) {}
      if (pendingSends.size <= PENDING_SENDS_MAX) break
    }
  }
}

// Clear pending sends to a channel WITHOUT firing the no_echo toast — used
// when auth-irc's NOTICE handler already showed a specific rejection toast
// (followers-only/slow-mode/banned/etc). Without this, the user got two toasts
// for the same failure: the specific reason immediately, then "no echo from
// platform" 12-20s later. Now the rejection toast is the only signal.
function clearPendingByChannel(channel) {
  if (!channel) return 0
  const target = String(channel).toLowerCase().replace(/^#/, '')
  let cleared = 0
  for (const [id, entry] of pendingSends) {
    if (entry.state !== 'pending') continue
    if (String(entry.channel).toLowerCase() === target) {
      if (entry.timer) cleanup.clearTimeout(entry.timer)
      pendingSends.delete(id)
      try {
        HsNotifs.dismissByKey('send-pending', `send-pending:${id}`)
      } catch (_) {}
      cleared++
    }
  }
  return cleared
}
try {
  globalThis.__hsClearPendingByChannel = clearPendingByChannel
} catch (_) {}

function retryPendingSend(synthId) {
  const entry = pendingSends.get(synthId)
  if (!entry) return
  // Drop the failed entry; sendMessage will register a fresh one.
  pendingSends.delete(synthId)
  try {
    HsNotifs.dismissByKey('send-pending', `send-pending:${synthId}`)
  } catch (_) {}
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  // Restore text into input. wysiwygEnabled is the same flag sendMessage uses.
  if (wysiwygEnabled) restoreWysiwygText(input, entry.text)
  else input.value = entry.text
  // Restore reply state if the original was a reply
  if (entry.replyParentId) {
    try {
      replyState = { msgId: entry.replyParentId, user: entry.replyUser || undefined }
    } catch (_) {}
  }
  sendMessage()
}

// Expose for the notif action handler
try {
  globalThis.__hsRetryPendingSend = retryPendingSend
} catch (_) {}

// Autocomplete state (Tab-only cycling, no dropdown)
const acState = {
  matches: [],
  index: 0,
  active: false, // true when cycling through matches
  wordStart: 0, // Position where the completion word starts
  afterText: '', // Text after the completion
  _frecBumped: null, // emote bumped this session — reverted if the user cycles past it
  search: '', // search term that produced these matches (remote-fetch guard)
  remoteDone: false, // 7tv fallback already merged for this search
  remotePending: false, // a lazy remote fetch is in flight for this search
}

// Emotes surfaced via remote (7TV/BTTV/FFZ) Tab-search this session: name → {url,
// source}. On send, any of these present in the outgoing message that aren't yet
// in the viewer's set get auto-added — so a remote emote you searched and sent
// becomes yours and renders next time. Bounded; explicit tracking beats sniffing
// chips so it works in plain-text mode too.
const recentRemoteCompletions = new Map()
const REMOTE_COMPLETION_CAP = 300

// Register a Tab-completed emote for auto-add-on-send. Covers the LOCAL-match
// path that fetchRemoteEmoteMatches misses: an aliased channel/global 7TV/BTTV/FFZ
// emote tab-completes as a local hit, never enters the registry, and so renders
// live (channel context) but vanishes after refresh because it was never added
// to the viewer's heatsync set. Gated to third-party providers with a URL —
// owned/blocked/pending are filtered later in autoAddInputEmotes.
function trackCompletionForAutoAdd(match) {
  if (match?.type !== 'emote' || !match.name || !match.url) return
  // A synthesized "name0" overlay carries the BASE emote's url — auto-adding it
  // persisted a bogus literal "name0" emote server-side, burning an inventory
  // slot. The base emote is tracked on its own; the "0" is a render convention.
  if (match._synthOverlay) return
  const src = match.source
  if (src !== '7tv' && src !== 'bttv' && src !== 'ffz') return
  recentRemoteCompletions.delete(match.name)
  // Carry zeroWidth so optimistic viewerPersonalEmotes.set and the server add
  // both inherit the overlay flag — without it, a tab-completed 7TV overlay
  // emote (CarrotTime, wavE) renders as a standalone base after auto-add.
  recentRemoteCompletions.set(match.name, { url: match.url, source: src, zeroWidth: !!match.zeroWidth })
  while (recentRemoteCompletions.size > REMOTE_COMPLETION_CAP) {
    recentRemoteCompletions.delete(recentRemoteCompletions.keys().next().value)
  }
}

// Register a CLICK-pasted chat-row/picker emote for auto-add-on-send. The
// 2-state design promises "click pastes, auto-add commits the slot at send" —
// but only Tab-complete/dropdown paths registered, so clicking an emote you
// don't own (e.g. another sender's personal emote rendered in a row) pasted a
// chip that rendered locally via the optimistic viewerPersonalEmotes seed yet
// committed NOTHING at send: image for you, raw text for every other viewer.
function registerClickPasteForAutoAdd(emoteName, emoteUrl, source) {
  if (!emoteName || !emoteUrl) return
  // Trailing-0 with no literal entry anywhere = synthetic "name0" overlay of
  // the base emote — registering it would auto-add a bogus literal name0
  // emote server-side (same guard as trackCompletionForAutoAdd._synthOverlay).
  if (emoteName.length > 1 && emoteName.endsWith('0')) {
    const literal =
      (typeof lookupEmoteRenderOrder === 'function' && lookupEmoteRenderOrder(emoteName)) ||
      (typeof senderEmoteSets !== 'undefined' &&
        [...senderEmoteSets.values()].some((m) => {
          const e = m.get(emoteName)
          return e && !e.removedAt
        }))
    if (!literal) return
  }
  // Zero-width recovery: viewer caches strip the flag on owned copies
  // (identity-checked), and a sender-set overlay emote isn't in viewer caches
  // at all — sweep sender sets by asset id so the add inherits the flag
  // (losing it renders a stacked overlay as a standalone base after auto-add).
  let zw = typeof zeroWidthForSameAsset === 'function' && zeroWidthForSameAsset(emoteName, emoteUrl)
  if (!zw && typeof senderEmoteSets !== 'undefined' && typeof _hsEmoteAssetId === 'function') {
    const aid = _hsEmoteAssetId(emoteUrl)
    if (aid) {
      for (const m of senderEmoteSets.values()) {
        const e = m.get(emoteName)
        if (e?.zeroWidth && _hsEmoteAssetId(e.url) === aid) {
          zw = true
          break
        }
      }
    }
  }
  trackCompletionForAutoAdd({ type: 'emote', name: emoteName, url: emoteUrl, source, zeroWidth: !!zw })
}

// Native twitch chat parity: autocomplete-hook.js (MAIN world) relays remote
// 7TV completions the user actually SENT through native chat. That world has
// no nonce access (same constraint as content.js's heatsync-native-emotes
// handler) — strict payload validation instead: emote-CDN-only urls, safe
// name charset, provider allowlist, hard cap. Validated entries route through
// recentRemoteCompletions + autoAddInputEmotes, so the exact owned/blocked/
// pending/global guards, optimistic own-set entry, and failure rollback the
// overlay send path uses apply here too.
if (/(^|\.)twitch\.tv$/.test(location.hostname)) {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    if (event.data?.type !== 'heatsync-remote-completion-used' || !Array.isArray(event.data.emotes)) return
    const CDN_RE = /^https:\/\/(cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com)\//
    const NAME_RE = /^[A-Za-z0-9_:\-()]+$/
    const names = []
    for (const e of event.data.emotes.slice(0, 20)) {
      if (!e || typeof e.name !== 'string' || e.name.length < 2 || e.name.length > 64) continue
      if (!NAME_RE.test(e.name) || typeof e.url !== 'string' || !CDN_RE.test(e.url)) continue
      if (e.source !== '7tv' && e.source !== 'bttv' && e.source !== 'ffz') continue
      recentRemoteCompletions.delete(e.name)
      recentRemoteCompletions.set(e.name, { url: e.url, source: e.source, zeroWidth: !!e.zeroWidth })
      names.push(e.name)
    }
    while (recentRemoteCompletions.size > REMOTE_COMPLETION_CAP) {
      recentRemoteCompletions.delete(recentRemoteCompletions.keys().next().value)
    }
    if (names.length) autoAddInputEmotes(names.join(' '))
  })
}

// Infinite Tab-cycle: once local matches run out, pull more from the cross-provider
// search APIs and append. Aborts stale fetches so rapid re-triggering never
// merges results from an old search term.
//
// Provider quality for prefix expansion (verified empirically on 'sad'):
//  - FFZ: prefix-relevance search, sorted by usage_count. Best signal.
//  - BTTV: prefix-relevance, ordered by internal popularity. Solid.
//  - 7TV: exact-text-match flood — `query:"sad"` returns 150 emotes literally
//    named "sad" from different creators. Useless for prefix expansion of
//    common stems; kept for unique uploads on less common terms.
// Quality order at merge: FFZ → BTTV → 7TV.
// Prefix-only on purpose: catalog substring hits (NotSad, KekSadge) are noise.
// Local substring matches still surface via findEmoteMatches.
let _acRemoteAbort = null
let _acRemoteToken = 0
// Searches the remote catalog will never serve: @user, :emoji, modifier
// tokens, short fragments. Shared with the Tab-cycle hold-at-end check —
// without this, @/: cycles held at the last match forever waiting on a
// remote fetch that always bails (bare-emote cycling wrapped, these didn't).
function acRemoteEligible(search) {
  if (!search || search.length < 2) return false
  if (search.startsWith('@') || search.startsWith(':')) return false
  if (hsModClassify(search, { allowPrefix: false }).kind === 'modifier') return false
  return true
}
// Paged catalog cycling: each call pulls the NEXT page from every provider
// that still has one. remoteDone flips only when all providers are exhausted
// (or the match list hits the cap) — until then the cycle holds at the end
// instead of wrapping, and approaching the end pulls another page. Without
// pagination, popular prefixes were a dead end: page 1 sorted by all-time top
// is mostly emotes the user already has loaded, the dedupe dropped every hit,
// and the cycle wrapped back to 1/N as if the catalog had nothing.
const AC_REMOTE_LOOKAHEAD = 5 // start fetching this many matches BEFORE the end
const AC_REMOTE_MAX_MATCHES = 1000 // total cycle size cap
const AC_REMOTE_CHASE_PAGES = 4 // consecutive all-duplicate pages before giving up the trigger
async function fetchRemoteEmoteMatches(search) {
  // Emote-only: skip @user, :emoji, modifier tokens, and short fragments.
  if (!acRemoteEligible(search)) return
  if (acState.matches.length >= AC_REMOTE_MAX_MATCHES) {
    acState.remoteDone = true
    return
  }
  const token = ++_acRemoteToken
  acState.remotePending = true
  if (_acRemoteAbort) {
    try {
      _acRemoteAbort.abort()
    } catch (_) {}
  }
  const ac = new AbortController()
  _acRemoteAbort = ac
  // Per-provider page sizes must match what the mcSearch*Api calls request —
  // a short page is the exhaustion signal (no next page worth asking for).
  const sizes = typeof MC_PAGE_SIZE !== 'undefined' ? MC_PAGE_SIZE : { ffz: 200, bttv: 100 }
  const ex = acState._remoteExhausted || (acState._remoteExhausted = { ffz: false, bttv: false, stv: false })
  const searchLower = search.toLowerCase()
  // Chase: an all-duplicate page (top catalog hits collide with loaded locals)
  // is not the end of the catalog — keep paging a bounded number of times
  // until something NEW appears or every provider runs dry.
  for (let chase = 0; chase < AC_REMOTE_CHASE_PAGES; chase++) {
    if (ex.ffz && ex.bttv && ex.stv) break
    const page = (acState._remotePage || 0) + 1
    const calls = [
      !ex.ffz && typeof mcSearchFfzApi === 'function'
        ? mcSearchFfzApi(search, ac.signal, { page })
        : Promise.resolve(null),
      !ex.bttv && typeof mcSearchBttvApi === 'function'
        ? mcSearchBttvApi(search, ac.signal, { page })
        : Promise.resolve(null),
      !ex.stv && typeof mcSearch7tvApi === 'function'
        ? mcSearch7tvApi(search, ac.signal, { page, perPage: 60 })
        : Promise.resolve(null),
    ]
    const settled = await Promise.allSettled(calls)
    if (ac.signal.aborted || token !== _acRemoteToken) return
    // Cycling must still be on the same search the fetch was issued for.
    if (!acState.active || acState.search !== search) {
      acState.remotePending = false
      return
    }
    acState._remotePage = page
    // Short page → that provider has no next page for this search. Provider
    // errors also stop that provider — retrying a failing API on every
    // trigger helps nobody (the others keep paging).
    const drain = (idx, key, pageSize) => {
      if (ex[key]) return []
      const s = settled[idx]
      if (s?.status !== 'fulfilled' || !Array.isArray(s.value)) {
        ex[key] = true
        return []
      }
      if (s.value.length < pageSize) ex[key] = true
      return s.value
    }
    const rf = drain(0, 'ffz', sizes.ffz || 200)
    const rb = drain(1, 'bttv', sizes.bttv || 100)
    const r7 = drain(2, 'stv', 60)
    // FFZ's `uses` is real popularity — sort descending so the merged stream
    // leads with highest-use FFZ emotes first.
    rf.sort((a, b) => (b.uses || 0) - (a.uses || 0))
    // 7TV leads — its relevance ranking IS the culture ("pls" → the dancing
    // XxxPls family), then BTTV, then FFZ-by-uses (the oldest catalog trails).
    // The old FFZ-first + prefix-only combo made catalog cycling feel dead:
    // every "…Pls"/"…JAM" suffix-named emote was filtered out and FFZ prefix
    // junk led whatever survived.
    const items = [...r7, ...rb, ...rf]
    // Lowercase dedupe (collapses 10x "Sadge" uploads to one — emote names are
    // case-insensitive in practice; first-seen wins so 7TV's top result holds).
    // Also dedupes against existing locals (already lowercased below).
    const have = new Set(acState.matches.map((m) => (m.name || '').toLowerCase()))
    const add = []
    for (const it of items) {
      if (!it.name) continue
      const lower = it.name.toLowerCase()
      if (have.has(lower)) continue
      // Substring is fine — the providers already relevance-matched the query;
      // requiring a literal prefix dropped the suffix-named families users
      // actually mean. Drop only fuzzy hits that don't contain the query.
      if (!lower.includes(searchLower)) continue
      // A blocked name must never surface from the remote catalog either —
      // same leak as the local pool, just a different source.
      if (typeof _hsAcEmoteBlocked === 'function' && _hsAcEmoteBlocked(it.name, null)) continue
      have.add(lower)
      const src = it.provider || '7tv'
      add.push({
        name: it.name,
        url: it.url,
        source: src,
        priority: 0,
        type: 'emote',
        remote: true,
        zeroWidth: !!it.zeroWidth,
        // Persistent sequence, NOT add.length — page 2's counter restarting
        // at 0 would interleave it into page 1 on sort ties instead of after.
        _ai: acState._aiSeq++,
      })
      // Auto-add-on-send registry: ONLY the emote whose name the user literally
      // typed. Everything they cycle onto registers through
      // insertCompletionKeepOpen → trackCompletionForAutoAdd, so this covers the
      // one case that path can't: the full name typed out and sent without ever
      // pressing Tab past the first hit.
      //
      // Registering the whole fetched page (what this used to do) meant every
      // word in a sent message that happened to appear anywhere in a catalog
      // search this session got silently added to the viewer's inventory —
      // hundreds of names the user never saw, burning finite slots. Harmless
      // while the fetch was lazy; not once it fires on the first Tab.
      if (lower === searchLower) {
        recentRemoteCompletions.delete(it.name)
        recentRemoteCompletions.set(it.name, { url: it.url, source: src, zeroWidth: !!it.zeroWidth })
        while (recentRemoteCompletions.size > REMOTE_COMPLETION_CAP) {
          recentRemoteCompletions.delete(recentRemoteCompletions.keys().next().value)
        }
      }
    }
    if (add.length) {
      _acMergeRemoteMatches(add, searchLower)
      break // got new content; the next page fetches as the user nears the new end
    }
    // all duplicates — chase the next page
  }
  // Clear the in-flight flag on every exit path so a bailed fetch can't leave
  // "searching 7tv…" stuck on — but only if a newer fetch hasn't taken over
  // (token bumped), in which case that fetch now owns the flag.
  if (token === _acRemoteToken) acState.remotePending = false
  // Done only when there is truly nothing left to page through — the cycle
  // then wraps at the end like any finite list.
  if ((ex.ffz && ex.bttv && ex.stv) || acState.matches.length >= AC_REMOTE_MAX_MATCHES) {
    acState.remoteDone = true
  }
  showCycleTooltip() // refresh the N/M denominator / clear the searching state
}

// Append freshly-fetched catalog hits into the live cycle WITHOUT re-sorting
// what the user has already cycled through. A full-list re-sort let a remote
// exact-name hit jump above the current position — the tooltip ran BACKWARDS
// (4/4 → 2/70) and every ordinal the user had seen reshuffled under them.
// Append-only: existing entries never move, so N/M only ever grows forward;
// the new block is ordered internally (exact match first, then fetch order:
// FFZ-by-uses → BTTV → 7TV, pages in sequence via the persistent _ai).
function _acMergeRemoteMatches(add, searchLower) {
  const wasEmpty = acState.matches.length === 0
  add.sort((a, b) => {
    const ax = (a.name || '').toLowerCase() === searchLower ? 0 : 1
    const bx = (b.name || '').toLowerCase() === searchLower ? 0 : 1
    if (ax !== bx) return ax - bx
    return (a._ai || 0) - (b._ai || 0)
  })
  acState.matches.push(...add.slice(0, Math.max(0, AC_REMOTE_MAX_MATCHES - acState.matches.length)))
  // wasEmpty — no local match existed when Tab was pressed, so this remote
  // fetch fired immediately; insert the first remote hit now. (The lazy case
  // needs nothing: append-only means the user's chip and index are untouched.)
  if (wasEmpty && acState.matches.length > 0) {
    acState.index = 0
    insertCompletionKeepOpen(acState.matches[0])
  }
  showCycleTooltip() // refresh the N/M denominator
}

// bareLowerName → original-cased username, for recent-chatter completion
// (findEmoteMatches below). Maintained incrementally by main.js's
// addUsername — the sole writer of usernameCache — instead of being rebuilt
// by iterating the full (up to 5000-entry) cache on every keystroke.
const _ucDisplay = new Map()

// Colon-triggered dropdown state (":kap" — emotes + emoji, chatterino parity).
// matches holds findEmoteMatches() results (type 'emote' | 'emoji'), already
// ranked by the shared compareAcMatches comparator — same ranking Tab-cycle
// uses, just rendered as a live list instead of one-at-a-time.
const emojiAcState = {
  active: false,
  matches: [],
  index: 0,
  query: '',
}
let _emojiAcDebounce = null
// Cap the visible list — findEmoteMatches can return dozens of hits; the
// dropdown scrolls (max-height in CSS) but there's no value in rendering
// hundreds of offscreen rows.
const EMOJI_DROPDOWN_MAX = 30

// @-triggered username dropdown state ("@so" — recent chatters first, then
// the rest of usernameCache). Same shape/lifecycle as emojiAcState above.
const mentionAcState = {
  active: false,
  matches: [],
  index: 0,
  query: '',
}
let _mentionAcDebounce = null
const MENTION_DROPDOWN_MAX = 20

// Slash command autocomplete dropdown — shows command list when input begins
// with /<word>. Heatsync-owned + common pass-through Twitch/Kick mod commands.
const SLASH_COMMANDS = [
  { cmd: 'op', args: '<text>', desc: 'post to home feed' },
  { cmd: 'opr', args: '<text>', desc: 'reply to the last [OP] shown in chat' },
  { cmd: 'w', args: '<user> <msg>', desc: 'twitch whisper' },
  { cmd: 'dm', args: '<user> <msg>', desc: 'heatsync DM' },
  { cmd: 'r', args: '<msg>', desc: 'reply to last whisper' },
  { cmd: 'follow', args: '<user>', desc: 'follow on heatsync (+ twitch/kick mirror)' },
  { cmd: 'unfollow', args: '<user>', desc: 'unfollow on heatsync (+ twitch/kick mirror)' },
  { cmd: 'mute', args: '<user>', desc: 'local mute 24h' },
  { cmd: 'unmute', args: '<user>', desc: 'local unmute' },
  { cmd: 'shrug', args: '[text]', desc: 'append ¯\\_(ツ)_/¯' },
  { cmd: 'tableflip', args: '[text]', desc: 'append (╯°□°)╯︵ ┻━┻' },
  { cmd: 'unflip', args: '[text]', desc: 'append ┬─┬ノ( ゜-゜ノ)' },
  { cmd: 'lclear', args: '', desc: 'clear current tab locally' },
  { cmd: 'status', args: '[channel]', desc: 'show chat modes + stream info' },
  { cmd: 'help', args: '', desc: 'list commands' },
  { cmd: 'me', args: '<action>', desc: 'twitch/kick action message' },
  { cmd: 'highlight', args: '<msg>', desc: 'highlight your message (twitch bits power-up)' },
  { cmd: 'ban', args: '<user>', desc: 'twitch/kick ban (mod)' },
  { cmd: 'timeout', args: '<user> [secs]', desc: 'twitch/kick timeout (mod)' },
  { cmd: 'unban', args: '<user>', desc: 'twitch/kick unban (mod)' },
  { cmd: 'untimeout', args: '<user>', desc: 'twitch/kick untimeout (mod)' },
  { cmd: 'delete', args: '<msg-id>', desc: 'delete one message (mod)' },
  { cmd: 'nuke', args: '<term> [secs]', desc: 'bulk-delete matching messages (mod)' },
  { cmd: 'announce', args: '<msg>', desc: 'twitch announcement (mod, +blue/green/orange/purple)' },
  { cmd: 'slow', args: '[secs|off]', desc: 'slow mode (twitch mod)' },
  { cmd: 'followers', args: '[mins|off]', desc: 'followers-only (twitch mod)' },
  { cmd: 'emoteonly', args: '[off]', desc: 'emote-only mode (twitch mod)' },
  { cmd: 'subscribers', args: '[off]', desc: 'subs-only mode (twitch mod)' },
  { cmd: 'unique', args: '[off]', desc: 'unique-chat/r9k (twitch mod)' },
  { cmd: 'poll', args: '<q> | <a> | <b> [| …] [| secs]', desc: 'create a poll (twitch broadcaster)' },
  { cmd: 'endpoll', args: '', desc: 'end the active poll (twitch broadcaster)' },
  { cmd: 'vote', args: '<n>', desc: 'vote for choice n in the active poll (twitch)' },
  { cmd: 'prediction', args: '<title> | <a> | <b> [| …] [| secs]', desc: 'start a prediction (twitch broadcaster)' },
  { cmd: 'bet', args: '<n> <points>', desc: 'bet points on prediction outcome n (twitch)' },
  { cmd: 'lockpred', args: '', desc: 'lock the active prediction (twitch broadcaster)' },
  { cmd: 'resolvepred', args: '<n>', desc: 'resolve the prediction to outcome n (twitch broadcaster)' },
  { cmd: 'cancelpred', args: '', desc: 'cancel the active prediction (twitch broadcaster)' },
  { cmd: 'note', args: '<user> <text>', desc: 'save a private note on a user' },
  { cmd: 'delnote', args: '<user>', desc: 'remove your note on a user' },
  { cmd: 'block', args: '<user>', desc: 'toggle block for a user' },
  { cmd: 'hide', args: '<user>', desc: 'hide a user in THIS tab only (ephemeral)' },
  { cmd: 'unhide', args: '<user>', desc: 'unhide a user in this tab' },
  { cmd: 'set', args: '<setting> <value>', desc: 'change a setting (e.g. /set zebra off, /set fontsize 15)' },
  { cmd: 'tab', args: '<name>', desc: 'switch tab (live/feed/mentions/whispers/settings or a channel)' },
  { cmd: 'vip', args: '<user>', desc: 'VIP a user (twitch broadcaster)' },
  { cmd: 'unvip', args: '<user>', desc: 'remove a user VIP (twitch broadcaster)' },
  { cmd: 'mod', args: '<user>', desc: 'mod a user (twitch broadcaster)' },
  { cmd: 'unmod', args: '<user>', desc: 'unmod a user (twitch broadcaster)' },
]
const slashAcState = { active: false, matches: [], index: 0 }

// vi-mode (chrome/vi-mode.js, same isolated world) asks this before treating
// Escape as enter-normal-mode. Every composer overlay closes on Escape via
// its own handler — vi's window-capture intercept starved them all: the
// dropdown stayed open, the user got dumped into normal mode mid-message,
// and the next letters silently ran as vim motions. Any new Escape-owning
// overlay must add its open-state here.
window.__hsEscOwned = () => {
  try {
    if (emojiAcState.active || mentionAcState.active || slashAcState.active || acState.active) return true
    if (typeof replyState !== 'undefined' && replyState) return true
    const picker = document.getElementById('hs-mc-emote-picker')
    if (picker && picker.offsetParent !== null) return true
    if (document.getElementById('hs-mc-msg-ctx')) return true
  } catch (_) {}
  return false
}

// Per-injection wiring token for DOM-expando install-once guards (composer
// input, emote button). Each script evaluation mints its own; a node marked
// with a DIFFERENT token was wired by a previous, now-dead extension context
// (firefox AMO-update reinjection adopts the old DOM) and must be rewired.
const MC_WIRE_CTX = `hs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function rebuildInput() {
  const bar = document.getElementById('hs-mc-inputbar')
  if (!bar) return

  // Save current text
  const oldInput = document.getElementById('hs-mc-input')
  const savedText = oldInput ? getInputText() : pendingMessage

  // Remove old input and its wrap/highlight overlay (created by updateCharCount for plain <input>)
  const oldWrap = document.getElementById('hs-mc-input-wrap')
  if (oldWrap) oldWrap.remove()
  const oldHighlight = document.getElementById('hs-mc-input-highlight')
  if (oldHighlight) oldHighlight.remove()
  if (oldInput) oldInput.remove()

  // Create new input element
  const emoteBtn = bar.querySelector('#hs-mc-emote-btn')
  if (wysiwygEnabled) {
    const div = document.createElement('div')
    div.id = 'hs-mc-input'
    div.contentEditable = 'true'
    div.setAttribute('data-placeholder', t('mc_input_send_message'))
    div.spellcheck = false
    if (emoteBtn) bar.insertBefore(div, emoteBtn)
  } else {
    const input = document.createElement('input')
    input.type = 'text'
    input.id = 'hs-mc-input'
    input.placeholder = t('mc_input_send_message')
    input.autocomplete = 'off'
    input.spellcheck = false
    if (emoteBtn) bar.insertBefore(input, emoteBtn)
  }

  // Restore text and reinit
  const newInput = document.getElementById('hs-mc-input')
  if (newInput && savedText) {
    if (wysiwygEnabled) {
      newInput.textContent = savedText
    } else {
      newInput.value = savedText
    }
  }
  initInput()
  updateCharCount()
}

/**
 * Create unified input bar - ALWAYS visible, text persists across tabs
 */
function createInputBar() {
  const bar = document.createElement('div')
  bar.id = 'hs-mc-inputbar'
  const iconUrl = chrome.runtime.getURL('icon-48.png')
  const iconBlackUrl = chrome.runtime.getURL('icon-48-black.png')

  const inputHtml = wysiwygEnabled
    ? `<div id="hs-mc-input" contenteditable="true" data-placeholder="${t('mc_input_send_message')}" spellcheck="false"></div>`
    : `<input type="text" id="hs-mc-input" placeholder="${t('mc_input_send_message')}" autocomplete="off" spellcheck="false">`

  bar.innerHTML = `
    ${inputHtml}
    <span id="hs-mc-sendtargets"></span>
    <input type="file" id="hs-mc-attach-input" accept="image/*,video/*" hidden>
    <button id="hs-mc-attach-btn" type="button" title="${t('mc_input_attach')}" aria-label="${t('mc_input_attach')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18"></rect><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor" stroke="none"></circle><path d="M21 15l-5-5L4 21"></path></svg></button>
    <button id="hs-mc-emote-btn" title="${t('mc_input_emote_picker')}" aria-label="${t('mc_input_emote_picker')}"><img src="${iconUrl}" data-src="${iconUrl}" data-src-black="${iconBlackUrl}" alt="hs"></button>
  `

  // Initialize input after DOM insertion. Icon hover-swap lives in initInput's
  // emote-btn block (single wiring source — survives rebuild/rewire paths).
  setTimeout(() => {
    initInput()
    renderSendTargetChips()
  }, 0)
  return bar
}

/**
 * Render the composer's per-platform send-target toggle chips for the
 * active channel tab. Empty (no chips) on 0/1-linked-platform tabs and on
 * non-channel tabs (live/feed/whispers/mentions/settings/add) — those have
 * no persisted per-channel sendTargets config to toggle. Mirrors
 * renderPlatformFilterButtons' shape (main.js) but drives SEND routing
 * rather than a view-side message filter.
 */
function renderSendTargetChips() {
  const group = document.getElementById('hs-mc-sendtargets')
  if (!group) return
  while (group.firstChild) group.removeChild(group.firstChild)
  const ch = config.channels.find((c) => c.id === currentTab)
  if (!ch) return
  const linked = { twitch: !!ch.twitch, kick: !!ch.kick, youtube: !!ch.youtube }
  if (Object.values(linked).filter(Boolean).length < 2) return
  const resolved = resolveSendTargets(ch.sendTargets, linked)
  const meta = [
    { key: 'twitch', label: 'T' },
    { key: 'kick', label: 'K' },
    { key: 'youtube', label: 'Y' },
  ]
  // No text label — composer width is precious (side-tab layouts). Both T K Y
  // clusters now share ONE style (outline); they're told apart by place and
  // by this one-glyph marker: → means "where it goes". Tooltips carry the
  // words.
  const arrow = document.createElement('span')
  arrow.className = 'hs-mc-st-arrow'
  arrow.textContent = '\u2192'
  arrow.title = 'send targets'
  group.appendChild(arrow)
  for (const p of meta) {
    if (!linked[p.key]) continue
    const on = resolved[p.key]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `hs-mc-st-btn hs-mc-st-${p.key}`
    btn.classList.toggle('off', !on)
    btn.textContent = p.label
    btn.title = `send to ${p.key}: ${on ? 'on' : 'off'}`
    // Chip click must never steal focus from the composer input.
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const next = nextSendTargets(ch.sendTargets, linked, p.key, !on)
      if (!next) return // refuse to disable the last active target
      ch.sendTargets = next
      saveConfig()
      renderSendTargetChips()
    })
    group.appendChild(btn)
  }
}

// Get text from input (handles both input and contenteditable)
function getInputText() {
  const input = document.getElementById('hs-mc-input')
  if (!input) return ''
  if (wysiwygEnabled) {
    // Convert emote images, stacks, and cycling spans back to text.
    // Modifiers stored in dataset.hsWords (canonical, set by hsModApplyToImg)
    // appended after the emote so recipients see "Kappa w! h!" not "Kappa".
    let text = ''
    // Adjacency-safe serialization: chips (emote img / stack / emoji span /
    // mention) must stay whitespace-bounded on the wire — `parseEmotes` and
    // peer renderers tokenize on /\s+/, so two adjacent chips that serialize
    // as `KEKWPogChamp` resolve to nothing.
    let _lastWasChip = false
    const sepBefore = () => {
      if (text && !/\s$/.test(text)) text += ' '
    }
    const appendImg = (img) => {
      text += img.dataset.emoteName || img.alt || ''
      const modWords = img.dataset.hsWords || img.dataset.hsModWords // back-compat
      if (modWords) {
        for (const w of modWords.split(/\s+/).filter(Boolean)) text += ` ${w}`
      }
    }
    const extractNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent || ''
        if (_lastWasChip && t && !/^\s/.test(t) && text && !/\s$/.test(text)) text += ' '
        text += t
        if (t.length > 0) _lastWasChip = false
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
        sepBefore()
        appendImg(node)
        _lastWasChip = true
      } else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('hs-input-stack')) {
        sepBefore()
        let _firstStackChild = true
        for (const child of node.children) {
          if (child.tagName === 'IMG') {
            if (text && !text.endsWith(' ')) text += ' '
            appendImg(child) // emote overlays already carry "name0" in dataset.emoteName
          } else if (child.classList?.contains('hs-mc-emoji')) {
            if (text && !text.endsWith(' ')) text += ' '
            const ename = child.dataset.emojiName || child.getAttribute('data-emoji-name')
            if (!_firstStackChild && ename) {
              // Overlay emoji — emit ":name:0" so peer renderers stack it on top
              // (the unicode-char form would render beside, not over, the base).
              text += `:${ename}:0`
            } else {
              // Base emoji — unicode char (renderer treats a bare emoji as base).
              text += child.textContent || ''
            }
            const emjMods = child.dataset.hsWords
            if (emjMods) for (const w of emjMods.split(/\s+/).filter(Boolean)) text += ` ${w}`
          }
          _firstStackChild = false
        }
        _lastWasChip = true
      } else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('hs-mc-user')) {
        sepBefore()
        // Bare-username Tab completion → serialize as @user so recipients
        // render it as a colored mention chip (processEmotes only colors @-prefixed).
        const u = node.dataset.username || node.textContent || ''
        text += node.dataset.completionType === 'user-bare' ? `@${u}` : u
        _lastWasChip = true
      } else if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('hs-mc-emoji')) {
        sepBefore()
        text += node.textContent || ''
        const emjMods = node.dataset.hsWords
        if (emjMods) for (const w of emjMods.split(/\s+/).filter(Boolean)) text += ` ${w}`
        _lastWasChip = true
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        text += node.textContent || ''
      }
    }
    for (const node of input.childNodes) extractNode(node)
    return text.replace(/\u00A0/g, ' ')
  }
  return input.value || ''
}
function initInput() {
  const input = document.getElementById('hs-mc-input')
  const sendBtn = document.getElementById('hs-mc-send')
  log('🎯 initInput called, input found:', !!input)
  if (!input) {
    log('❌ Input not found in DOM yet, retrying...')
    setTimeout(initInput, 100)
    return
  }
  // Mark input as initialized to avoid duplicate handlers. The mark is a
  // per-injection token, NOT a boolean: on firefox, same-principal expandos
  // outlive the sandbox that set them, so after an AMO auto-update reinjects
  // us into an open tab, the adopted composer still wears the DEAD context's
  // mark while its listeners are gone. The old boolean guard skipped rewiring
  // and left Enter inserting newlines instead of sending. A foreign mark now
  // means dead wiring — swap in a fresh node (sheds any stale listeners in
  // one move) and let the re-entrant initInput wire it under our token.
  if (input._hsInitialized === MC_WIRE_CTX) {
    log('⚠️ Input already initialized')
    return
  }
  if (input._hsInitialized) {
    log('stale composer wiring from a previous extension context — rebuilding')
    rebuildInput()
    return
  }
  input._hsInitialized = MC_WIRE_CTX
  log('✅ Initializing input handlers, WYSIWYG:', wysiwygEnabled)

  // Restore pending message — but never clobber content already in the
  // input. Keystrokes can land before this runs (createInputBar defers via
  // setTimeout(0)); rebuildInput also pre-restores its own savedText.
  if (pendingMessage && !(input.value || input.textContent || '').trim() && !input.querySelector?.('img, span')) {
    if (wysiwygEnabled) {
      input.textContent = pendingMessage
    } else {
      input.value = pendingMessage
    }
  }

  input.addEventListener('keydown', handleInputKeydown)
  input.addEventListener('input', (e) => {
    handleInputChange(e)
    // handleInputChange keeps pendingMessage synced with the live DOM on every
    // path (initial read + after each WYSIWYG mutation branch) — reuse it
    // instead of updateCharCount re-serializing the whole input a 3rd time.
    updateCharCount(pendingMessage)
  })
  // Draft guard: ctrl+w (delete-word muscle memory) is a reserved browser
  // shortcut that closes the tab even with an input focused — pages can't
  // cancel the shortcut itself, but a beforeunload prompt while a draft is
  // in the composer turns the insta-close into a confirm dialog.
  if (!_onceGuardsInput.draftGuard) {
    _onceGuardsInput.draftGuard = (e) => {
      if (getInputText().trim()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', _onceGuardsInput.draftGuard, { signal: mcSignal })
  }
  // Unified undo/redo — same module as the website. installUndoManager
  // attaches a manager to input._undoManager and wires Ctrl+Z hotkeys
  // (capture phase) + auto-capture on input events. Per-keystroke for
  // typing, one step per structural op (Tab autocomplete, smart unwrap, etc.).
  try {
    installUndoManager(input, { max: 100 })
  } catch (_) {}
  // Tab clears emote :hover highlight in chat — mouse stuck over an emote
  // would otherwise hold the green rect lit while the user cycles autocomplete.
  // Body class restored on mousemove. Single global install via window flag.
  if (!_onceGuardsInput.tabHoverInstalled) {
    _onceGuardsInput.tabHoverInstalled = true
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Tab') return
        const ae = document.activeElement
        if (ae?.id !== 'hs-mc-input') return
        document.body.classList.add('hs-tab-cycling')
      },
      { signal: mcSignal },
    )
    document.addEventListener(
      'mousemove',
      () => {
        if (document.body.classList.contains('hs-tab-cycling')) {
          document.body.classList.remove('hs-tab-cycling')
        }
      },
      { passive: true, signal: mcSignal },
    )
  }
  // Sync highlight overlay scroll with input scroll (RAF-throttled)
  let _inputScrollRaf = null
  input.addEventListener(
    'scroll',
    () => {
      if (_inputScrollRaf) return
      _inputScrollRaf = requestAnimationFrame(() => {
        _inputScrollRaf = null
        const hl = document.getElementById('hs-mc-input-highlight')
        if (hl) hl.scrollLeft = input.scrollLeft
      })
    },
    { passive: true },
  )
  input.addEventListener('input', (e) => {
    const hasText = (input.value || input.textContent || '').trim().length > 0
    if (hasText) showInputBar()
    // mid-IME-composition empties are transient — hiding would blur and kill
    // the composition (the old focused-composer guard used to absorb these)
    else if (!e.isComposing) hideInputBar()
  })
  // A mouse click is the one caret move that fires neither keydown nor input,
  // so the Tab-cycle teardown in those handlers never runs. Finalize the cycle
  // here — otherwise the next Tab from the clicked position rewrites the
  // abandoned chip (see caretOnActiveCompletion). The caret lands after
  // mousedown's default action, so tearing down first can't misplace it.
  input.addEventListener('mousedown', () => {
    if (acState.active) hideAutocomplete()
  })
  input.addEventListener('blur', () => {
    setTimeout(hideAutocomplete, 150)
    setTimeout(hideEmojiDropdown, 150)
    setTimeout(hideMentionDropdown, 150)
    setTimeout(hideSlashDropdown, 150)
    // Sticky focus after a send: a blur that lands anywhere inside the rapid-fire
    // window (late own-echo render churn, or the host page grabbing focus) must
    // not drop the composer — reclaim it once the blur settles. reassertComposerFocus
    // backs off if the user deliberately moved to our search/settings/picker.
    if (performance.now() < _composerStickyUntil) {
      requestAnimationFrame(reassertComposerFocus)
      cleanup.setTimeout(reassertComposerFocus, 0)
    }
    // Hide input bar after blur if empty (delay to allow click-to-emote-picker)
    // Skip if window lost focus — prevents hiding when switching apps; the
    // window-focus reconciler below re-attempts once the user comes back.
    setTimeout(() => {
      if (document.hasFocus()) hideInputBar()
    }, 200)
  })

  // Auto-hide reconciler: the blur path above deliberately skips while the
  // window is unfocused (alt-tab), which used to strand an empty bar until
  // some later blur ("auto-hide only works sometimes"). Re-attempt on window
  // focus — hideInputBar's own guards (content, composer focus, picker,
  // reply, rapid-fire retry) make this a safe no-op in every other state.
  if (!_onceGuardsInput.autoHideFocusReconciler) {
    _onceGuardsInput.autoHideFocusReconciler = true
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => hideInputBar(), 200)
      },
      { signal: mcSignal },
    )
  }
  sendBtn?.addEventListener('click', sendMessage)

  // Set up drag-drop handlers for media upload
  setupMediaDropHandlers()

  // Pasted image handler — applies in BOTH wysiwyg and plain modes
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          handleMediaUpload(file, clipboardImageSourceUrl(e.clipboardData))
          return
        }
      }
    }
  })

  // WYSIWYG: handle paste to strip formatting
  if (wysiwygEnabled) {
    input.addEventListener('paste', (e) => {
      // If a previous handler already prevented default (image upload), skip
      if (e.defaultPrevented) return
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      if (!document.execCommand('insertText', false, text)) {
        // Fallback: insert via Selection/Range API
        const sel = window.getSelection()
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0)
          range.deleteContents()
          range.insertNode(document.createTextNode(text))
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
    })
  }

  // Initialize character counter
  updateCharCount()

  // Attach button → hidden file picker → existing upload pipeline (same as
  // paste/drop: uploads then inserts the URL into the composer, which
  // postFeedMessage/sendMessage pick up as media). Clone-rewire guard mirrors
  // the emote-btn block below (sheds dead listeners from a stale ext context).
  let attachBtn = document.getElementById('hs-mc-attach-btn')
  if (attachBtn && attachBtn._hsInitialized && attachBtn._hsInitialized !== MC_WIRE_CTX) {
    const fresh = attachBtn.cloneNode(true)
    attachBtn.replaceWith(fresh)
    attachBtn = fresh
  }
  if (attachBtn && !attachBtn._hsInitialized) {
    attachBtn._hsInitialized = MC_WIRE_CTX
    const fileInput = document.getElementById('hs-mc-attach-input')
    attachBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      fileInput?.click()
    })
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      // Reset first so picking the SAME file twice re-fires change.
      fileInput.value = ''
      // No source url, stated rather than omitted: a file picked off disk has
      // no clipboard behind it, so there is nothing to recover the original from
      // — and the picked file already IS the original.
      if (file) handleMediaUpload(file, '')
    })
  }

  // Emote picker button (includes twitch features in tabs)
  let emoteBtn = document.getElementById('hs-mc-emote-btn')
  // Foreign mark = wired by a dead extension context (same firefox trap as the
  // composer mark above). Clone-replace sheds the dead listeners, then rewire.
  if (emoteBtn?._hsInitialized && emoteBtn._hsInitialized !== MC_WIRE_CTX) {
    const fresh = emoteBtn.cloneNode(true)
    emoteBtn.replaceWith(fresh)
    emoteBtn = fresh
  }
  if (emoteBtn && !emoteBtn._hsInitialized) {
    emoteBtn._hsInitialized = MC_WIRE_CTX
    const btnImg = emoteBtn.querySelector('img')
    if (btnImg?.dataset.srcBlack) {
      emoteBtn.addEventListener('mouseenter', () => {
        btnImg.src = btnImg.dataset.srcBlack
      })
      emoteBtn.addEventListener('mouseleave', () => {
        btnImg.src = btnImg.dataset.src
      })
    }
    emoteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const picker = document.getElementById('hs-mc-emote-picker')
      if (picker?.classList.contains('visible')) {
        picker.classList.remove('visible')
        hideInputBar()
        if (_pickerCloseHandler) {
          document.removeEventListener('click', _pickerCloseHandler)
          _pickerCloseHandler = null
        }
      } else {
        showEmotePicker()
      }
    })
  }

  // Update placeholder based on current tab
  updateInputPlaceholder()

  // Track whether the user's last pointer interaction landed inside the
  // multichat overlay. Clicking a non-focusable chat row leaves document focus
  // on whatever host-page element had it, so "click the overlay, press Tab"
  // otherwise gets refused by the don't-steal-from-host-inputs guard below.
  // This lets Tab snap to the composer when the user is clearly IN our overlay,
  // while still respecting a host input they're actively typing in.
  if (!_onceGuardsInput.pointerRegion) {
    _onceGuardsInput.pointerRegion = true
    document.addEventListener(
      'pointerdown',
      (e) => {
        window._hsMcLastInOverlay = !!e.target?.closest?.('#hs-mc-container, #hs-mc-overlay')
      },
      { capture: true, passive: true, signal: mcSignal },
    )
  }

  // Global Tab key to focus input — only when multichat panel is active
  if (!_onceGuardsInput.tabHandler) {
    _onceGuardsInput.tabHandler = true
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Tab') return
        if (!tabAcceptsInput(currentTab)) return
        const active = document.activeElement
        const input = document.getElementById('hs-mc-input')
        if (!input) return
        // Don't steal Tab from other real inputs (except Twitch's chat input) —
        // UNLESS the user's last click was inside our overlay, in which case they
        // clearly want the composer and the host focus is just stale.
        if (!window._hsMcLastInOverlay) {
          if (
            active &&
            active !== document.body &&
            active.tagName === 'INPUT' &&
            active.id !== 'hs-mc-input' &&
            !active.dataset?.aTarget
          )
            return
          if (active && active !== document.body && active.tagName === 'TEXTAREA' && active.id !== 'hs-mc-input') return
        }

        // If not already in our input, reveal bar and focus it
        if (active !== input) {
          e.preventDefault()
          showInputBar()
          input.focus()
        }
      },
      { capture: true, signal: mcSignal },
    )
  }

  // Global `\` toggle → hide/show chat. Mirrors heatsync.org keyboard shortcut.
  // Skip when input is focused so users can type `\` into chat normally.
  if (!_onceGuardsInput.chatToggleHandler) {
    _onceGuardsInput.chatToggleHandler = true
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== '\\') return
        if (e.ctrlKey || e.altKey || e.metaKey) return
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        try {
          toggleChatHidden()
        } catch (err) {
          log('chat-toggle keydown:', err)
        }
      },
      { capture: true, signal: mcSignal },
    )
  }

  // Auto-reveal input bar when user starts typing anywhere
  if (!_onceGuardsInput.typeRevealHandler) {
    _onceGuardsInput.typeRevealHandler = true
    document.addEventListener(
      'keydown',
      (e) => {
        // Tab jumps focus straight into the composer from anywhere on the page
        // (revealing it if auto-hidden) — keyboard-first, no mouse needed to
        // start typing. When the composer already has focus: an OPEN
        // autocomplete/dropdown keeps Tab (cycle/select); otherwise we swallow
        // it so Tab never tabs the composer OUT into the host page.
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (!tabAcceptsInput(currentTab)) return
          const inp = document.getElementById('hs-mc-input')
          if (!inp) return
          const ae = document.activeElement
          // Don't steal Tab from another real editable field.
          if (ae && ae !== inp && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
          // Composer already focused → its own keydown owns Tab entirely: it
          // starts/cycles emote completion AND always preventDefaults, so Tab
          // can never tab OUT. Deferring here is what keeps tab-complete alive —
          // gating on an "autocomplete open" flag swallowed the FIRST Tab (which
          // is what activates completion in the first place).
          if (ae === inp) return
          e.preventDefault()
          e.stopImmediatePropagation()
          keepComposerOpen()
          showInputBar()
          inp.focus()
          return
        }
        // Class, not the cached flag — a stale `true` here means a hidden bar
        // that no keystroke can ever reveal.
        if (syncInputBarVisible()) return
        if (!tabAcceptsInput(currentTab)) return
        const input = document.getElementById('hs-mc-input')
        if (!input) return
        // Don't steal focus from other inputs
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
        // Only printable chars — skip modifiers, nav, function keys
        if (e.ctrlKey || e.altKey || e.metaKey) return
        if (e.key.length !== 1) return
        // Prevent platform shortcuts (Kick fullscreen "f", theater "t", etc.)
        e.preventDefault()
        e.stopImmediatePropagation()
        showInputBar()
        input.focus()
        // Manually insert the character since we prevented default
        if (input.isContentEditable) {
          document.execCommand('insertText', false, e.key)
        } else {
          input.value += e.key
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      },
      { capture: true, signal: mcSignal },
    )

    // Catch paste when input bar is hidden — reveal bar and insert text
    document.addEventListener(
      'paste',
      (e) => {
        if (syncInputBarVisible()) return
        if (!tabAcceptsInput(currentTab)) return
        const input = document.getElementById('hs-mc-input')
        if (!input) return
        // Don't steal paste from other inputs
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
        // Check for pasted image first
        const items = e.clipboardData?.items
        if (items) {
          for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (file) {
                e.preventDefault()
                handleMediaUpload(file, clipboardImageSourceUrl(e.clipboardData))
                return
              }
            }
          }
        }
        const text = e.clipboardData?.getData('text/plain')
        if (!text) return
        e.preventDefault()
        showInputBar()
        input.focus()
        // Insert pasted text into the input
        if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
          input.value = text
          input.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          document.execCommand('insertText', false, text)
        }
      },
      { signal: mcSignal },
    )
  }

  // Helper: find emote wrapper or img from event target
  function findEmoteTarget(target) {
    // Check wrapper first (our emotes)
    const wrapper = target.closest('.hs-mc-emote-wrapper')
    if (wrapper) {
      const wImg = wrapper.querySelector('img')
      return {
        wrapper,
        emoteName: wrapper.dataset.emoteName || wImg?.alt || 'emote',
        state: wrapper.dataset.state || 'global',
        emoteUrl: wrapper.dataset.emoteUrl || wImg?.src || '',
        source: wrapper.dataset.source || 'unknown',
        modWords: wImg?.dataset?.hsWords || wrapper.dataset?.hsWords || '',
      }
    }
    // Picker emote wrap — when blocked, the inner img is visibility:hidden so
    // right-clicks land on the wrap span, not the img. Without this branch
    // findEmoteTarget returned null and unblock-on-right-click silently failed.
    const pickerWrap = target.closest('.hs-mc-picker-emote-wrap')
    if (pickerWrap) {
      const img = pickerWrap.querySelector('img')
      return {
        wrapper: null,
        emoteName: pickerWrap.dataset.name || img?.alt || 'emote',
        state: img?.dataset.state || (pickerWrap.classList.contains('blocked') ? 'blocked' : 'global'),
        emoteUrl: img?.src || '',
        source: img?.dataset.source || 'unknown',
      }
    }
    // Fallback: direct IMG (Twitch/7TV/BTTV native emotes, picker emotes,
    // and multichat WYSIWYG input chips — class match catches blocked input
    // emotes whose src has been swapped to a transparent placeholder).
    if (
      target.tagName === 'IMG' &&
      !target.classList.contains('hs-mc-badge-img') &&
      (target.classList.contains('hs-mc-emote') ||
        target.classList.contains('hs-mc-picker-emote') ||
        target.classList.contains('hs-input-emote') ||
        target.classList.contains('chat-line__message--emote') ||
        target.classList.contains('chat-image') ||
        target.src?.includes('7tv.app') ||
        target.src?.includes('betterttv.net') ||
        (target.src?.includes('frankerfacez') && !target.src?.includes('room-badge/')) ||
        target.src?.includes('static-cdn.jtvnw.net/emoticons'))
    ) {
      const isBlocked = target.classList.contains('hs-state-blocked') || target.dataset.state === 'blocked'
      return {
        wrapper: null,
        emoteName: target.alt || target.dataset.emoteName || target.title?.split(' ')[0] || 'emote',
        state: isBlocked ? 'blocked' : target.dataset.state || 'global',
        emoteUrl: target.dataset.hsOrigSrc || target.src || '',
        source: target.dataset.source || 'unknown',
      }
    }
    return null
  }

  function openEmoteCtxMenu(x, y, { emoteName, emoteUrl, state, source, targetEl }) {
    const hi = getHighResUrl(emoteUrl)
    const items = []
    // Block/unblock + remove-from-set live here so the shift menu is the
    // complete per-emote surface. Plain right-click is the block/unblock fast
    // path; removal is menu-only — it mutates your set server-side and lost
    // its fast-path slot when right-click became always-block.
    if (state === 'blocked') {
      items.push({ label: 'unblock', fn: () => unblockEmote(emoteName) })
    } else {
      items.push({ label: 'block', fn: () => blockEmote(emoteName, emoteUrl, source) })
      if (state === 'owned' && inventoryEmotes.has(emoteName)) {
        items.push({ label: 'remove from set', fn: () => removeEmoteFromInventory(emoteName, targetEl) })
      }
    }
    items.push('sep')
    let m
    if ((m = emoteUrl.match(/cdn\.7tv\.app\/emote\/([^/]+)/))) {
      items.push({
        label: 'open on 7TV',
        fn: () => window.open(`https://7tv.app/emotes/${m[1]}`, '_blank', 'noopener,noreferrer'),
      })
    } else if ((m = emoteUrl.match(/cdn\.betterttv\.net\/emote\/([^/]+)/))) {
      items.push({
        label: 'open on BTTV',
        fn: () => window.open(`https://betterttv.com/emotes/${m[1]}`, '_blank', 'noopener,noreferrer'),
      })
    } else if ((m = emoteUrl.match(/cdn\.frankerfacez\.com\/emote\/(\d+)/))) {
      items.push({
        label: 'open on FFZ',
        fn: () => window.open(`https://www.frankerfacez.com/emoticon/${m[1]}`, '_blank', 'noopener,noreferrer'),
      })
    }
    items.push(
      { label: 'view image', fn: () => window.open(hi, '_blank', 'noopener,noreferrer') },
      'sep',
      {
        label: 'copy :name:',
        fn: () => {
          try {
            navigator.clipboard
              .writeText(`:${emoteName}:`)
              .then(() => showToast(t('mc_input_name_copied'), 'success'))
              .catch(() => {})
          } catch {}
        },
      },
      {
        label: 'copy image url',
        fn: () => {
          try {
            navigator.clipboard
              .writeText(hi)
              .then(() => showToast(t('mc_input_url_copied'), 'success'))
              .catch(() => {})
          } catch {}
        },
      },
    )
    showHsCtxMenu(x, y, `:${emoteName}:`, items)
  }

  // Right-click menu for emoji. Emoji aren't blockable (unicode glyphs, not
  // provider images — no name/hash/url to key the block registry on), so the
  // menu is copy-only: the :shortcode: when known, plus the raw glyph. Chat
  // emoji carry the shortcode in title=":name:"; input chips in data-emoji-name;
  // raw unicode has neither (copy-glyph only).
  function openEmojiCtxMenu(x, y, span) {
    const title = span.getAttribute('title') || ''
    const m = title.match(/^:([a-z0-9_+-]+):$/i)
    const name = span.dataset?.emojiName || (m ? m[1] : '')
    const char = (span.textContent || '').trim()
    const items = []
    if (name)
      items.push({
        label: 'copy :name:',
        fn: () => {
          try {
            navigator.clipboard
              .writeText(`:${name}:`)
              .then(() => showToast(t('mc_input_name_copied'), 'success'))
              .catch(() => {})
          } catch {}
        },
      })
    if (char)
      items.push({
        label: 'copy emoji',
        fn: () => {
          try {
            navigator.clipboard
              .writeText(char)
              .then(() => showToast(t('mc_input_emoji_copied'), 'success'))
              .catch(() => {})
          } catch {}
        },
      })
    if (!items.length) return
    showHsCtxMenu(x, y, name ? `:${name}:` : char, items)
  }

  // Global right-click handler for ALL emotes
  if (!_onceGuardsInput.emoteContextHandler) {
    _onceGuardsInput.emoteContextHandler = true
    document.addEventListener(
      'contextmenu',
      (e) => {
        // Stack expand on right-click (plain, no modifier — shift falls through
        // to the per-emote menu on whichever stack child the cursor's on).
        const collapsedStack = e.target.closest('.hs-mc-emote-stack:not(.expanded)')
        if (collapsedStack && !e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          collapsedStack.classList.add('expanded')
          collapsedStack.removeAttribute('title')
          return
        }

        // Emoji: copy-only menu (not blockable — see openEmojiCtxMenu). Checked
        // before findEmoteTarget, which doesn't match emoji spans.
        const emojiSpan = e.target.closest('.hs-mc-emoji')
        if (emojiSpan) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          openEmojiCtxMenu(e.clientX, e.clientY, emojiSpan)
          return
        }

        const emoteInfo = findEmoteTarget(e.target)
        if (!emoteInfo) return
        log('Emote right-click:', emoteInfo.emoteName, emoteInfo.state)

        e.preventDefault()
        e.stopPropagation()

        if (e.shiftKey) {
          // targetEl: remove-from-set needs the clicked element so the
          // picker-tile cleanup path can find and drop the right tile.
          openEmoteCtxMenu(e.clientX, e.clientY, { ...emoteInfo, targetEl: e.target })
          return
        }

        const { emoteName, state, emoteUrl, source } = emoteInfo

        // Race-guard against rapid clicking
        if (pendingEmoteOps.has(emoteName)) return

        // 2-state right-click: blocked → unblock, everything else → block —
        // including your own inventory emotes. Block is NOT an inventory
        // mutation (caches + server user_emotes row preserved; unblock returns
        // the emote to "in set"), so one gesture = one meaning with nothing
        // destructive on the common path. The old 3rd branch routed owned
        // emotes to remove-from-inventory, which silently mutated the set
        // server-side and made blocking an owned emote take two right-clicks
        // (or zero, when the removed name stopped resolving). Removal lives in
        // the shift menu now (openEmoteCtxMenu).
        if (state === 'blocked') {
          unblockEmote(emoteName)
        } else {
          blockEmote(emoteName, emoteUrl, source)
        }
      },
      { capture: true, signal: mcSignal },
    )
  }

  // Global left-click handler for ALL emotes
  if (!_onceGuardsInput.emoteClickHandler) {
    _onceGuardsInput.emoteClickHandler = true
    document.addEventListener(
      'click',
      (e) => {
        // Stack collapse button
        if (e.target.closest('.hs-mc-stack-collapse')) {
          e.preventDefault()
          e.stopPropagation()
          const stack = e.target.closest('.hs-mc-emote-stack')
          if (stack) {
            stack.classList.remove('expanded')
            stack.setAttribute('title', 'expand')
          }
          return
        }
        // Stack block-all button
        if (e.target.closest('.hs-mc-stack-block-all')) {
          e.preventDefault()
          e.stopPropagation()
          const stack = e.target.closest('.hs-mc-emote-stack')
          if (stack) blockAllEmotesInStack(stack)
          return
        }
        // Collapsed stack left-click → add unowned emotes to inventory, then
        // paste every postable item (emotes + emojis) to input in DOM order.
        // Emojis in the nest are treated as first-class stack members so a
        // composite like "emote + :smile:0 overlay" round-trips into the input
        // intact instead of dropping the emoji.
        // (skip locked/blocked emotes — viewer can't post them)
        const collapsedStack = e.target.closest('.hs-mc-emote-stack:not(.expanded)')
        if (collapsedStack) {
          e.preventDefault()
          e.stopPropagation()
          const stackInner = collapsedStack.querySelector('.hs-mc-emote-stack-emotes')
          const stackChildren = stackInner ? [...stackInner.children] : []
          const items = []
          let hadUnpostableEmote = false
          for (const c of stackChildren) {
            if (c.classList?.contains('hs-mc-emote-wrapper') && c.dataset.emoteName) {
              const s = c.dataset.state
              if (s === 'locked' || s === 'blocked') {
                hadUnpostableEmote = true
                continue
              }
              items.push({ kind: 'emote', el: c })
            } else if (c.classList?.contains('hs-mc-emoji')) {
              items.push({ kind: 'emoji', el: c })
            }
          }
          if (items.length === 0) {
            if (hadUnpostableEmote) showToast(t('mc_input_nothing_postable'), 'error')
            return
          }
          // Fire add-to-inventory for each unowned emote (don't block paste on the
          // server roundtrip; state flips green when each resolves).
          for (const it of items) {
            if (it.kind !== 'emote') continue
            const w = it.el
            if (w.dataset.state === 'unadded') {
              const name = w.dataset.emoteName
              if (!name || pendingEmoteOps.has(name)) continue
              const url = w.dataset.emoteUrl || w.querySelector('img')?.src || ''
              const source = w.dataset.source || 'heatsync'
              if (typeof registerClickPastedRef === 'function') registerClickPastedRef(name, url, source)
              addEmoteToInventory(name, url, source, w)
            } else {
              // global/channel/owned stack members follow the same
              // auto-add-on-send contract as the single-emote click path.
              const url = w.dataset.emoteUrl || w.querySelector('img')?.src || ''
              if (typeof registerClickPastedRef === 'function')
                registerClickPastedRef(w.dataset.emoteName, url, w.dataset.source || 'unknown')
              registerClickPasteForAutoAdd(w.dataset.emoteName, url, w.dataset.source || 'unknown')
            }
          }
          showInputBar()
          for (let i = 0; i < items.length; i++) {
            const it = items[i]
            if (it.kind === 'emote') {
              const w = it.el
              const name = w.dataset.emoteName
              if (!name) continue
              // Wire words are stashed on the wrapper at render time by
              // _hsMcApplyMods so paste preserves w!/h!/c! per emote, letting
              // user click-paste-enter and reproduce the nest's exact dimensions.
              const wImg = w.querySelector('img')
              const modWords = wImg?.dataset?.hsWords || w.dataset?.hsWords || ''
              pasteEmoteToInput(name, modWords)
            } else {
              // Non-first item is an overlay — stack onto the previous chip so
              // getInputText emits ":name:0" (or unicode-stacked) on the wire.
              pasteEmojiSpanFromNestToInput(it.el, i > 0)
            }
          }
          const input = document.getElementById('hs-mc-input')
          if (input) input.focus()
          const firstEmote = items.find((it) => it.kind === 'emote')
          if (firstEmote) flashAllEmotes(firstEmote.el.dataset.emoteName, 'hs-flash-paste')
          return
        }

        const emoteInfo = findEmoteTarget(e.target)
        if (!emoteInfo) return

        // Multichat input WYSIWYG chip — only intercept clicks for the blocked
        // state (left-click unblocks). For any other state we let the
        // contenteditable handle the click so the caret lands at the click
        // position; intercepting would silently re-paste the same emote on
        // every cursor placement, which is hostile.
        if (e.target.closest('#hs-mc-input') && emoteInfo.state !== 'blocked') return

        // Remote provider search result — owned by the picker delegate in
        // emotes.js (optimistic inventory seed + server add + paste). This
        // handler has no remote branch, so swallowing the event here turned
        // every search-result click into a silent dead click (preventDefault +
        // stopPropagation below, then no matching state). Let it bubble.
        if (emoteInfo.state === 'remote') return

        e.preventDefault()
        e.stopPropagation()

        const { emoteName, state, emoteUrl, source, modWords } = emoteInfo

        if (state === 'blocked') {
          // 2-state model: left-click on a blocked emote unblocks it (returns
          // straight to whatever its natural state is — owned if still in your
          // inventory, channel/global otherwise). Mirrors right-click on blocked.
          if (pendingEmoteOps.has(emoteName)) return
          unblockEmote(emoteName)
          return
        }
        if (state === 'locked') {
          // Foreign Twitch sub emote — viewer not subbed to this channel, can't
          // post it. Toast instead of paste (matches website post-b6f23bc8:
          // visually identical to other emotes, only click is gated).
          showToast(t('mc_input_not_subbed', [emoteName]), 'error')
          return
        }
        if (state === 'owned' || state === 'global' || state === 'channel' || state === 'unadded') {
          // 2-state model: every non-blocked, non-remote picker emote is equally
          // pasteable. The old "first click adds, second click pastes" anti-misfire
          // was an artefact of the orange `unadded` tier — without that tier there's
          // no slot to "burn" prematurely, since auto-add-on-send commits the slot
          // only at the moment the user actually sends a message containing the
          // emote. Picker click = paste; if you send it, it lands in your set
          // automatically. Optimistically populate viewerPersonalEmotes so the
          // own-message echo can render the image before the server add resolves
          // (emote name in raw text has no <img> wrapper for a late add to fill in).
          // Seed viewerPersonalEmotes when the clicked emote can't currently be
          // resolved by lookupEmote — covers the 'unadded' slot (optimistic add so
          // the own-message echo renders before the server add lands) AND the case
          // where the picker outlived its live resolver cache: 7TV channel/owned
          // emotes are still shown in the cached picker DOM during the post-load
          // sub-ack window (~15s) and after a channel re-key, but
          // lookupEmoteWithOverlay returns null for them, so createInputEmoteImg
          // builds no chip and the click silently pastes nothing. The clicked
          // element carries the real url+source, so seed from it (state preserved;
          // 'unadded' normalizes to 'owned'). Guard on a real http(s) url so a
          // blocked emote's transparent px never seeds garbage.
          if (
            !viewerPersonalEmotes.has(emoteName) &&
            emoteUrl &&
            /^https?:/i.test(emoteUrl) &&
            (typeof lookupEmoteWithOverlay !== 'function' || !lookupEmoteWithOverlay(emoteName))
          ) {
            viewerPersonalEmotes.set(emoteName, {
              url: emoteUrl,
              source: source || 'heatsync',
              state: state === 'unadded' ? 'owned' : state,
              addedAt: Date.now(),
            })
          }
          // Durable own-echo fallback: record the ref so a failed auto-add-on-send
          // (offline / rate-limit / recycled SW / unreadable cookie) never leaves
          // your own echo as raw text. Never rolled back. See clickPastedRefs.
          if (typeof registerClickPastedRef === 'function') registerClickPastedRef(emoteName, emoteUrl, source)
          // Commit the slot at send (2-state contract) — without this the
          // optimistic seed above renders the chip for the clicker only.
          registerClickPasteForAutoAdd(emoteName, emoteUrl, source)
          showInputBar()
          pasteEmoteToInput(emoteName, modWords)
          const input = document.getElementById('hs-mc-input')
          if (input) input.focus()
          flashAllEmotes(emoteName, 'hs-flash-paste')
          return
        }
      },
      { capture: true, signal: mcSignal },
    )
  }

  // Spoiler click → toggle revealed
  if (!_onceGuardsInput.spoilerHandler) {
    _onceGuardsInput.spoilerHandler = true
    document.addEventListener(
      'click',
      (e) => {
        const spoiler = e.target.closest('.hs-spoiler')
        if (!spoiler) return
        e.stopPropagation()
        spoiler.classList.toggle('revealed')
      },
      { signal: mcSignal },
    )
  }

  // Reply button click → set reply state and focus input
  if (!_onceGuardsInput.replyHandler) {
    _onceGuardsInput.replyHandler = true
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target.closest('.hs-mc-reply-btn')
        if (!btn) return
        const msg = btn.closest('.hs-mc-msg')
        if (!msg?.dataset.msgId) return
        setReplyState({
          msgId: msg.dataset.msgId,
          user: msg.dataset.msgUser,
          channel: msg.dataset.msgChannel,
        })
      },
      { signal: mcSignal },
    )
  }

  // Thread button click → seed the composer with the /op command and a citation
  // of the message. A native twitch/kick message has no heatsync id, so it can
  // never be a reply_to target — quoting it into a NEW top-level thread is the
  // only honest on-ramp. Seeding (not sending) keeps the user in control of what
  // gets published under their name, and shows them the command exists.
  //
  // The citation is the /logs permalink, not the text. heatsync archives the
  // line, so the post can point AT the original instead of carrying a retyped
  // copy: both heatsync.org and the panel resolve the link back into the real
  // chat line — the author, the time, the emotes, the channel — and a reader
  // can click through to the surrounding log. A pasted copy is a claim about
  // what someone said; the permalink is the receipt. That is the whole point of
  // quoting someone else's words, and a copy sitting next to the receipt would
  // only give the two a way to disagree.
  //
  // Falls back to the quoted text when the line cannot be cited — a row with no
  // archived platform, channel or send time. Better a soft quote than a link to
  // a page that was never going to hold the message.
  if (!_onceGuardsInput.threadHandler) {
    _onceGuardsInput.threadHandler = true
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target.closest('.hs-mc-thread-btn')
        if (!btn) return
        const msg = btn.closest('.hs-mc-msg')
        if (!msg) return
        const permalink = buildRowPermalink(msg)
        const quoted = (msg.querySelector(':scope > .hs-mc-text')?.textContent || '').trim()
        if (!permalink && !quoted) return
        showInputBar()
        const input = document.getElementById('hs-mc-input')
        if (!input) return
        const seed = permalink ? `/op ${permalink} ` : `/op "${quoted}" — ${msg.dataset.msgUser || ''} `
        input.focus()
        // Append at the caret-end rather than overwriting: a half-typed message
        // in the composer is the user's, and silently eating it to make room
        // for a quote would be worse than the missing button ever was.
        if (input.isContentEditable) {
          const sel = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(input)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
          document.execCommand('insertText', false, seed)
        } else {
          input.value += seed
          input.selectionStart = input.selectionEnd = input.value.length
        }
      },
      { signal: mcSignal },
    )
  }

  // Universal right-click → user/post action menu. Fires on ANY username
  // (.hs-mc-user), chat message (.hs-mc-msg), or feed post (.hs-feed-msg)
  // anywhere in the panel. follow=1, block=2 are always the top two items.
  // The emote menu (capture handler above) owns emote right-clicks; real
  // links/media fall through to the native menu so "copy link" still works.
  if (!_onceGuardsInput.msgContextHandler) {
    _onceGuardsInput.msgContextHandler = true
    document.addEventListener(
      'contextmenu',
      (e) => {
        // Emote AND emoji right-clicks own their own menus (emote block / emoji
        // copy) in the handler above — bail so the user/message menu doesn't
        // also fire on the same event and overwrite them (both are capture-phase
        // document listeners, so stopPropagation alone wouldn't stop this one).
        if (findEmoteTarget(e.target) || e.target.closest('.hs-mc-emoji')) return
        const userEl = e.target.closest('.hs-mc-user:not(.hs-mc-reply-user)')
        const feedDiv = e.target.closest('.hs-feed-msg')
        const msg = e.target.closest('.hs-mc-msg')
        if (!userEl && !feedDiv && !msg) return
        // Composer mention chips are editable text, not an author reference —
        // right-clicking one keeps the native menu (cut/copy), never the
        // follow/block user menu (which would target yourself when you @self).
        if (userEl?.closest('#hs-mc-input')) return
        // Right-clicking a real link/embed (not a username) → keep native menu.
        if (
          !userEl &&
          e.target.closest(
            'a, img, video, iframe, .hs-feed-thread-link, .hs-quote-insert, .hs-post-link, .hs-feed-embed',
          )
        )
          return
        const norm = (el) => (el.dataset.username || el.textContent || '').replace(/^@/, '').trim().toLowerCase()
        let username = null,
          platform = null,
          feedMsg = null
        if (userEl) {
          username = norm(userEl)
          platform = userEl.dataset.platform || null
        } else if (feedDiv) {
          const a = feedDiv.querySelector('.hs-mc-user')
          username = a ? norm(a) : null
          platform = a?.dataset.platform || null
          feedMsg = feedDiv._hsFeedMsg || null
        } else {
          const a = msg.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
          username = a ? norm(a) : null
          platform = a?.dataset.platform || null
        }
        if (!username || username === 'anonymous') return
        e.preventDefault()
        e.stopPropagation()
        openUserCtxMenu(e.clientX, e.clientY, username, platform, {
          msg: msg || null,
          feedDiv: feedDiv || null,
          feedMsg,
        })
      },
      { capture: true, signal: mcSignal },
    )
  }
}

// Resolve a username's heatsync profile (id + relationship) via the shared
// identity resolver — cache-first, so a prior hover/tooltip makes this instant.
function hsRelPeek(username, platform) {
  if (typeof _profileCache === 'undefined') return null
  const u = String(username).toLowerCase()
  let c = _profileCache.get(`${platform || 'unknown'}:${u}`)
  if (!c) {
    for (const [k, v] of _profileCache) {
      if (k.endsWith(`:${u}`)) {
        c = v
        break
      }
    }
  }
  return c?.profile || null
}

async function hsFollowFromMenu(username, platform, ids = {}) {
  if (typeof resolveIdentity !== 'function') return
  const ri = await resolveIdentity(username, { platform })
  const p = ri?.profile
  let id = p?.id || p?.userId
  // BUG 1c — no heatsync profile: fall back to the same kick/yt resolution
  // the profile card uses (resolveFollowTargetId, profile-card.js) instead of
  // giving up. Kick hits the public kick.com API for a real numeric id; YT
  // uses a UC channel id already known from chat (ids.youtubeChannelId, or a
  // buffer scan when the ctx-menu didn't have one to hand).
  if (
    !id &&
    typeof resolveFollowTargetId === 'function' &&
    (platform === 'kick' || platform === 'youtube' || platform === 'yt')
  ) {
    const target = await resolveFollowTargetId(platform, username, ids)
    if (target?.id) id = target.id
  }
  if (!id) {
    const msg = ri?.transient
      ? ri.status === 429
        ? t('mc_input_rate_limited')
        : t('mc_input_server_unreachable', [String(ri.status || 'net')])
      : t('mc_input_not_on_heatsync', [username])
    showToast(msg, 'error')
    return
  }
  pcToggleFollow(id, username, !!(p?.relationship?.youFollow || p?.relationship?.isFollowing))
}

async function hsBlockFromMenu(username, platform) {
  let p = null
  if (typeof resolveIdentity === 'function') p = (await resolveIdentity(username, { platform }))?.profile || null
  const id = p?.id || p?.userId
  // Registered → real account-level block (persists, auto-unfollows). Otherwise
  // fall back to a local session hide so block still works on non-heatsync users.
  if (id) pcToggleBlock(id, username, !!(p.relationship?.youBlock || p.relationship?.isBlocked))
  else _toggleMcBlock(username, platform)
}

// Build the universal action menu. follow=1, block=2 always lead; whisper/
// mention/profile/copy follow; own feed posts append edit/delete.
// Right-click mod action — single platform (the clicked message's), targeting
// the login. Delete gets a bespoke toast; the rest use the shared combined one.
async function _ctxMod(action, channel, platform, target, msgId, durationSec, label) {
  // Logged-out Twitch: the GQL channel-id resolve fails and mislabels the
  // result "<action> failed: channel not found". Surface plain-send's sticky
  // not-logged-in cue instead (same check as the slash-command dispatch).
  if (platform === 'twitch') {
    const { token } = await getTwitchAuthTokenAsync()
    if (!token) {
      try {
        HsNotifs.emit('twitch-auth-required', { text: t('mc_input_not_logged_in') || 'log into twitch.tv to chat' })
      } catch (_) {}
      return
    }
  }
  const r = await dispatchModAction({ channel, platform, action, target, durationSec, msgId })
  if (action === 'delete') {
    const dresp = r?.tResp || r?.kResp || r?.yResp
    // yt's codes are machine strings — "delete failed: message_not_found" is
    // what a mod used to read. Route them through the yt copy map; twitch and
    // kick already hand back human-readable errors.
    const derr =
      dresp && dresp === r?.yResp
        ? youtubeModErrorMessage(dresp.error)
        : dresp?.error === 'not_moderator'
          ? t('mc_modtoolbar_not_youtube_mod')
          : dresp?.error || t('mc_common_unknown')
    showToast(
      r?.anyOk ? t('mc_profile_deleted_message') : t('mc_input_delete_failed', [derr]),
      r?.anyOk ? 'success' : 'error',
    )
  } else {
    showModResultToast(label, target, r)
  }
}

function openUserCtxMenu(x, y, username, platform, ctx = {}) {
  const { msg, feedDiv, feedMsg } = ctx
  const rel = hsRelPeek(username, platform)?.relationship || null
  const youFollow = !!(rel?.youFollow || rel?.isFollowing)
  const youBlock =
    !!(rel?.youBlock || rel?.isBlocked) ||
    (typeof isUserBlocked === 'function'
      ? isUserBlocked(username, platform)
      : blockedUsers.has(String(username).toLowerCase()))
  const isMuted = typeof isUserMuted === 'function' ? isUserMuted(username, platform) : mutedUsers.has(username)
  // The clicked row's paint uid already carries a yt_<UCid> for YT chatters
  // (main.js stamps m.hsPaintUid onto dataset.hsPaintUid at render time) — a
  // free, exact UC id hand-off into the follow resolver (BUG 1c), no buffer
  // re-scan needed.
  const rowPaintUid = msg?.dataset?.hsPaintUid || ''
  const followIds = rowPaintUid.startsWith('yt_') ? { youtubeChannelId: rowPaintUid.slice(3) } : {}
  const items = [
    {
      key: 'follow',
      label: youFollow ? 'unfollow' : 'follow',
      fn: () => hsFollowFromMenu(username, platform, followIds),
    },
    {
      key: 'block',
      label: youBlock ? 'unblock' : 'block',
      danger: !youBlock,
      fn: () => hsBlockFromMenu(username, platform),
    },
    { label: isMuted ? 'unmute' : 'mute (24h)', danger: !isMuted, fn: () => _toggleMcMute(username, platform) },
    {
      label:
        typeof isUserHiddenInTab === 'function' && isUserHiddenInTab(username, platform, currentTab)
          ? 'unhide in tab'
          : 'hide in tab',
      fn: () => _tabHide(username, platform, 'toggle'),
    },
    'sep',
    {
      label: 'copy name',
      fn: () => mcCopyToClipboard(username, t('mc_input_name_copied')),
    },
  ]
  // Copy/quote lead the menu (right after follow/block/mute) so they're never
  // buried under mod actions or the social-action wall below — this is the
  // #1 thing right-click gets used for, it shouldn't take scrolling to find.
  if (msg) {
    items.push({
      label: 'copy message',
      fn: () => mcCopyToClipboard(_extractMcMsgText(msg), t('mc_input_message_copied')),
    })
    items.push({
      label: 'copy → input',
      fn: () => mcQuoteToInput(_extractMcMsgText(msg)),
    })
  }
  if (feedDiv && typeof getActiveThreadCopyText === 'function') {
    const threadTxt = getActiveThreadCopyText()
    if (threadTxt)
      items.push({
        label: 'copy thread',
        fn: () => mcCopyToClipboard(threadTxt, t('mc_input_thread_copied')),
      })
  }
  if (msg) {
    const chainTxt = _extractMcChainText(msg)
    if (chainTxt)
      items.push({
        label: 'copy thread',
        fn: () => mcCopyToClipboard(chainTxt, t('mc_input_thread_copied')),
      })
  }
  items.push('sep')
  // ─── Mod actions ─── gated on, and acting on, the CLICKED message's platform
  // (single — no cross-platform noise; a twitch chatter ≠ the same-named kick
  // user). Twitch gates on GQL mod-state, Kick on kick_mod_status. Targets the
  // LOGIN (display-name ≠ login for non-Latin users → ban would miss).
  if (
    msg &&
    (typeof isModForSync === 'function' ||
      typeof isKickModForSync === 'function' ||
      typeof isYtModForSync === 'function')
  ) {
    const msgCh = msg.dataset?.msgChannel || ''
    const msgPlat = msg.dataset?.msgPlatform || 'twitch'
    const msgLogin = (msg.dataset?.msgLogin || msg.dataset?.msgUser || username || '').toLowerCase()
    const msgId = msg.dataset?.msgId || ''
    const lookup = typeof getChannelLookup === 'function' ? getChannelLookup() : null
    const entry =
      lookup && msgCh
        ? (msgPlat === 'kick' ? lookup.kick.get(msgCh) : lookup.twitch.get(msgCh)) || lookup.byId.get(msgCh)
        : null
    const isKick = msgPlat === 'kick'
    const isYt = msgPlat === 'youtube' || msgPlat === 'yt'
    // The channel key for the action + gate: kick slug for kick rows, twitch
    // login otherwise. YT actions are message-scoped (msgId), so any truthy
    // channel just satisfies the gate — the dispatch uses msgId, not the channel.
    const modCh = isYt ? msgCh || 'yt' : isKick ? entry?.kick || msgCh : entry?.twitch || msgCh
    // currentUsername is a display name; compare against BOTH the login and the
    // display name so a non-Latin-named mod can't be shown self-mod actions.
    const _selfRef = typeof currentUsername !== 'undefined' && currentUsername ? currentUsername.toLowerCase() : null
    const notSelf = !_selfRef || (msgLogin !== _selfRef && (msg.dataset?.msgUser || '').toLowerCase() !== _selfRef)
    const amMod = isYt
      ? typeof isYtModForSync === 'function' && isYtModForSync()
      : isKick
        ? typeof isKickModForSync === 'function' && isKickModForSync(modCh)
        : typeof isModForSync === 'function' && isModForSync(modCh)
    if (modCh && notSelf) {
      if (amMod) {
        const mod = []
        if (msgId)
          mod.push({
            label: 'delete msg',
            danger: true,
            fn: () => _ctxMod('delete', msgCh, msgPlat, msgLogin, msgId, 0, 'deleted'),
          })
        mod.push(
          {
            // YouTube's timeout is a fixed-duration hide (no 10m choice).
            label: isYt ? 'timeout' : 'timeout 10m',
            fn: () => _ctxMod('timeout', msgCh, msgPlat, msgLogin, msgId, 600, 'timed out'),
          },
          { label: 'ban', danger: true, fn: () => _ctxMod('ban', msgCh, msgPlat, msgLogin, msgId, 0, 'banned') },
          { label: 'unban', fn: () => _ctxMod('unban', msgCh, msgPlat, msgLogin, msgId, 0, 'unbanned') },
        )
        // Bulk-select entry — twitch/kick only (YT rows carry none of the
        // dataset bulk-select needs, same reason the hover toolbar skips YT).
        if (!isYt && typeof startBulkSelectFrom === 'function' && typeof isBulkSelectMode === 'function') {
          mod.push({
            label: isBulkSelectMode() ? 'exit select mode' : 'select mode',
            fn: () => (isBulkSelectMode() ? exitBulkSelectMode() : startBulkSelectFrom(msg)),
          })
        }
        mod.push('sep')
        items.push(...mod)
      } else {
        // Warm the right cache so the next right-click surfaces actions.
        if (isKick) {
          if (typeof prefetchKickModFor === 'function') prefetchKickModFor(modCh)
        } else if (typeof prefetchModFor === 'function') prefetchModFor(modCh)
      }
    }
  }
  // Reply — only when right-clicked on a real chat message with an id (Twitch
  // IRC msg-id or Kick msg id). The same setReplyState the reply-button uses.
  if (msg?.dataset?.msgId) {
    items.push({
      label: 'reply',
      fn: () =>
        setReplyState({
          msgId: msg.dataset.msgId,
          user: msg.dataset.msgUser || username,
          channel: msg.dataset.msgChannel || '',
        }),
    })
  }
  // Op this message to the heatsync feed — posting emerges from chat, where the
  // moment actually happens, quoting the author with @attribution.
  if (msg) {
    items.push({ label: 'op to feed', fn: () => _quickOpToFeed(username, msg) })
  }
  items.push(
    { label: 'whisper', fn: () => _openWhisperFor(username, platform) },
    { label: 'dm', fn: () => _openDmFor(username, platform) },
    { label: 'mention', fn: () => _mentionInMcInput(username) },
    { label: 'view profile', fn: () => openProfileCard(username, platform) },
    {
      label: typeof hsNoteHas === 'function' && hsNoteHas(username, platform) ? 'edit note' : 'add note',
      fn: () => hsNoteOpenEditor(username, platform, x, y),
    },
  )
  // Twitch-native actions we don't reimplement (report, gift sub) — the
  // official viewer-card popout carries both. Twitch rows with a known
  // channel only; window.open keeps twitch's own auth/session context.
  if ((platform || 'twitch') === 'twitch') {
    const vcChannel = msg?.dataset?.msgChannel || (typeof getLiveChannel === 'function' ? getLiveChannel() : null)
    if (vcChannel) {
      items.push({
        label: 'report / gift sub',
        fn: () => {
          const u = encodeURIComponent(String(username).toLowerCase())
          const c = encodeURIComponent(String(vcChannel).toLowerCase())
          try {
            window.open(`https://www.twitch.tv/popout/${c}/viewercard/${u}`, '_blank', 'noopener,width=400,height=600')
          } catch {}
        },
      })
    }
  }
  // Filter the live buffer to just this user — sets the search bar to @name.
  // Only on a live/channel tab (where local filtering applies) and a real row.
  if (msg && typeof isLiveSearchTab === 'function' && isLiveSearchTab(currentTab)) {
    items.push({
      label: `filter to ${username}`,
      fn: () => {
        const input = document.getElementById('hs-mc-search-input')
        if (!input) return
        input.value = `@${String(username).toLowerCase()}`
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
      },
    })
  }
  // Chat-log viewer — twitch + kick (yt has no relay). One entry: opens
  // channel-scoped when we know the channel (the viewer has its own #channel↔all
  // scope toggle), else all-channels. Was two entries doing what one + the
  // in-view toggle already covers.
  const logPlatform = platform || 'twitch'
  if (logPlatform === 'twitch' || logPlatform === 'kick') {
    const msgChannel = msg?.dataset?.msgChannel || (typeof getLiveChannel === 'function' ? getLiveChannel() : null)
    items.push({
      label: 'chat logs',
      fn: () =>
        openChatLogsView(
          username,
          msgChannel ? { platform: logPlatform, channel: msgChannel } : { platform: logPlatform },
        ),
    })
  }
  if (feedMsg && typeof isOwnFeedPost === 'function' && isOwnFeedPost(feedMsg)) {
    items.push('sep')
    const remaining =
      (typeof EDIT_WINDOW_MS !== 'undefined' ? EDIT_WINDOW_MS : 0) -
      (Date.now() - new Date(feedMsg.created_at).getTime())
    if (remaining > 0) {
      const mins = Math.floor(remaining / 60000),
        secs = Math.floor((remaining % 60000) / 1000)
      items.push({
        label: `edit (${mins}:${String(secs).padStart(2, '0')})`,
        fn: () => {
          if (feedDiv && typeof showFeedEditUI === 'function') showFeedEditUI(feedDiv, feedMsg)
        },
      })
    } else {
      items.push({ label: 'edit (expired)', disabled: true })
    }
    items.push({
      label: 'delete',
      danger: true,
      fn: () => {
        if (typeof deleteFeedPost === 'function') deleteFeedPost(feedMsg)
      },
    })
  }
  showHsCtxMenu(x, y, username, items)
  // Async warm-up: cache miss or stale → fetch fresh and patch the menu's
  // follow/block labels in place. Survives the typical case where the user's
  // first interaction with a sender is a right-click (no hover-warmed cache).
  if (typeof resolveIdentity === 'function') {
    resolveIdentity(username, { platform })
      .then((ri) => {
        const r = ri?.profile?.relationship
        if (!r) return
        const menu = document.getElementById('hs-mc-msg-ctx')
        if (!menu) return
        const yf = !!(r.youFollow || r.isFollowing)
        const yb =
          !!(r.youBlock || r.isBlocked) ||
          (typeof isUserBlocked === 'function'
            ? isUserBlocked(username, platform)
            : blockedUsers.has(String(username).toLowerCase()))
        const followEl = menu.querySelector('[data-hs-key="follow"] .hs-mc-em-label')
        if (followEl) followEl.textContent = yf ? 'unfollow' : 'follow'
        const blockEl = menu.querySelector('[data-hs-key="block"] .hs-mc-em-label')
        if (blockEl) {
          blockEl.textContent = yb ? 'unblock' : 'block'
          blockEl.parentElement.classList.toggle('hs-mc-em-danger', !yb)
        }
      })
      .catch(() => {})
  }
}

// Expand a username/platform pair into ALL known cross-platform aliases.
// Combines local synchronous getUserAliases (7TV-derived kick→twitch from
// cosmetics flow) with heatsync /api/profile (canonical source for users on
// the platform: returns twitch_username + kick_username regardless of which
// direction you queried). Async because profile is one network round-trip.
async function expandUserAliases(username, platform) {
  const seen = new Set()
  const out = []
  const push = (v) => {
    if (!v) return
    const k = String(v).toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(k)
  }
  // Sync local aliases first — kick→twitch from 7TV cosmetics, etc.
  const local =
    typeof getUserAliases === 'function' ? getUserAliases(username, platform) : [String(username || '').toLowerCase()]
  for (const a of local) push(a)
  // Heatsync profile lookup — registered users return both twitch_username
  // and kick_username. Non-registered users return error: we silently fall
  // back to local-only aliases.
  if (typeof resolveIdentity === 'function') {
    try {
      const ri = await resolveIdentity(username, { platform })
      const p = ri?.profile
      if (p) {
        if (p.twitch_username) push(p.twitch_username)
        if (p.kick_username) push(p.kick_username)
        if (p.youtube_username) push(p.youtube_username)
      }
    } catch {}
  }
  return out
}

// Namespaced-key variant of expandUserAliases (base + sync local links + async
// heatsync-profile links), each scoped to its platform. Mute/block ACTIONS use
// this so the write covers every linked identity with no bare-name collision.
async function expandUserAliasKeys(username, platform) {
  const seen = new Set()
  const out = []
  const push = (name, plat) => {
    const k = typeof userKey === 'function' ? userKey(name, plat) : String(name || '').toLowerCase()
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(k)
  }
  push(username, platform)
  // sync local links (kick→twitch, yt→twitch) — already namespaced
  if (typeof getUserAliasKeys === 'function') {
    for (const k of getUserAliasKeys(username, platform)) {
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  // async heatsync-profile links — registered users expose linked handles,
  // each on its own platform
  if (typeof resolveIdentity === 'function') {
    try {
      const ri = await resolveIdentity(username, { platform })
      const p = ri?.profile
      if (p) {
        push(p.twitch_username, 'twitch')
        push(p.kick_username, 'kick')
        push(p.youtube_username, 'youtube')
      }
    } catch {}
  }
  return out
}

async function _toggleMcMute(username, platform) {
  const aliases = await expandUserAliases(username, platform)
  // Namespaced keys for the mute set + cross-tab messages — covers every linked
  // identity (async profile resolution) with no bare-name collision between
  // unrelated twitch:alice / kick:alice accounts. Bare `aliases` stays for the
  // toast note + restoreMcUnmutedDom (which match bare display names).
  const aliasKeys = await expandUserAliasKeys(username, platform)
  const primary = aliases[0] || String(username).toLowerCase()
  const wasMuted = typeof isUserMuted === 'function' ? isUserMuted(username, platform) : mutedUsers.has(primary)
  const wasUnmute = wasMuted
  if (wasMuted) {
    for (const k of aliasKeys) mutedUsers.delete(k)
    // Also clear legacy forms: bare (pre-namespace), yt: (pre-canonPlatform —
    // enforcement matches it, so leaving it = unmute that doesn't unmute),
    // and heatsync: (heatsync-platform rows) so unmute always lands.
    const bareLower = String(username == null ? '' : username)
      .toLowerCase()
      .replace(/^@/, '')
    const legacy = bareLower ? [bareLower, `yt:${bareLower}`, `heatsync:${bareLower}`] : []
    for (const k of legacy) mutedUsers.delete(k)
    showToast(t('mc_input_unmuted', [username]), 'success')
    for (const k of [...aliasKeys, ...legacy]) safeSendMessage({ type: 'unmute_user', username: k })
  } else {
    for (const k of aliasKeys) mutedUsers.add(k)
    const otherAlias = aliases.slice(1).filter((a) => a !== primary)
    const aliasNote = otherAlias.length ? ` (+linked @${otherAlias.join(' @')})` : ''
    showToast(t('mc_input_muted', [username + aliasNote]), 'success')
    const exp = Date.now() + 86400000
    for (const k of aliasKeys) safeSendMessage({ type: 'mute_user', username: k, expiresAt: exp })
  }
  persistMcMuted()
  if (wasUnmute) {
    // restoreMcUnmutedDom matches by bare DOM text — use bare aliases here.
    for (const a of aliases) restoreMcUnmutedDom(a)
  }
  // bypassScrollPause: a mute applied while scrolled up must still strip the
  // rows now — renderMessages otherwise no-ops (scroll-pause) and the muted
  // user stays visible under a "muted" toast until the reader hits bottom.
  renderMessages(currentTab, { bypassScrollPause: true })
}

async function _toggleMcBlock(username, platform) {
  const aliases = await expandUserAliases(username, platform)
  // Namespaced keys for the block set + cross-tab messages — same pattern as
  // _toggleMcMute; bare `aliases` stays for toast display only.
  const aliasKeys = await expandUserAliasKeys(username, platform)
  const wasBlocked =
    typeof isUserBlocked === 'function' ? isUserBlocked(username, platform) : blockedUsers.has(aliases[0])
  if (wasBlocked) {
    for (const k of aliasKeys) blockedUsers.delete(k)
    // Also clear any legacy bare entry (pre-namespace storage) so unblock always lands.
    const bareLower = String(username == null ? '' : username)
      .toLowerCase()
      .replace(/^@/, '')
    if (bareLower) blockedUsers.delete(bareLower)
    showToast(t('mc_input_unblocked', [username]), 'success')
    for (const k of aliasKeys) safeSendMessage({ type: 'unblock_user', username: k })
  } else {
    for (const k of aliasKeys) blockedUsers.add(k)
    const primary = aliases[0] || String(username).toLowerCase()
    const other = aliases.slice(1).filter((a) => a !== primary)
    const aliasNote = other.length ? ` (+linked @${other.join(' @')})` : ''
    showToast(t('mc_input_blocked', [username + aliasNote]), 'success')
    for (const k of aliasKeys) safeSendMessage({ type: 'block_user', username: k })
  }
  // buildMessageDiv filters blocked users, so a full re-render hides/restores them.
  // bypassScrollPause so a block applied while scrolled up takes effect now
  // instead of silently waiting until the reader returns to the bottom.
  renderMessages(currentTab, { bypassScrollPause: true })
}

// Per-tab hide toggle — like _toggleMcBlock but writes an EPHEMERAL, tab-scoped
// set (perTabHidden) with NO safeSendMessage fan-out and NO persistence, so it
// never leaks to other tabs/surfaces. mode: 'toggle' (right-click) | 'hide' | 'unhide'.
async function _tabHide(username, platform, mode = 'toggle') {
  const tab = currentTab
  if (!username || !tab) return
  const aliasKeys = await expandUserAliasKeys(username, platform)
  const isHidden = typeof isUserHiddenInTab === 'function' && isUserHiddenInTab(username, platform, tab)
  const shouldHide = mode === 'toggle' ? !isHidden : mode === 'hide'
  let set = perTabHidden.get(tab)
  if (shouldHide) {
    if (!set) {
      set = new Set()
      perTabHidden.set(tab, set)
    }
    for (const k of aliasKeys) set.add(k)
    showToast(t('mc_input_tab_hidden', [username]), 'success')
  } else {
    if (set) {
      for (const k of aliasKeys) set.delete(k)
      // Clear any legacy bare entry too, so unhide always lands.
      const bare = String(username == null ? '' : username)
        .toLowerCase()
        .replace(/^@/, '')
      if (bare) set.delete(bare)
      if (set.size === 0) perTabHidden.delete(tab)
    }
    showToast(t('mc_input_tab_unhidden', [username]), 'success')
  }
  renderMessages(currentTab, { bypassScrollPause: true })
}

// Build the plain-text dump of a chat reply chain (ancestors + this + descendants)
// using the channel buffer walkers exposed by main.js. Returns null when the
// row isn't part of a multi-message thread, so the menu item only appears
// where it would do something.
function _extractMcChainText(msg) {
  if (!msg) return null
  const lookup = window.__hsMcLookupMsg
  const walk = window.__hsMcWalkThread
  if (typeof lookup !== 'function' || typeof walk !== 'function') return null
  const channel = msg.dataset.msgChannel || ''
  const platform = msg.dataset.msgPlatform || ''
  const ownId = msg.dataset.msgId || ''
  if (!ownId) return null
  const own = lookup(channel, platform, ownId)
  if (!own) return null
  const { ancestors, descendants } = walk(channel, platform, own, 128) || { ancestors: [], descendants: [] }
  const chain = [...ancestors, own, ...descendants]
  if (chain.length < 2) return null
  return chain.map(_formatMcChainLine).join('\n')
}

function _formatMcChainLine(m) {
  const user = m.displayName || m.user || m.username || 'anon'
  const text = (m.text || m.message || m.body || '').replace(/\s+/g, ' ').trim()
  return `${user}: ${text}`
}

// Robust clipboard copy: navigator.clipboard silently rejects in a content
// script when the doc isn't focused (the exact "why can't i copy" case), so
// fall back to a temp-textarea execCommand and always toast either way.
function mcCopyFallback(text) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
function mcCopyToClipboard(text, okMsg = t('mc_input_copied')) {
  if (!text) return
  const done = () => {
    try {
      showToast(okMsg, 'success')
    } catch {}
  }
  try {
    navigator.clipboard.writeText(text).then(done, () => {
      if (mcCopyFallback(text)) done()
    })
  } catch {
    if (mcCopyFallback(text)) done()
  }
}
// Drop a message's text into the input box (quote/reply-by-paste).
function mcQuoteToInput(text) {
  if (!text) return
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  if (typeof showInputBar === 'function') showInputBar()
  input.focus()
  const toInsert = `${text} `
  if (input.isContentEditable) {
    if (!document.execCommand('insertText', false, toInsert)) {
      input.textContent = (input.textContent || '') + toInsert
    }
  } else {
    input.value = (input.value || '') + toInsert
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function _extractMcMsgText(msg) {
  // Walk siblings after the username link, gathering text nodes + emote alts.
  // textContent on the whole row leaks badge/timestamp/username junk; this
  // gives the readable body a user would expect "copy message" to produce.
  const userEl = msg.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
  if (!userEl) return (msg.textContent || '').trim()
  const parts = []
  // Recursive walk: a node may interleave emotes and text (e.g.
  // "<emote> Kripp, when...") inside .hs-mc-text. querySelectorAll grabbed
  // only the emotes and dropped every text node between/after them, so a
  // message that started with an emote copied as just the emote name. Walk
  // every child in DOM order, emitting text nodes AND emote alts.
  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent)
      return
    }
    if (node.nodeType !== 1) return
    const cls = node.classList
    if (
      cls?.contains('hs-mc-platform-badge') ||
      cls?.contains('hs-mc-badge') ||
      cls?.contains('hs-mc-time') ||
      cls?.contains('hs-mc-reply-ctx') ||
      cls?.contains('hs-mc-reply-btn') ||
      cls?.contains('hs-mod-toolbar') ||
      cls?.contains('hs-mc-stack-collapse') ||
      cls?.contains('hs-mc-stack-block-all')
    )
      return
    if (node.tagName === 'IMG') {
      if (node.alt) parts.push(node.alt)
      return
    }
    if (cls?.contains('hs-mc-emoji')) {
      parts.push(node.textContent || '')
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  let node = userEl.nextSibling
  while (node) {
    walk(node)
    node = node.nextSibling
  }
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*:\s*/, '')
    .trim()
}

function _prefillMcInput(text) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  // Un-hide the composer first: switchTab auto-hides it when the input is empty,
  // so prefilling a still-hidden bar is why whisper/DM compose "won't reopen
  // without a refresh" (showInputBar early-returns on the session inputBarVisible
  // flag, only reset by a full reload). Mirror _mentionInMcInput.
  if (typeof showInputBar === 'function') showInputBar()
  input.focus()
  if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
    input.value = text
    try {
      input.setSelectionRange(text.length, text.length)
    } catch {}
    input.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    // mirror mcQuoteToInput: select-all + execCommand insertText replaces the
    // content, fires the input event, and leaves the caret at the end —
    // plain textContent assignment does none of that (caret stuck at 0, no
    // event, so char count / undo miss the change)
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    sel.removeAllRanges()
    sel.addRange(range)
    if (!document.execCommand('insertText', false, text)) {
      input.textContent = text
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
}

// Cross-platform whisper open: when the target is a kick/yt user, resolve to
// their linked twitch handle via /api/profile?platform= so the typed /w lands
// on the right twitch acct (whisper resolution only knows twitch). If they
// have no linked twitch, bail with a clear "try /dm" hint instead of letting /w 404.
// Op the right-clicked chat message to the heatsync feed. Posting emerges from
// chat, quoting the author with an @mention (which renders as a crawlable
// /user/ profile link server-side — attribution doubles as internal SEO).
// Self-contained POST; deliberately does NOT reuse postFeedMessage (which is
// coupled to the chat input and would clear the user's draft).
async function _quickOpToFeed(username, msg) {
  if (!hsAuthToken) {
    showToast(t('mc_social_login_first') || 'log in at heatsync.org first to post', 'error')
    return
  }
  const raw = ((typeof _extractMcMsgText === 'function' ? _extractMcMsgText(msg) : msg?.textContent) || '').trim()
  if (!raw) {
    showToast(t('mc_input_nothing_to_post'), 'error')
    return
  }
  const content = truncateSafe(`@${username}: ${raw}`, 500)
  try {
    const resp = await apiFetch('/api/messages', { method: 'POST', auth: true, body: { content } })
    showToast(resp?.ok ? t('mc_input_posted_to_feed') : t('mc_input_post_failed'), resp?.ok ? 'success' : 'error')
  } catch {
    showToast(t('mc_input_post_failed'), 'error')
  }
}

async function _openWhisperFor(username, platform) {
  if (typeof switchTab === 'function') switchTab('whispers')
  let whisperName = username
  if (platform && platform !== 'twitch') {
    try {
      const resp = await apiFetch(
        `/api/profile/${encodeURIComponent(username.toLowerCase())}?platform=${encodeURIComponent(platform)}`,
      )
      const tw = resp?.data?.profile?.twitch_username || resp?.data?.profile?._linked_twitch_username
      if (tw) {
        whisperName = tw
      } else {
        showToast(t('mc_input_no_twitch_try_dm', [username]), 'error')
        return
      }
    } catch {
      // network failed — fall back to raw name, let /w try resolveTwitchChannelId
    }
  }
  _prefillMcInput(`/w ${whisperName} `)
}

// Cross-platform DM open: resolve username with the chat's platform hint so
// kick/yt-only handles map to their heatsync username. Without the hint the
// server only matches by users.username — fails when handles differ.
async function _openDmFor(username, platform) {
  if (typeof switchTab === 'function') switchTab('whispers')
  let hsName = username
  if (platform && platform !== 'heatsync') {
    try {
      const resp = await apiFetch(
        `/api/profile/${encodeURIComponent(username.toLowerCase())}?platform=${encodeURIComponent(platform)}`,
      )
      const u = resp?.data?.profile?.username
      if (u) {
        hsName = u
      } else {
        showToast(t('mc_input_not_on_heatsync', [username]), 'error')
        return
      }
    } catch {
      // network failed — fall back to raw name, let /dm try server-side
    }
  }
  _prefillMcInput(`/dm ${hsName} `)
}

function _mentionInMcInput(username) {
  showInputBar()
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  const mention = `@${username} `
  if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
    const cur = input.value
    input.value = (cur && !cur.endsWith(' ') ? `${cur} ` : cur) + mention
    input.focus()
    try {
      input.setSelectionRange(input.value.length, input.value.length)
    } catch {}
  } else {
    // Append WITHOUT clobbering existing emote chips: reading/writing
    // textContent on a contenteditable strips every <img> chip the user already
    // typed. Insert a trailing text node (leading space when needed) and move
    // the caret to the end, preserving the composed message.
    input.focus()
    const last = input.lastChild
    const needsSpace = !!last && !(last.nodeType === Node.TEXT_NODE && /\s$/.test(last.textContent || ''))
    input.appendChild(document.createTextNode((needsSpace ? ' ' : '') + mention))
    try {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch {}
    pendingMessage = getInputText()
  }
}

// Generic numbered/keyboard context menu. `items` is an array of either the
// string 'sep' or { label, fn, danger, good, disabled }. Actionable items are
// numbered 1..9 top-down for keyboard select. Used by every right-click surface.
function showHsCtxMenu(x, y, header, items) {
  document.getElementById('hs-mc-msg-ctx')?.remove()
  const menu = document.createElement('div')
  menu.id = 'hs-mc-msg-ctx'
  menu.className = 'hs-mc-ctx'
  menu.tabIndex = -1
  menu.addEventListener('contextmenu', (e) => e.preventDefault())

  const kbdHandlers = {}
  const kbdItems = [] // {el, fn} in DOM order; numbered 1..9 from the top
  if (header) {
    const h = document.createElement('div')
    h.className = 'hs-mc-em-header'
    h.textContent = header
    menu.appendChild(h)
  }
  for (const spec of items) {
    if (spec === 'sep') {
      const s = document.createElement('div')
      s.className = 'hs-mc-em-sep'
      menu.appendChild(s)
      continue
    }
    const it = document.createElement('div')
    it.className =
      'hs-mc-em-item' +
      (spec.danger ? ' hs-mc-em-danger' : '') +
      (spec.good ? ' hs-mc-em-good' : '') +
      (spec.disabled ? ' hs-mc-em-disabled' : '')
    if (spec.key) it.dataset.hsKey = spec.key
    const lab = document.createElement('span')
    lab.className = 'hs-mc-em-label'
    lab.textContent = spec.label
    it.appendChild(lab)
    if (!spec.disabled && spec.fn) {
      kbdItems.push({ el: it, fn: spec.fn })
      it.addEventListener('click', () => {
        dismiss()
        try {
          spec.fn()
        } catch {}
      })
    }
    menu.appendChild(it)
  }
  // Number top-down (key 1 is the first item, ascending downward).
  for (let i = 0; i < kbdItems.length && i < 9; i++) {
    const { el, fn } = kbdItems[i]
    const n = i + 1
    const k = document.createElement('span')
    k.className = 'hs-mc-em-kbd'
    k.textContent = String(n)
    el.appendChild(k)
    kbdHandlers[String(n)] = fn
  }

  document.body.appendChild(menu)
  menu.style.visibility = 'hidden'
  menu.style.left = '0px'
  menu.style.top = '0px'
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight
  const vw = window.innerWidth,
    vh = window.innerHeight
  const flipX = x + mw + 8 > vw
  const flipY = y + mh + 8 > vh
  menu.style.left = `${flipX ? Math.max(4, x - mw) : Math.min(x, vw - mw - 4)}px`
  menu.style.top = `${flipY ? Math.max(4, y - mh) : Math.min(y, vh - mh - 4)}px`
  if (flipX) menu.classList.add('hs-mc-em-flip-x')
  if (flipY) menu.classList.add('hs-mc-em-flip-y')
  menu.style.visibility = ''
  try {
    menu.focus({ preventScroll: true })
  } catch {}

  function dismiss() {
    menu.remove()
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', keyHandler, true)
    document.removeEventListener('contextmenu', outside, true)
  }
  function outside(ev) {
    if (!menu.contains(ev.target)) dismiss()
  }
  function keyHandler(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      dismiss()
      return
    }
    const fn = kbdHandlers[ev.key]
    if (fn) {
      ev.preventDefault()
      dismiss()
      try {
        fn()
      } catch {}
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', keyHandler, true)
    document.addEventListener('contextmenu', outside, true)
  }, 0)
}
function applyMcMutes() {
  // No muted users → nothing to strip. Skip the full-DOM scan entirely (this runs
  // on every renderMessages — up to 500 rows × a nested querySelector each — and is
  // pure waste for the vast majority of viewers who've muted nobody). Fresh rows are
  // built un-muted and live appends mute themselves in appendMessage, so there's no
  // stale muted state to clear when the set is empty. isUserMuted only ever returns
  // true for a name in (or aliased into) mutedUsers, so size 0 = no mutes.
  if (typeof mutedUsers === 'undefined' || mutedUsers.size === 0) return
  document.querySelectorAll('.hs-mc-msg').forEach((msg) => {
    const userEl = msg.querySelector('.hs-mc-user')
    const username = userEl?.textContent?.trim()?.toLowerCase()
    const platform = userEl?.dataset?.platform
    const muted =
      username && (typeof isUserMuted === 'function' ? isUserMuted(username, platform) : mutedUsers.has(username))
    if (muted) {
      stripMcMutedMessage(msg)
    } else {
      msg.classList.remove('hs-mc-muted')
    }
  })
}
function restoreMcUnmutedDom(username) {
  // stripMcMutedMessage destroys content irreversibly. Remove those rows so the
  // next renderMessages() call rebuilds them from the buffer's _renderedHtml cache.
  const target = username?.toLowerCase()
  document.querySelectorAll('.hs-mc-msg.hs-mc-muted').forEach((msg) => {
    const userEl = msg.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
    const u = userEl?.textContent?.trim()?.toLowerCase()
    if (!target || u === target) msg.remove()
  })
}
function stripMcMutedMessage(msg) {
  msg.classList.add('hs-mc-muted')
  // Message content is raw text nodes on the div — CSS can't hide those
  ;[...msg.childNodes].forEach((node) => {
    if (node.nodeType === 3) node.textContent = ''
  })
  // Mention links share .hs-mc-user (so they get color/hover) but live inside
  // the message body — strip them or they leak through the muted CSS.
  msg.querySelectorAll('.hs-mc-mention, .hs-mc-reply-ctx').forEach((el) => {
    el.remove()
  })
  // Remove emote images and other content (not user/badge/timestamp/platform)
  msg.querySelectorAll('img:not(.hs-mc-badge-img), .heatsync-emote-wrapper, .hs-mc-emote').forEach((el) => {
    if (
      !el.closest('.hs-mc-user') &&
      !el.classList.contains('hs-mc-badge-img') &&
      !el.classList.contains('hs-mc-platform-badge')
    ) {
      el.remove()
    }
  })
}

function updateInputPlaceholder() {
  const input = document.getElementById('hs-mc-input')
  if (!input) return

  let placeholder
  if (currentTab === 'feed') {
    placeholder = t('mc_input_post_heatsync')
  } else if (currentTab === 'live') {
    let channel = getLiveChannel()
    // yt video page: getLiveChannel() is the raw 11-char videoId — meaningless
    // as a label ("send to #jfKfPfyJRdk"). Show the channel name resolved by
    // the youtube_status connected echo instead; until it arrives (or for a
    // dead stream, where it never does) fall back to the generic prompt.
    if (typeof hostPlatform !== 'undefined' && hostPlatform === 'yt') {
      channel = resolveYtLiveLabel(channel, {
        isYtVideoPage: /\/watch|\/live\/|\/live_chat/.test(location.pathname + location.search),
        autoVideoId: typeof _autoYtVideoId !== 'undefined' ? _autoYtVideoId : null,
        resolvedName: (typeof youtubeLinks !== 'undefined' && youtubeLinks.get('__live_yt_auto__')?.channelName) || '',
      })
    }
    // No resolvable channel (e.g. /directory, /settings — the panel still streams
    // your configured tabs, but the live tab has nothing selected). Saying "send a
    // message..." promises a send that can't happen: Enter just flashes red. Name
    // the actual state instead.
    placeholder = channel ? t('mc_input_send_channel', [channel]) : t('mc_input_no_channel')
  } else if (currentTab === 'mentions') {
    // Mentions aggregates across channels, so sendMessage refuses every plain
    // send here — promising "send to #channel" was a lie regardless of whether
    // a channel resolved.
    placeholder = t('mc_input_mentions_readonly')
  } else if (currentTab === 'whispers') {
    // armed target names the placeholder and must not flip when an incoming
    // whisper retargets lastWhisperKey out from under it
    const targetKey = (typeof armedReplyKey !== 'undefined' && armedReplyKey) || lastWhisperKey
    const lastUser = targetKey ? whisperUsers.get(targetKey) : null
    placeholder = lastUser ? `/r to reply to ${lastUser.displayName}` : t('mc_whisper_hint')
  } else if (currentTab === 'add') {
    placeholder = ''
  } else {
    // Channel tab — resolve display name for placeholder
    const ch = config.channels.find((c) => c.id === currentTab)
    const chanName =
      ch?.twitch ||
      ch?.kick ||
      ch?.youtube?.replace(/^https?:\/\/(www\.)?youtube\.com\/@?/, '').replace(/\/.*/, '') ||
      ch?.id
    // chanName can come back undefined for a half-built channel entry (all four
    // fallbacks empty). The no-channel copy is the honest thing to show then —
    // t() no longer leaks the raw key either way, but don't render "send to #".
    placeholder = chanName ? t('mc_input_send_channel', [chanName]) : t('mc_input_no_channel')
  }

  if (wysiwygEnabled) {
    input.dataset.placeholder = placeholder
  } else {
    input.placeholder = placeholder
  }
}
function handleInputKeydown(e) {
  const input = e.target

  // Stop propagation so platform shortcuts (Kick theater "t", etc.) don't fire
  e.stopPropagation()

  // The whole body is wrapped: an exception thrown by ANY autocomplete-intercept
  // branch below (slash/emoji/mention) would otherwise abort this function
  // mid-flight and silently eat the keystroke — Enter looks like it does
  // nothing at all, no toast, no error visible anywhere (2026-07-20: exactly
  // this symptom hit live, root cause never conclusively pinned down). Never
  // let a completion-popup edge case swallow a real send.
  try {
    return handleInputKeydownInner(e, input)
  } catch (err) {
    log('handleInputKeydown error, falling back to plain send:', err?.message || err)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }
}

function handleInputKeydownInner(e, input) {
  // Slash dropdown navigation — intercept before emoji/tab/enter
  if (slashAcState.active) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashAcState.index = (slashAcState.index + 1) % slashAcState.matches.length
      showSlashDropdown(slashAcState.matches, slashAcState.index)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashAcState.index = (slashAcState.index - 1 + slashAcState.matches.length) % slashAcState.matches.length
      showSlashDropdown(slashAcState.matches, slashAcState.index)
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      const sel = slashAcState.matches[slashAcState.index]
      if (sel) insertSlashCommand(sel)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      hideSlashDropdown()
      return
    }
  }

  // Colon dropdown (emotes + emoji) navigation — intercept before other
  // handlers. Selection routes through insertEmojiFromDropdown, which hands
  // off to acState so subsequent Tabs keep cycling the same ranked list —
  // see that function for why no separate "wire up cycling" code lives here.
  if (emojiAcState.active) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      emojiAcState.index = (emojiAcState.index + 1) % emojiAcState.matches.length
      showEmojiDropdown(emojiAcState.matches, emojiAcState.index)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      emojiAcState.index = (emojiAcState.index - 1 + emojiAcState.matches.length) % emojiAcState.matches.length
      showEmojiDropdown(emojiAcState.matches, emojiAcState.index)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertEmojiFromDropdown(emojiAcState.matches[emojiAcState.index])
      showCycleTooltip()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      hideEmojiDropdown()
      return
    }
  }

  // @-mention dropdown navigation — same shape as the colon dropdown above.
  // Only intercepts keys while genuinely open (a real "@word" is at the
  // caret with matches); Enter never gets swallowed when it's closed, so
  // Enter=send is untouched the rest of the time.
  if (mentionAcState.active) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionAcState.index = (mentionAcState.index + 1) % mentionAcState.matches.length
      showMentionDropdown(mentionAcState.matches, mentionAcState.index)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionAcState.index = (mentionAcState.index - 1 + mentionAcState.matches.length) % mentionAcState.matches.length
      showMentionDropdown(mentionAcState.matches, mentionAcState.index)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      insertMentionFromDropdown(mentionAcState.matches[mentionAcState.index])
      showCycleTooltip()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      hideMentionDropdown()
      return
    }
  }

  // Message history navigation (ArrowUp/ArrowDown)
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && mcMessageHistory.length > 0) {
    const currentText = getInputText().trim()
    if (
      mcHistoryIndex >= 0 ||
      (e.key === 'ArrowUp' && currentText.length === 0) ||
      (e.key === 'ArrowUp' && mcMessageHistory.includes(currentText))
    ) {
      e.preventDefault()
      if (e.key === 'ArrowUp') {
        if (mcHistoryIndex < 0) mcHistoryDraft = currentText
        mcHistoryIndex = Math.min(mcHistoryIndex + 1, mcMessageHistory.length - 1)
      } else {
        mcHistoryIndex--
      }
      const text = mcHistoryIndex < 0 ? mcHistoryDraft : mcMessageHistory[mcHistoryIndex]
      if (wysiwygEnabled) {
        restoreWysiwygText(input, text)
      } else {
        input.value = text
      }
      mcHistoryIndex = Math.max(mcHistoryIndex, -1)
      return
    }
  }

  // Backspace at the boundary of an input emote / stack — delete the whole
  // unit instead of letting contenteditable nibble at child overlays one at
  // a time. "input emote unit" = .hs-input-emote IMG or .hs-input-stack span.
  if (e.key === 'Backspace' && wysiwygEnabled && input?.isContentEditable) {
    const sel = window.getSelection()
    if (sel?.rangeCount && sel.isCollapsed) {
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      const offset = range.startOffset
      const isInputEmoteUnit = (el) =>
        el?.nodeType === Node.ELEMENT_NODE &&
        ((el.tagName === 'IMG' && el.classList?.contains('hs-input-emote')) || el.classList?.contains('hs-input-stack'))
      let target = null
      if (node.nodeType === Node.TEXT_NODE) {
        // At start of text node → previous sibling
        if (offset === 0 && isInputEmoteUnit(node.previousSibling)) {
          target = node.previousSibling
        }
        // After a single leading space following an emote → consume the space
        // first, then on the next backspace the unit deletes (no double-jump).
        else if (
          offset === 1 &&
          (node.textContent[0] === ' ' || node.textContent[0] === ' ') &&
          isInputEmoteUnit(node.previousSibling)
        ) {
          // Consume the auto-space on this Backspace; the next press will
          // land at offset 0 and pop the chip. Two presses total — matches
          // typed-space semantics so a Tab-inserted unit deletes as if the
          // user had typed "Kappa" + space themselves.
          e.preventDefault()
          node.textContent = node.textContent.slice(1)
          const r = document.createRange()
          r.setStart(node, 0)
          r.collapse(true)
          sel.removeAllRanges()
          sel.addRange(r)
          pendingMessage = getInputText()
          return
        }
      } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
        // Cursor between element children: previous child
        const prev = node.childNodes[offset - 1]
        if (isInputEmoteUnit(prev)) target = prev
      }
      if (target) {
        // Just delete the one chip — never auto-merge adjacent chips back
        // to text. The "merge intent" path was destroying valid WYSIWYG
        // state on every backspace.
        e.preventDefault()
        target.remove()
        pendingMessage = getInputText()
        updateCharCount()
        return
      }
    }
  }

  // Tab - cycle through emote completions OR apply FFZ modifier to prev emote
  if (e.key === 'Tab') {
    e.preventDefault()

    // Slash commands take absolute priority over emote-completion — typing a
    // partial command must NEVER let Tab fall through to inserting an
    // unrelated emote (2026-07-20 live incident: Tab on "/announce" inserted
    // a random channel emote instead of completing the command — the
    // dropdown-driven slashAcState.active gate above wasn't reliably true for
    // every registered command, root cause never conclusively pinned down).
    // Independent, direct lookup here so slash Tab-complete can't regress to
    // emote insertion again regardless of that dropdown's internal state.
    const _slashTabText = getInputText()
    const _slashTabM = _slashTabText.match(/^\/([a-z?]*)$/i)
    if (_slashTabM) {
      const _slashTabQ = _slashTabM[1].toLowerCase()
      const _slashTabMatches = matchSlashCommands(_slashTabQ)
      if (_slashTabMatches.length > 0) {
        insertSlashCommand(_slashTabMatches[0])
        return
      }
    }

    // A Tab-cycle only makes sense while the caret still sits on the
    // completion it's refining. The caret can move WITHOUT the keydown/input
    // teardown ever firing (mouse click, programmatic focus reassert) —
    // cycling then rewrites a chip far from the caret (wysiwyg finds the
    // .hs-cycling-* marker ANYWHERE in the input) or, in plain mode, rebuilds
    // the whole value from stale wordStart/afterText and erases everything
    // typed since. Finalize the abandoned completion and let this Tab be a
    // fresh first-Tab on the word under the caret.
    if (acState.active && acState.matches.length > 0 && !caretOnActiveCompletion(input)) {
      hideAutocomplete()
    }

    // FFZ-style modifier on Tab — scans ENTIRE input (not just cursor) for any
    // modifier shorthand adjacent to an emote, applies them all in one shot.
    // Type `Kappa w` then Tab from any cursor position → wide Kappa.
    // Completion intent wins first, though: when the caret sits on a
    // completable word (>=2 chars — the first-Tab threshold), Tab means
    // "complete THIS word". The sweep used to hijack the press — it would eat
    // a stray modifier-lookalike token elsewhere in the input (a literal "Z"
    // between two emotes) and return, so the completion never ran and the
    // token silently vanished.
    // ...unless the caret word IS an unambiguous modifier. "Kappa w!" + Tab did
    // nothing: `w!` is 2 chars, so the completion-intent guard below took the
    // press — and emote completion refuses modifier tokens outright (see
    // findEmoteMatches), so Tab became a no-op and the sweep never ran. Same for
    // every longer form the guard swallowed whole: `z!`, `c!#ff8700`, chains like
    // `w!h!`, and every ffz* effect emote (`Kappa ffzLeave` + Tab). A word that
    // classifies as a modifier is never a completable emote name, so there's no
    // intent to lose here.
    const _tabWord = getCurrentWord(input)
    const _tabWordIsMod = hsModClassify(_tabWord, { allowPrefix: false }).kind === 'modifier'
    if (!acState.active && (_tabWord.length < 2 || _tabWordIsMod)) {
      if (scanAndApplyModifiersInInput(input)) return
      // Tab also commits a pending "<emote>0" / "<emoji>0" overlay (parity with
      // the live typing path) — overlay onto the left, drop the trailing 0.
      if (wysiwygEnabled && input?.isContentEditable && tryOverlayOnZero(input)) return
    }

    if (acState.active && acState.matches.length > 0) {
      // Already cycling - next (Tab) or previous (Shift+Tab)
      const len = acState.matches.length
      // Forward past the last match: if 7TV/BTTV/FFZ hits are still coming (in
      // flight, or not yet fetched), HOLD instead of wrapping to 1 — the user
      // asked to keep cycling into remote (13/13 → 14/99), not loop. Once they
      // append + re-sort (position preserved), the next Tab advances into them.
      const atEnd = !e.shiftKey && acState.index + 1 >= len
      const remoteMayCome = acState.remotePending || (!acState.remoteDone && acRemoteEligible(acState.search))
      if (atEnd && remoteMayCome) {
        if (!acState.remoteDone && !acState.remotePending && acState.search) {
          fetchRemoteEmoteMatches(acState.search)
        }
        showCycleTooltip()
        return
      }
      acState.index = (acState.index + (e.shiftKey ? len - 1 : 1)) % len
      insertCompletionKeepOpen(acState.matches[acState.index])
      // Lazy 7TV/BTTV/FFZ search: when you get WITHIN AC_REMOTE_LOOKAHEAD of the
      // end (cycling either direction), pull the next catalog page so the hits
      // are already merged by the time you reach the last one — no hold, no
      // wrap, 20/20 flows straight into 21/N. The common case (your channel/
      // own/global emote is right there) never touches the network, and each
      // approach to the merged end pulls one more page (up to the cap).
      // Triggered before the tooltip so it can show "searching 7tv…" live.
      if (
        !acState.remoteDone &&
        !acState.remotePending &&
        acState.index >= len - 1 - AC_REMOTE_LOOKAHEAD &&
        acState.search
      ) {
        fetchRemoteEmoteMatches(acState.search)
      }
      showCycleTooltip()
    } else {
      // First Tab - find matches. WYSIWYG: if the typed word touches a preceding
      // emote chip (auto-space backspaced, then chars typed), unwrap+merge first
      // so re-completion searches the full word (SupHomie + 3 → SupHomie3).
      if (wysiwygEnabled) mergeChipIntoWordForRecompletion(input)
      const word = getCurrentWord(input)
      if (word.length >= 2) {
        const matches = findEmoteMatches(word)
        // Set up cycling state even with zero local matches — the cross-provider
        // remote search (7TV/BTTV/FFZ) may still populate it (e.g. an emote that
        // isn't in the channel's loaded set), and it auto-inserts on arrival.
        acState.matches = matches
        acState.index = 0
        acState.active = true
        acState.search = word
        acState.remoteDone = false
        acState.remotePending = false
        acState._remotePage = 0
        acState._remoteExhausted = null
        acState._aiSeq = 0

        // Calculate positions for text input cycling (textarea only)
        if (!wysiwygEnabled && input.value !== undefined) captureAcWordBounds(input)

        if (matches.length > 0) insertCompletionKeepOpen(matches[0])
        // The catalog search starts on the FIRST Tab, always — not lazily once
        // you cycle within LOOKAHEAD of the end. With locals present it costs
        // nothing visible: the local hit is already inserted above and the
        // merge is append-only, so the catalog lands AFTER your channel/global
        // emotes and your chip and position never move. You cycle straight
        // from 7/7 into 8/240 instead of stalling at the end waiting on a
        // fetch nobody had asked for yet. With no locals it is the only way to
        // complete the word, and it inserts the first remote hit on arrival.
        // Before showCycleTooltip on purpose: the fetch flips remotePending
        // synchronously, so the first tooltip already reads "searching 7tv…".
        fetchRemoteEmoteMatches(word)
        showCycleTooltip()
      }
    }
    return
  }

  // Any other key resets autocomplete cycling (ignore modifier keys)
  // (remember whether Escape just closed the cycle — that Escape is spent,
  // it must not also dismiss the composer below)
  const acWasActive = acState.active
  if (acState.active && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
    hideAutocomplete()
  }

  // Enter - send message
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
    return
  }

  // Escape - cancel reply state and hide autocomplete
  if (e.key === 'Escape') {
    if (replyState) {
      clearReplyState()
      hideInputBar() // explicit cancel — ok to re-hide an empty composer
    } else if (!acWasActive && autoHideEligible() && !getInputText().trim()) {
      // Keyboard-first dismiss: with nothing to close and nothing typed,
      // Escape on the empty composer means "done here". Blur so the
      // focused-composer guard passes and hide NOW — no other blur is ever
      // coming in a keyboard-only flow. Zero the rapid-fire/sticky windows:
      // an explicit Escape outranks post-send stickiness. (With vi mode on,
      // vi owns this Escape and its normal-mode hook does the same.)
      _composerStickyUntil = 0
      _keepComposerOpenUntil = 0
      input.blur()
      hideInputBar()
    }
    hideAutocomplete()
    return
  }
}

// Inline chips = atomic input pieces (emote IMG, stack, mention, emoji span).
function isInlineChip(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false
  return (
    (el.tagName === 'IMG' && el.classList?.contains('hs-input-emote')) ||
    el.classList?.contains('hs-input-stack') ||
    el.classList?.contains('hs-mc-user') ||
    el.classList?.contains('hs-mc-emoji')
  )
}

// Source-text representation of a chip (so unwrapping preserves what the
// user originally typed and lets them re-trigger conversion after fixing
// the missing space).
function chipToText(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null
  if (el.tagName === 'IMG' && el.classList?.contains('hs-input-emote')) {
    let txt = el.dataset.emoteName || el.alt || ''
    const mods = el.dataset.hsWords || el.dataset.hsModWords
    if (mods) {
      for (const w of mods.split(/\s+/).filter(Boolean)) txt += ` ${w}`
      // Trailing space keeps modifier tokens parseable when merged into adjacent
      // text — "Kappa w!" + "4He" must become "Kappa w! 4He", not "Kappa w!4He".
      txt += ' '
    }
    return txt
  }
  if (el.classList?.contains('hs-input-stack')) {
    const parts = []
    for (const child of el.children) {
      if (child.classList?.contains('hs-mc-emoji')) {
        const name = child.dataset.emojiName || child.getAttribute('data-emoji-name')
        parts.push(name ? `:${name}:` : child.textContent || '')
        continue
      }
      if (child.tagName !== 'IMG') continue
      let txt = child.dataset.emoteName || child.alt || ''
      const mods = child.dataset.hsWords || child.dataset.hsModWords
      if (mods) {
        for (const w of mods.split(/\s+/).filter(Boolean)) txt += ` ${w}`
        txt += ' '
      }
      parts.push(txt)
    }
    return parts.join(' ')
  }
  if (el.classList?.contains('hs-mc-user')) {
    const u = el.dataset.username || el.textContent || ''
    return el.dataset.completionType === 'user-bare' ? `@${u}` : u
  }
  if (el.classList?.contains('hs-mc-emoji')) {
    const name = el.dataset.emojiName || el.getAttribute('data-emoji-name')
    return name ? `:${name}:` : el.textContent || ''
  }
  return null
}

// Peel a trailing unicode emoji grapheme off a string. Used to stack an
// overlay emote onto a raw-typed/pasted emoji that was never converted to a
// .hs-mc-emoji span (only :shortcode: gets live-converted). Returns
// { emoji, rest } or null. Grapheme segmentation keeps ZWJ sequences, skin
// tones, and VS16 emoji intact.
function peelTrailingEmoji(s) {
  if (!s) return null
  let segmenter
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  } catch (_) {
    return null
  }
  const graphemes = [...segmenter.segment(s)].map((g) => g.segment)
  if (!graphemes.length) return null
  const last = graphemes[graphemes.length - 1]
  if (typeof UNICODE_EMOJI_RE === 'undefined' || !UNICODE_EMOJI_RE.test(last)) return null
  return { emoji: last, rest: graphemes.slice(0, -1).join('') }
}

// Resolve the element a zero-width completion should stack onto, looking LEFT
// from `node`: skip whitespace-only text nodes; an emote img / stack / emoji
// span is the base as-is; a text node ENDING in a raw unicode emoji gets that
// emoji wrapped into an atomic .hs-mc-emoji span (splitting the text node) and
// the span is the base. The split-node case is the one every caller used to
// miss: picker inserts and contenteditable splits routinely leave the emoji
// and the typed word in SEPARATE text nodes, the old prev-sibling scan only
// accepted elements, and the old peel only read the SAME node's before-text —
// so "🥔" + Tab-completed overlay landed standalone instead of stacking.
// Returns the base element, or null (never the node itself).
function resolveOverlayBaseLeft(node) {
  let prev = node?.previousSibling
  while (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent.trim() === '') prev = prev.previousSibling
  if (!prev) return null
  if (prev.nodeType === Node.ELEMENT_NODE) {
    if (
      (prev.tagName === 'IMG' && prev.classList.contains('hs-input-emote')) ||
      prev.classList?.contains('hs-input-stack') ||
      prev.classList?.contains('hs-mc-emoji')
    ) {
      return prev
    }
    return null
  }
  if (prev.nodeType !== Node.TEXT_NODE) return null
  const peeled = peelTrailingEmoji(prev.textContent.replace(/\s+$/, ''))
  if (!peeled) return null
  const parent = prev.parentNode
  if (!parent) return null
  // Wrap the emoji as an atomic span (same shape the :shortcode: converter
  // builds) so stackInputEmote gets a real element base.
  const span = document.createElement('span')
  span.className = 'hs-mc-emoji'
  span.textContent = peeled.emoji
  span.setAttribute('contenteditable', 'false')
  parent.insertBefore(span, prev.nextSibling)
  if (peeled.rest) prev.textContent = peeled.rest
  else prev.remove()
  return span
}

// If the word being auto-converted starts at offset 0 of its text node and
// the previous sibling is a chip with no whitespace separator, unwrap that
// chip back to plain text and signal the caller to skip the conversion.
// Both the chip and the word stay as plain text so the user can see the
// missing space and add it.
function deflectAdjacentChip(node, wordStart) {
  if (wordStart !== 0) return false
  const prev = node.previousSibling
  if (!isInlineChip(prev)) return false
  const chipText = chipToText(prev)
  if (chipText == null) return false
  prev.parentNode.replaceChild(document.createTextNode(chipText), prev)
  pendingMessage = getInputText()
  return true
}

// Re-imagify whitespace-bounded emote names inside a plain text node — the
// recall/paste/undo path that turns a serialized wire string back into chips.
function imagifyValidWordsInTextNode(textNode) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false
  if (typeof lookupEmoteWithOverlay !== 'function') return false
  const text = textNode.textContent
  if (!text.trim()) return false
  const parts = text.split(/(\s+)/)
  const replacements = []
  let didChange = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (/^\s+$/.test(part)) {
      replacements.push(document.createTextNode(part))
      continue
    }
    const hasLeftWs = i === 0 || (parts[i - 1] && /^\s+$/.test(parts[i - 1]))
    const hasRightWs = i === parts.length - 1 || (parts[i + 1] && /^\s+$/.test(parts[i + 1]))
    if (!hasLeftWs || !hasRightWs) {
      replacements.push(document.createTextNode(part))
      continue
    }
    // Blocked emotes must stay plain text here — keep them out of the chip
    // builder so a blocked emote reaching a text node (paste/undo/recall/
    // unwrap) can't render as a live image and defeat the block.
    if (typeof blockedEmoteNames !== 'undefined' && blockedEmoteNames.has(part)) {
      replacements.push(document.createTextNode(part))
      continue
    }
    let resolved = null
    try {
      resolved = lookupEmoteWithOverlay(part)
    } catch (_) {}
    if (!resolved?.emote) {
      replacements.push(document.createTextNode(part))
      continue
    }
    // Build via the shared createInputEmoteImg — it stamps alt/dataset.emoteName
    // from the TYPED WORD (pool entries key on the name and don't carry a .name
    // field, so reading emote.name here produced "undefined" chips on recall),
    // and applies res-url + state + overlay parity with the type/paste path.
    const chip = typeof createInputEmoteImg === 'function' ? createInputEmoteImg(part) : null
    if (!chip) {
      replacements.push(document.createTextNode(part))
      continue
    }
    replacements.push(chip)
    didChange = true
  }
  if (!didChange) return false
  const frag = document.createDocumentFragment()
  for (const n of replacements) frag.appendChild(n)
  textNode.parentNode.replaceChild(frag, textNode)
  return true
}

// Restore a plain wire-text string into the WYSIWYG composer AS chips. History
// recall and pending-send retry store the serialized plain form (e.g.
// "KEKW hello"); writing it straight to textContent shows raw emote names, so
// re-imagify each resulting text node and drop the caret at the end.
function restoreWysiwygText(input, text) {
  if (!input) return
  input.textContent = text
  for (const child of [...input.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) imagifyValidWordsInTextNode(child)
  }
  try {
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {}
}

function unwrapStuckChips(inputEl, acceptWhitespace) {
  if (!inputEl) return false
  let changed = false
  let cursorTarget = null
  let cursorOffset = 0
  // Bounded loop so a malformed DOM can't spin forever.
  for (let pass = 0; pass < 50; pass++) {
    const allChips = inputEl.querySelectorAll('img.hs-input-emote, .hs-input-stack, .hs-mc-user, .hs-mc-emoji')
    // Skip imgs nested inside a stack — overlay children are LEGITIMATELY
    // touching (that's the whole point of stacking). Without this filter,
    // every stacked emote collapses to "KappaWave" text on the next input.
    const chips = [...allChips].filter(
      (c) =>
        !(
          c.parentElement?.classList?.contains('hs-input-stack') &&
          (c.tagName === 'IMG' || c.classList?.contains('hs-mc-emoji'))
        ),
    )
    let pair = null
    for (let i = 0; i < chips.length - 1; i++) {
      const a = chips[i]
      const b = chips[i + 1]
      if (a.parentNode !== b.parentNode) continue
      let n = a.nextSibling
      let blocked = false
      const between = []
      while (n && n !== b) {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.length > 0) {
          if (acceptWhitespace && /^\s+$/.test(n.textContent)) {
            between.push(n)
            n = n.nextSibling
            continue
          }
          blocked = true
          break
        }
        between.push(n)
        n = n.nextSibling
      }
      if (!blocked) {
        pair = { a, b, between }
        break
      }
    }
    if (!pair) break
    const aText = chipToText(pair.a)
    const bText = chipToText(pair.b)
    if (aText == null || bText == null) break
    // Two adjacent valid chips (paste of an emote name right after an
    // existing chip is the common case) — insert a single space between them
    // instead of collapsing both into "WaVeWaVe" plain text. Wire payload
    // becomes `WaVe WaVe` which parses correctly on the receiver. The
    // original unwrap-to-text path destroyed both chips on every paste.
    const isValidChip = (el) =>
      (el.tagName === 'IMG' && el.classList?.contains('hs-input-emote')) ||
      el.classList?.contains('hs-input-stack') ||
      el.classList?.contains('hs-mc-emoji') ||
      el.classList?.contains('hs-mc-user')
    if (isValidChip(pair.a) && isValidChip(pair.b)) {
      for (const m of pair.between) m.remove()
      const space = document.createTextNode(' ')
      pair.a.parentNode.insertBefore(space, pair.b)
      cursorTarget = space
      cursorOffset = 1
      changed = true
      continue
    }
    const merged = aText + bText
    const parent = pair.a.parentNode
    const textNode = document.createTextNode(merged)
    for (const m of pair.between) m.remove()
    pair.b.remove()
    parent.replaceChild(textNode, pair.a)
    cursorTarget = textNode
    cursorOffset = aText.length
    changed = true
  }
  // After merging, re-imagify whitespace-separated valid emote names in the
  // resulting text so only the touching boundary stays as text. Matches
  // what the chat-side parseEmotes will render from the wire.
  if (changed) {
    for (const child of [...inputEl.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) imagifyValidWordsInTextNode(child)
    }
  }
  if (changed && cursorTarget?.parentNode) {
    const sel = window.getSelection()
    if (sel) {
      const r = document.createRange()
      r.setStart(cursorTarget, Math.min(cursorOffset, cursorTarget.textContent.length))
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    }
    pendingMessage = getInputText()
  }
  return changed
}

function handleInputChange(_e) {
  // Defensive: pull any stray text nodes out of .hs-input-stack spans.
  // Stacks are inline-grid with overlay imgs at grid-area 1/1; a text node
  // inside auto-places in a new row and renders BELOW the emote. If the
  // cursor was inside the stack when the user typed (e.g. clicked an emote
  // in the stack, or a path that left selection inside), text gets trapped.
  // Also retro-fits contenteditable=false on legacy stacks built before
  // this fix so the cursor can't re-enter.
  const inputEl = document.getElementById('hs-mc-input')
  if (inputEl) {
    for (const stack of inputEl.querySelectorAll('.hs-input-stack')) {
      if (stack.getAttribute('contenteditable') !== 'false') {
        stack.setAttribute('contenteditable', 'false')
      }
      let n = stack.firstChild
      while (n) {
        const next = n.nextSibling
        // Keep IMG (emote base/overlay) AND .hs-mc-emoji (emoji base/overlay) —
        // both are legitimate stack children. Evict only trapped text/other nodes.
        if (
          n.nodeType === Node.TEXT_NODE ||
          (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'IMG' && !n.classList?.contains('hs-mc-emoji'))
        ) {
          stack.parentNode.insertBefore(n, stack.nextSibling)
        }
        n = next
      }
    }
    // Standalone emoji spans must be atomic too. Without contenteditable=false
    // the caret enters the span when the user backspaces the trailing space, so
    // the next typed char (e.g. the "0" of an emoji overlay) lands INSIDE the
    // span — where it inherits the 2x emoji font-size (huge) and never reaches
    // overlay detection. Retrofit cE=false and evict any non-emoji text to a
    // sibling right after the span, moving the caret there so tryOverlayOnZero
    // sees it as the next word.
    for (const em of inputEl.querySelectorAll('.hs-mc-emoji')) {
      if (em.closest('.hs-input-stack')) continue
      if (em.getAttribute('contenteditable') !== 'false') em.setAttribute('contenteditable', 'false')
      const name = em.dataset.emojiName || em.getAttribute('data-emoji-name')
      const want = name ? _ensureEmojiMap().get(name) : null
      const full = em.textContent || ''
      if (want && full !== want && full.startsWith(want)) {
        const extra = full.slice(want.length)
        em.textContent = want
        if (extra) {
          const t = document.createTextNode(extra)
          em.parentNode.insertBefore(t, em.nextSibling)
          const sel = window.getSelection()
          if (sel) {
            const r = document.createRange()
            r.setStart(t, t.textContent.length)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          }
        }
      }
    }
  }

  // Two chips with LITERALLY no content between them are unrecoverable
  // (wire payload reads as `KEKWPogChamp`) — unwrap as a paste/bug safety
  // net only. Never collapse on whitespace-between: that was eating WYSIWYG
  // state on every backspace ("turns to text").
  if (inputEl) unwrapStuckChips(inputEl, false)

  // Save pending message (persists across tab switches)
  pendingMessage = getInputText()

  // Slash command autocomplete — synchronous, only matches "/word" at start.
  // Text just serialized above (pendingMessage) — nothing mutates the DOM
  // between here and there, so reuse it instead of re-serializing.
  checkSlashAutocomplete(pendingMessage)

  // Debounced colon (emote/emoji) + @-mention dropdown autocomplete
  if (_emojiAcDebounce) cleanup.clearTimeout(_emojiAcDebounce)
  _emojiAcDebounce = cleanup.setTimeout(checkEmojiAutocomplete, 80)
  if (_mentionAcDebounce) cleanup.clearTimeout(_mentionAcDebounce)
  _mentionAcDebounce = cleanup.setTimeout(checkMentionAutocomplete, 80)

  // Reset autocomplete cycling on any text change
  if (acState.active) {
    hideAutocomplete()
  }

  // Live emoji conversion in contenteditable: :shortcode: → emoji span
  if (wysiwygEnabled && _ensureEmojiMap().size > 0) {
    const input = document.getElementById('hs-mc-input')
    if (input?.isContentEditable) {
      const sel = window.getSelection()
      if (!sel?.rangeCount) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node?.nodeType !== Node.TEXT_NODE) return
      const text = node.textContent
      const cursorOffset = range.startOffset
      // Look for :shortcode: ending at cursor
      const before = text.slice(0, cursorOffset)
      const match = before.match(/:([a-z0-9_]+):$/)
      if (match) {
        const emoji = _emojiMap.get(match[1])
        if (emoji) {
          const start = cursorOffset - match[0].length
          if (deflectAdjacentChip(node, start)) return
          // Replace the :shortcode: text with emoji span
          const span = document.createElement('span')
          span.className = 'hs-mc-emoji'
          span.textContent = emoji
          span.title = `:${match[1]}:`
          span.setAttribute('data-emoji-name', match[1])
          span.setAttribute('contenteditable', 'false') // atomic — caret can't enter
          const tail = text.slice(cursorOffset)
          const head = text.slice(0, start)
          // Trailing space prevents fused tokens on the wire.
          const trailing = !/^\s/.test(tail) ? ' ' : ''
          // Leading space when the new emoji lands right after an existing
          // chip — without it the chip-merge safeguard collapses both back
          // to plain text.
          let leading = ''
          if (!head) {
            const prev = node.previousSibling
            const prevIsChip =
              prev?.nodeType === Node.ELEMENT_NODE &&
              ((prev.tagName === 'IMG' && (prev.classList?.contains('hs-input-emote') || prev.dataset?.emoteName)) ||
                prev.classList?.contains('hs-input-stack') ||
                prev.classList?.contains('hs-mc-emoji') ||
                prev.classList?.contains('hs-mc-user'))
            if (prevIsChip) leading = ' '
          }
          const beforeNode = document.createTextNode(leading + head)
          const afterNode = document.createTextNode(trailing + tail)
          const parent = node.parentNode
          parent.insertBefore(beforeNode, node)
          parent.insertBefore(span, node)
          parent.insertBefore(afterNode, node)
          parent.removeChild(node)
          // Place cursor after emoji + space
          const newRange = document.createRange()
          newRange.setStart(afterNode, Math.min(trailing.length, afterNode.textContent.length))
          newRange.collapse(true)
          sel.removeAllRanges()
          sel.addRange(newRange)
          pendingMessage = getInputText()
          return
        }
      }
    }
  }

  // Note: "<emote>0" / "<emoji>0" overlays are committed on Tab (see the Tab
  // branch in handleInputKeydown), NOT live on the "0" keystroke — typing the 0
  // leaves it as plain text so the user can see it before confirming with Tab.

  // Live emote replacement: "emoteName " → <img> (triggered on space after emote name)
  if (wysiwygEnabled) {
    const input = document.getElementById('hs-mc-input')
    if (input?.isContentEditable) {
      const sel = window.getSelection()
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0)
        const node = range.startContainer
        if (node?.nodeType === Node.TEXT_NODE) {
          const text = node.textContent
          const cursor = range.startOffset
          const before = text.slice(0, cursor)
          const match = before.match(/(\S+)\s$/)
          if (match) {
            const word = match[1]
            // FFZ-style modifier token / chain — apply to the previous emote
            // (don't insert as BTTV emote even if "w!" is a real emote name).
            // Live-replace modifier path — delegate to shared lib + apply.
            const cls = hsModClassify(word, { allowPrefix: false })
            if (cls.kind === 'modifier') {
              const wordStart = cursor - match[0].length
              let prev = node.previousSibling
              while (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent.trim() === '') {
                prev = prev.previousSibling
              }
              // Only whitespace may sit between the anchor chip and the
              // modifier — "Kappa lol w!" is three words, not a wide Kappa.
              const targetImg = /^[\s ]*$/.test(text.slice(0, wordStart)) ? hsModAnchorEl(prev) : null
              if (targetImg) {
                {
                  hsModApplyToImg(targetImg, cls.mods, cls.hue, cls.words)
                  node.textContent = text.slice(0, wordStart) + (text.slice(cursor) || ' ')
                  const nr = document.createRange()
                  nr.setStart(node, wordStart)
                  nr.collapse(true)
                  sel.removeAllRanges()
                  sel.addRange(nr)
                  pendingMessage = getInputText()
                  return
                }
              }
              // Modifier without an anchor — keep as plain text, don't insert as BTTV emote
              return
            }
            // Live auto-convert: in-set emotes only. Channel/global emotes
            // (incl. lowercase word collisions like "what") stay text until Tab.
            let resolved = lookupEmoteWithOverlay(word, { ownedOnly: true })
            // Exception: a zero-width OVERLAY emote (e.g. "Wave") auto-stacks
            // onto a preceding emote even when it's only a channel/global emote
            // (not in your set). Overlays read as nonsense inline so there's no
            // "what"-style word-collision risk, and this mirrors how chat stacks
            // them without a space. Gated on an actual preceding base so a lone
            // overlay name typed as prose stays text until Tab.
            if (!resolved) {
              const ov = lookupEmoteWithOverlay(word)
              if (ov?.isOverlay) {
                const bt = text.slice(0, cursor - match[0].length)
                let stackable = false
                if (bt.trim() === '') {
                  // Non-mutating peek: element chip OR a preceding text node
                  // ending in a raw emoji both count as a base (split-node
                  // parity with resolveOverlayBaseLeft, which the insert path
                  // uses to actually wrap+stack).
                  let p = node.previousSibling
                  while (p && p.nodeType === Node.TEXT_NODE && p.textContent.trim() === '') p = p.previousSibling
                  stackable = !!(
                    p &&
                    (p.nodeType === Node.ELEMENT_NODE
                      ? (p.tagName === 'IMG' && p.classList.contains('hs-input-emote')) ||
                        p.classList?.contains('hs-input-stack') ||
                        p.classList?.contains('hs-mc-emoji')
                      : p.nodeType === Node.TEXT_NODE && !!peelTrailingEmoji(p.textContent.replace(/\s+$/, '')))
                  )
                } else {
                  stackable = !!peelTrailingEmoji(bt.replace(/\s+$/, ''))
                }
                if (stackable) resolved = ov
              }
            }
            // Blocked emotes never auto-render in the composer. A common word
            // that collides with a blocked owned emote name (e.g. "emote")
            // must stay plain text, not convert to the blocked-placeholder
            // chip (1×1 gif + dashed rect that reads as a broken emote).
            if (resolved && blockedEmoteNames.has(word)) resolved = null
            if (resolved) {
              const wordStart = cursor - match[0].length
              if (deflectAdjacentChip(node, wordStart)) return
              const img = createInputEmoteImg(word)
              if (img) {
                const beforeText = text.slice(0, wordStart)
                const afterText = text.slice(cursor)
                const parent = node.parentNode
                const isZeroWidth = resolved.isOverlay

                // Zero-width: stack onto previous emote if possible. The base
                // may be an element chip OR a raw emoji at the end of a
                // PRECEDING text node (split-node input — resolveOverlayBaseLeft
                // wraps it into a span base).
                if (isZeroWidth && beforeText.trim() === '') {
                  const prev = resolveOverlayBaseLeft(node)
                  if (prev) {
                    // Remove whitespace text nodes between prev and current
                    let ws = prev.nextSibling
                    while (ws && ws !== node) {
                      const rm = ws
                      ws = ws.nextSibling
                      rm.remove()
                    }
                    stackInputEmote(prev, img)
                    node.textContent = afterText || ' '
                    const newRange = document.createRange()
                    newRange.setStart(node, 0)
                    newRange.collapse(true)
                    sel.removeAllRanges()
                    sel.addRange(newRange)
                    pendingMessage = getInputText()
                    return
                  }
                }

                // Zero-width onto a raw unicode emoji typed/pasted as plain
                // text (never converted to a .hs-mc-emoji span). Peel the
                // trailing emoji, wrap it as a span, and stack onto it — parity
                // with chat's processEmotes, which treats emoji as a base.
                if (isZeroWidth) {
                  const peeled = peelTrailingEmoji(beforeText.replace(/\s+$/, ''))
                  if (peeled) {
                    const restNode = peeled.rest ? document.createTextNode(peeled.rest) : null
                    const emojiSpan = document.createElement('span')
                    emojiSpan.className = 'hs-mc-emoji'
                    emojiSpan.textContent = peeled.emoji
                    if (restNode) parent.insertBefore(restNode, node)
                    parent.insertBefore(emojiSpan, node)
                    stackInputEmote(emojiSpan, img)
                    node.textContent = afterText || ' '
                    const newRange = document.createRange()
                    newRange.setStart(node, 0)
                    newRange.collapse(true)
                    sel.removeAllRanges()
                    sel.addRange(newRange)
                    pendingMessage = getInputText()
                    return
                  }
                }

                // Regular emote: replace text with img
                const beforeNode = beforeText ? document.createTextNode(beforeText) : null
                const afterNode = document.createTextNode(afterText || ' ')
                if (beforeNode) parent.insertBefore(beforeNode, node)
                parent.insertBefore(img, node)
                parent.insertBefore(afterNode, node)
                parent.removeChild(node)
                const newRange = document.createRange()
                newRange.setStart(afterNode, 0)
                newRange.collapse(true)
                sel.removeAllRanges()
                sel.addRange(newRange)
                // Cascade: if afterNode begins with another emote name (the
                // "user just re-spaced two stuck names" pattern), imagify
                // those too, separated by nbsp. Stops as soon as the next
                // word isn't an emote, or has whitespace before it (the
                // user explicitly separated them). Skip overlay/zero-width
                // emotes \u2014 those need stack handling we don't replicate here.
                while (true) {
                  const cm = afterNode.textContent.match(/^(\S+)(\s|$)/)
                  if (!cm) break
                  const cName = cm[1]
                  const cResolved = lookupEmoteWithOverlay(cName, { ownedOnly: true })
                  if (!cResolved || cResolved.isOverlay || blockedEmoteNames.has(cName)) break
                  const cImg = createInputEmoteImg(cName)
                  if (!cImg) break
                  parent.insertBefore(document.createTextNode('\u00A0'), afterNode)
                  parent.insertBefore(cImg, afterNode)
                  // Keep the leading whitespace from after the consumed name
                  // \u2014 it acts as the user's explicit separator and also
                  // prevents the next iteration from cascading further.
                  const remaining = afterNode.textContent.slice(cName.length)
                  afterNode.textContent = remaining || ' '
                  newRange.setStart(afterNode, remaining ? 0 : 1)
                  newRange.collapse(true)
                  sel.removeAllRanges()
                  sel.addRange(newRange)
                  if (!remaining) break
                }
                pendingMessage = getInputText()
              }
            }
          }
        }
      }
    }
  }
}

// Commit an overlay-on-zero: when the word ending at the cursor is "<emote>0" or
// "<:emoji:>0" (the overlay convention), convert it to an overlay chip and stack
// it onto the emote/stack/emoji to its left, then leave a trailing space the user
// can backspace. Invoked on Tab (NOT live on the "0" keystroke). Entry shapes:
//   (1) "0" after an emote chip — chip name merged → "centipede0" overlay
//   (2) "0" after an emoji chip — that emoji span relocated as the overlay
//   (3) typed-out "centipede0" text word → emote overlay
//   (4) typed-out ":smile:0" text word → emoji overlay (if it never span-converted)
// Returns true if it consumed the word.
function tryOverlayOnZero(_input) {
  const sel = window.getSelection()
  if (!sel?.rangeCount || !sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  let node = range.startContainer
  let cursor = range.startOffset
  if (node.nodeType === Node.ELEMENT_NODE && cursor > 0) {
    const child = node.childNodes[cursor - 1]
    if (child?.nodeType === Node.TEXT_NODE) {
      node = child
      cursor = child.textContent.length
    }
  }
  if (node.nodeType !== Node.TEXT_NODE) return false
  const text = node.textContent
  const before = text.slice(0, cursor)
  const wm = before.match(/(\S+)$/)
  if (!wm) return false
  const nodeWord = wm[1]
  // Only fire once the word actually carries a trailing 0.
  if (!nodeWord.endsWith('0')) return false

  const touchesPrev = before.length === nodeWord.length
  const prevSib = touchesPrev ? node.previousSibling : null

  // Decide the overlay element: an emote img (created/merged), an existing emoji
  // span to relocate, or a freshly built emoji span.
  let overlayEl = null
  let mergedChip = null
  let relocateSpan = null
  let word = nodeWord

  if (
    prevSib?.nodeType === Node.ELEMENT_NODE &&
    prevSib.tagName === 'IMG' &&
    prevSib.classList?.contains('hs-input-emote')
  ) {
    // (1) emote chip + typed "0" → merge the chip's name into the word.
    const ct = chipToText(prevSib)
    const clean = ct ? ct.trim() : ''
    if (clean && !/\s/.test(clean)) {
      word = clean + nodeWord
      mergedChip = prevSib
    }
  } else if (prevSib?.classList?.contains('hs-mc-emoji') && nodeWord === '0') {
    // (2) emoji chip + typed "0" → relocate that emoji span as the overlay.
    relocateSpan = prevSib
  }

  if (relocateSpan) {
    overlayEl = relocateSpan
  } else {
    const resolved = typeof lookupEmoteWithOverlay === 'function' ? lookupEmoteWithOverlay(word) : null
    if (resolved?.isOverlay) {
      // (1)/(3) emote overlay
      overlayEl = typeof createInputEmoteImg === 'function' ? createInputEmoteImg(word) : null
    } else if (word.startsWith(':') && word.endsWith(':0') && word.length > 3) {
      // (4) literal ":smile:0" that never span-converted → build emoji overlay
      const ename = word.slice(1, -2)
      const echar = _ensureEmojiMap().get(ename)
      if (echar) {
        const span = document.createElement('span')
        span.className = 'hs-mc-emoji'
        span.textContent = echar
        span.title = `:${ename}:`
        span.setAttribute('data-emoji-name', ename)
        span.setAttribute('contenteditable', 'false')
        overlayEl = span
      }
    }
  }
  if (!overlayEl) return false

  if (mergedChip) mergedChip.remove()
  const wordStartInNode = cursor - nodeWord.length
  const beforeText = text.slice(0, wordStartInNode)
  const afterText = text.slice(cursor)
  const parent = node.parentNode
  // Where to start scanning left for a base: before the relocated emoji span
  // (case 2) or before this text node (all other cases).
  const searchStart = relocateSpan ? relocateSpan.previousSibling : node.previousSibling

  // Stack onto a preceding emote/stack/emoji. For a relocated emoji the word is
  // just "0" so beforeText is empty; for typed words require empty beforeText.
  if (relocateSpan || beforeText.trim() === '') {
    let prev = searchStart
    while (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent.trim() === '') {
      const rm = prev
      prev = prev.previousSibling
      rm.remove()
    }
    if (
      prev &&
      prev !== overlayEl &&
      prev.nodeType === Node.ELEMENT_NODE &&
      ((prev.tagName === 'IMG' && prev.classList.contains('hs-input-emote')) ||
        prev.classList?.contains('hs-input-stack') ||
        prev.classList?.contains('hs-mc-emoji'))
    ) {
      const stopAt = relocateSpan || node
      let ws = prev.nextSibling
      while (ws && ws !== stopAt) {
        const rm = ws
        ws = ws.nextSibling
        rm.remove()
      }
      stackInputEmote(prev, overlayEl) // appendChild moves overlayEl out of its old spot
      // Leave a trailing space the user can backspace; caret sits after it.
      const tail = afterText || ''
      node.textContent = (tail.startsWith(' ') ? '' : ' ') + tail
      const nr = document.createRange()
      nr.setStart(node, 1)
      nr.collapse(true)
      sel.removeAllRanges()
      sel.addRange(nr)
      pendingMessage = getInputText()
      return true
    }
    // Overlay onto a raw unicode emoji typed as plain text before the word
    // (only for non-relocate cases — relocate already has its element).
    if (!relocateSpan && typeof peelTrailingEmoji === 'function') {
      const peeled = peelTrailingEmoji(beforeText.replace(/\s+$/, ''))
      if (peeled) {
        const restNode = peeled.rest ? document.createTextNode(peeled.rest) : null
        const emojiSpan = document.createElement('span')
        emojiSpan.className = 'hs-mc-emoji'
        emojiSpan.textContent = peeled.emoji
        if (restNode) parent.insertBefore(restNode, node)
        parent.insertBefore(emojiSpan, node)
        stackInputEmote(emojiSpan, overlayEl)
        const tail = afterText || ''
        node.textContent = (tail.startsWith(' ') ? '' : ' ') + tail
        const nr = document.createRange()
        nr.setStart(node, 1)
        nr.collapse(true)
        sel.removeAllRanges()
        sel.addRange(nr)
        pendingMessage = getInputText()
        return true
      }
    }
  }

  // A relocated emoji with no base to sit on stays put — leave the "0" as text.
  if (relocateSpan) return false

  // No left base to overlay — drop in a standalone overlay chip + trailing space.
  const tail = afterText || ''
  const beforeNode = beforeText ? document.createTextNode(beforeText) : null
  const afterNode = document.createTextNode((tail.startsWith(' ') ? '' : ' ') + tail)
  if (beforeNode) parent.insertBefore(beforeNode, node)
  parent.insertBefore(overlayEl, node)
  parent.insertBefore(afterNode, node)
  parent.removeChild(node)
  const nr = document.createRange()
  nr.setStart(afterNode, 1)
  nr.collapse(true)
  sel.removeAllRanges()
  sel.addRange(nr)
  pendingMessage = getInputText()
  return true
}

function updateCharCount(precomputedText) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  const text = typeof precomputedText === 'string' ? precomputedText : getInputText()
  const len = text.length
  const over = len > 500
  input.classList.toggle('over-limit', over)

  // Highlight overflow chars for plain <input> using overlay div
  if (input.tagName === 'INPUT') {
    let wrap = document.getElementById('hs-mc-input-wrap')
    // Wrap input in container on first use
    if (!wrap && input.parentElement) {
      wrap = document.createElement('div')
      wrap.id = 'hs-mc-input-wrap'
      input.parentElement.insertBefore(wrap, input)
      wrap.appendChild(input)
    }
    let hl = document.getElementById('hs-mc-input-highlight')
    if (over) {
      if (!hl && wrap) {
        hl = document.createElement('div')
        hl.id = 'hs-mc-input-highlight'
        wrap.appendChild(hl)
      }
      if (hl) {
        // Build overlay using safe DOM methods
        hl.textContent = ''
        const safeSpan = document.createElement('span')
        safeSpan.className = 'hl-safe'
        const safeText = truncateSafe(text, 500)
        safeSpan.textContent = safeText
        const overSpan = document.createElement('span')
        overSpan.className = 'hl-over'
        overSpan.textContent = text.slice(safeText.length)
        hl.appendChild(safeSpan)
        hl.appendChild(overSpan)
        hl.scrollLeft = input.scrollLeft
        hl.style.display = ''
      }
      // Make real input text transparent so overlay shows through
      input.style.color = 'transparent'
      input.style.caretColor = '#000'
    } else {
      if (hl) hl.style.display = 'none'
      input.style.color = ''
      input.style.caretColor = ''
    }
  }
}

// Compute acState.wordStart/afterText for the CURRENT caret position in a
// plain-text (non-wysiwyg) input — the exact calculation the first Tab-press
// uses (Tab keydown handler above). Shared so a colon/@ dropdown selection
// replaces the identical span Tab-cycle would, instead of re-deriving it.
function captureAcWordBounds(input) {
  const text = input.value
  const pos = input.selectionStart
  const before = text.slice(0, pos)
  const wordStart = before.search(/\S+$/)
  acState.wordStart = wordStart >= 0 ? wordStart : pos
  let wordEnd = pos
  while (wordEnd < text.length && !/\s/.test(text[wordEnd])) wordEnd++
  acState.afterText = text.slice(wordEnd)
}

function getCurrentWord(input) {
  if (!input) return ''
  if (input.contentEditable === 'true') {
    const sel = window.getSelection()
    if (!sel.rangeCount) return ''
    const range = sel.getRangeAt(0)
    let container = range.startContainer
    let offset = range.startOffset
    if (container.nodeType === Node.ELEMENT_NODE && offset > 0) {
      const child = container.childNodes[offset - 1]
      if (child?.nodeType === Node.TEXT_NODE) {
        container = child
        offset = child.textContent.length
      }
    }
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.textContent
      const before = text.slice(0, offset)
      const after = text.slice(offset)
      const beforeMatch = before.match(/(\S+)$/)
      const afterMatch = after.match(/^(\S+)/)
      if (beforeMatch) return beforeMatch[1] + (afterMatch ? afterMatch[1] : '')
    }
    return ''
  }
  const text = input.value
  const pos = input.selectionStart
  const before = text.slice(0, pos)
  const after = text.slice(pos)
  const beforeMatch = before.match(/(\S+)$/)
  const afterMatch = after.match(/^(\S+)/)
  if (beforeMatch) return beforeMatch[1] + (afterMatch ? afterMatch[1] : '')
  return ''
}

// True while the caret still touches the completion acState is cycling.
// WYSIWYG: caret on the cycling chip (or the stack it joined), inside it, or in
// the text node directly following it (the auto-space the insert placed it in).
// Plain input: caret within the span the completion occupies —
// [wordStart .. wordStart+len+1] (the +1 is the auto-space the insert appends).
// Used by the Tab handler to detect an ABANDONED cycle: a mouse click moves the
// caret without any keydown/input teardown, and cycling from the new position
// would rewrite the old chip instead of completing the word under the caret.
function caretOnActiveCompletion(input) {
  if (!input) return false
  if (wysiwygEnabled && input.isContentEditable) {
    const el = input.querySelector('.hs-cycling-emote, .hs-cycling-text, .hs-cycling-user')
    if (!el) return false // marker gone (chip deleted/eaten) — nothing to cycle
    const chip = el.closest('.hs-input-stack') || el
    const sel = window.getSelection()
    if (!sel?.rangeCount) return false
    let node = sel.getRangeAt(0).startContainer
    const offset = sel.getRangeAt(0).startOffset
    if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
      const child = node.childNodes[offset - 1]
      if (child) node = child
    }
    if (node === chip || node === el || chip.contains(node)) return true
    return node.nodeType === Node.TEXT_NODE && node.previousSibling === chip
  }
  if (typeof input.selectionStart !== 'number') return false
  const m = acState.matches[acState.index]
  const len = m ? (m.type === 'emoji' ? (m.emoji || '').length : (m.name || '').length) : 0
  const pos = input.selectionStart
  return pos >= acState.wordStart && pos <= acState.wordStart + len + 1
}

// WYSIWYG re-completion across a chip boundary. After Tab completes an emote it
// becomes an atomic <img> chip; if the user backspaces the auto-space and types
// more (e.g. SupHomie + "3"), the typed text is a separate node and getCurrentWord
// would only see "3". When the caret's typed word DIRECTLY touches a preceding
// single-token chip (no whitespace between), unwrap that chip back to its source
// text and merge it into the word so the next Tab re-searches "SupHomie3".
// Returns true if it merged. Skips modified/stacked chips (their text contains
// spaces — merging "Kappa w!" + "3" is nonsense).
function mergeChipIntoWordForRecompletion(input) {
  if (!input?.isContentEditable) return false
  const sel = window.getSelection()
  if (!sel?.rangeCount || !sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  let node = range.startContainer
  let offset = range.startOffset
  if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
    const child = node.childNodes[offset - 1]
    if (child?.nodeType === Node.TEXT_NODE) {
      node = child
      offset = child.textContent.length
    }
  }
  if (node.nodeType !== Node.TEXT_NODE) return false
  const text = node.textContent
  const before = text.slice(0, offset)
  // Typed word must reach the very start of this text node, so it touches prev.
  const wm = before.match(/(\S+)$/)
  if (!wm || wm[1].length !== before.length) return false
  const prev = node.previousSibling
  const isChip =
    prev?.nodeType === Node.ELEMENT_NODE &&
    ((prev.tagName === 'IMG' && prev.classList?.contains('hs-input-emote')) ||
      prev.classList?.contains('hs-mc-user') ||
      prev.classList?.contains('hs-mc-emoji'))
  if (!isChip) return false
  const chipText = chipToText(prev)
  if (!chipText) return false
  const clean = chipText.trim()
  if (!clean || /\s/.test(clean)) return false // modified/stacked chip — skip
  prev.remove()
  node.textContent = clean + text
  const r = document.createRange()
  r.setStart(node, clean.length + offset)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
  pendingMessage = getInputText()
  return true
}

// "Recently active" = talked within RECENCY_WINDOW_MS, capped at RECENCY_MAX
// unique users. A count-only cap ages people out in seconds on ultra-fast chats
// (xQc churns 50 unique users in a blink), so a chatter you just saw talk would
// vanish from tab-complete; the time window keeps "recent" matching what a human
// sees, the count cap bounds walk cost + how aggressively chatters beat emotes.
const RECENCY_MAX = 150
const RECENCY_WINDOW_MS = 10 * 60 * 1000
function getRecencyMap() {
  // Returns Map<usernameLower, recencyRank> from current tab's chat buffer.
  // Lower rank = more recent. Merges Twitch/Kick irc buffer + YouTube buffer
  // (channelYtMessages) so YT-only chatters tab-complete on YT-only channels.
  const out = new Map()
  let ch = currentTab
  if (currentTab === 'live' && typeof getLiveChannel === 'function') ch = getLiveChannel()
  const ircMsgs = (ch && typeof irc !== 'undefined' && irc?.channels?.get(ch.toLowerCase())?.getAll?.()) || []
  // YT buffers are keyed by channel-entry id, never 'live' — on the live tab
  // the auto-followed stream lives under '__live_yt_auto__' (same merge
  // bootstrap's live hydration does). Without this, yt chatters never rank
  // in recency on the live tab / popout.
  let ytMsgs = (typeof channelYtMessages !== 'undefined' && channelYtMessages.get(currentTab)) || []
  if (currentTab === 'live' && typeof channelYtMessages !== 'undefined') {
    const autoYt = channelYtMessages.get('__live_yt_auto__') || []
    if (autoYt.length)
      ytMsgs = ytMsgs.length ? [...ytMsgs, ...autoYt].sort((a, b) => (a.time || 0) - (b.time || 0)) : autoYt
  }
  // Absolute floor: chatters active in the last 10 REAL minutes. tmi-sent-ts is
  // Twitch server time (≈ real time), so a quiet/just-opened channel correctly
  // surfaces nobody instead of leading with whoever talked before it went quiet.
  const floor = Date.now() - RECENCY_WINDOW_MS
  // Walk both buffers from newest tail, picking whichever has the later time.
  let i = ircMsgs.length - 1
  let j = ytMsgs.length - 1
  let rank = 0
  while (rank < RECENCY_MAX && (i >= 0 || j >= 0)) {
    const a = i >= 0 ? ircMsgs[i]?.time || 0 : -1
    const b = j >= 0 ? ytMsgs[j]?.time || 0 : -1
    const pickIrc = a >= b
    const t = pickIrc ? a : b
    if (t > 0 && t < floor) break
    const msg = pickIrc ? ircMsgs[i--] : ytMsgs[j--]
    // Strip yt's leading '@' so recency keys align with the bare-name keys
    // every completion path matches against.
    const u = (msg?.user || '').toLowerCase().replace(/^@/, '')
    if (!u || out.has(u)) continue
    // Blocked users never tab-complete — drop them at this one chokepoint so
    // both the recent-chatter and @-mention recency paths stay clean.
    if (_isBlockedAnyPlat(u)) continue
    out.set(u, rank++)
  }
  return out
}

// Resolve the element a modifier should attach to. Valid anchors: an emote
// IMG, the last unit (img OR emoji span) of a stack, or a standalone emoji
// span — so "😀 w!" widens the emoji just like "Kappa w!" widens the emote.
function hsModAnchorEl(prev) {
  if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null
  if (prev.tagName === 'IMG' && (prev.classList.contains('hs-input-emote') || prev.dataset?.emoteName)) return prev
  if (prev.classList.contains('hs-mc-emoji')) return prev
  if (prev.classList.contains('hs-input-stack')) {
    const units = [...prev.children].filter((c) => c.tagName === 'IMG' || c.classList?.contains('hs-mc-emoji'))
    return units.length ? units[units.length - 1] : null
  }
  return null
}

// Scan input for modifier shorthands adjacent to emotes; apply via lib helper.
// Cursor-position-agnostic. Returns true if any modifier was applied.
// Only mutates a text node if it consumed at least one token from it — leaves
// non-modifier text alone so emote autocomplete can still find words.
function scanAndApplyModifiersInInput(input) {
  if (!input) return false
  let appliedAny = false
  let prevEmote = null
  // Bare-letter prefix forms ("w" → w!) only classify for the token the caret
  // is in or just left ("Kappa w" + Tab, the active gesture). The sweep walks
  // the WHOLE input, and letting every text token prefix-resolve meant a bare
  // letter typed as CONTENT ("Z" between two emotes) was eaten as z! on an
  // unrelated Tab press. Distant tokens must be unambiguous (w!, z!, chains,
  // c!hex) to consume.
  let caretNode = null
  let caretOffset = -1
  const _sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
  if (_sel?.rangeCount) {
    const _r = _sel.getRangeAt(0)
    if (_r.collapsed && input.contains(_r.startContainer)) {
      caretNode = _r.startContainer
      caretOffset = _r.startOffset
    }
  }
  for (const child of [...input.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const isAnchor =
        child.classList?.contains('hs-input-emote') ||
        child.classList?.contains('hs-input-stack') ||
        child.classList?.contains('hs-mc-emoji')
      if (isAnchor) prevEmote = child
      else if (child.tagName !== 'BR') prevEmote = null
      continue
    }
    if (child.nodeType !== Node.TEXT_NODE || !prevEmote) continue
    const tokens = child.textContent.split(/(\s+)/)
    // Caret token = last non-whitespace token starting at or before the caret
    // in this node (covers both "w|" and "w |" caret positions).
    let caretTokIdx = -1
    if (child === caretNode) {
      let pos = 0
      for (let i = 0; i < tokens.length; i++) {
        const end = pos + tokens[i].length
        if (tokens[i] && !/^\s*$/.test(tokens[i]) && pos <= caretOffset) caretTokIdx = i
        pos = end
      }
    }
    // Indices to delete. Consuming a token used to be followed by collapsing
    // EVERY whitespace run in the node, which silently rewrote spacing the user
    // typed further along the line ("w!  two   spaces" → " two spaces"). Remove
    // the token and ONE separator beside it; leave the rest byte-for-byte.
    const drop = new Set()
    let consumedHere = false
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (!tok || /^\s*$/.test(tok)) continue
      const cls = hsModClassify(tok, { allowPrefix: i === caretTokIdx })
      if (cls.kind !== 'modifier') {
        // Real text between the emote and the token breaks the anchor — a
        // modifier attaches to the IMMEDIATELY preceding emote.
        prevEmote = null
        continue
      }
      const targetImg = hsModAnchorEl(prevEmote)
      if (!targetImg) continue
      hsModApplyToImg(targetImg, cls.mods, cls.hue, cls.words)
      drop.add(i)
      // Take the separator in FRONT of the token, so the gap the user typed
      // after it reaches the next word intact.
      if (i > 0 && /^\s+$/.test(tokens[i - 1]) && !drop.has(i - 1)) drop.add(i - 1)
      else if (/^\s+$/.test(tokens[i + 1] || '')) drop.add(i + 1)
      appliedAny = true
      consumedHere = true
    }
    if (consumedHere) {
      child.textContent = tokens.filter((_, i) => !drop.has(i)).join('') || ' '
    }
  }
  if (appliedAny && typeof pendingMessage !== 'undefined') pendingMessage = getInputText()
  return appliedAny
}

// Shared tab-complete comparator — the ONE ranking for both the local sort
// (findEmoteMatches) and the remote-merge re-sort (fetchRemoteEmoteMatches).
// They drifted apart once already (strong-exact existed only locally); keep
// every ordering change here.
//
// Order (most-correct first):
//   0. local > remote                       (channel / own / globals beat catalog)
//   1. exact full-name match — UNCONDITIONAL. Typing the whole name is the
//      intent: "nam" → NaM (global, maybe never used) before the channel's
//      NAMarrive. Reverses the old "tier beats never-used exact" call —
//      precision over channel culture when the user typed the entire name.
//   2. used-before > never-used             (frecency; personal habit is the
//      strongest non-exact signal: "kko" → your KKona, never the channel's
//      untouched KKonaLand)
//      within used:   prefix > substring, then frecency score, then tier
//      within unused: tier, prefix > substring, sub emote > non-sub
//   3. remote catalog order (_ai: FFZ-by-uses → BTTV → 7TV)
//   4. recency for @user matches            (who just talked beats name length)
//   5. shorter prefix-match > longer        (Kap → Kappa before KappaPride),
//      then alpha
function compareAcMatches(a, b, searchLower, frecency) {
  const an = a.name || '',
    bn = b.name || ''
  // Exact-name match wins over EVERYTHING — even above the local/remote split.
  // A channel 7TV emote often surfaces as a remote search result (before/instead
  // of the pre-loaded channel map); if exact ranked below local, a local
  // different-name prefix match would beat the exact one the user actually
  // typed. You typed the full name → you get that emote. Two exacts tie here and
  // fall through to local-before-remote + tier, so a local exact still beats a
  // remote exact.
  const ae = an.toLowerCase() === searchLower ? 0 : 1
  const be = bn.toLowerCase() === searchLower ? 0 : 1
  if (ae !== be) return ae - be
  const al = a.remote ? 1 : 0,
    bl = b.remote ? 1 : 0
  if (al !== bl) return al - bl
  const at = a.tier ?? 9,
    bt = b.tier ?? 9
  const af = frecency.get(an) || 0,
    bf = frecency.get(bn) || 0
  if (af > 0 !== bf > 0) return af > 0 ? -1 : 1
  if (af > 0) {
    // both used — they typed a prefix, respect it; then habit strength
    if (a.priority !== b.priority) return a.priority - b.priority
    if (af !== bf) return bf - af
    if (at !== bt) return at - bt
  } else {
    // neither used — channel culture leads
    if (at !== bt) return at - bt
    if (a.priority !== b.priority) return a.priority - b.priority
    if (!!a.sub !== !!b.sub) return a.sub ? -1 : 1
  }
  if (a.remote && b.remote) return (a._ai || 0) - (b._ai || 0)
  if (a.type === 'user' && b.type === 'user') {
    const arr = a.recencyRank ?? Infinity,
      brr = b.recencyRank ?? Infinity
    if (arr !== brr) return arr - brr
  }
  if (a.priority === 0 && an.length !== bn.length) return an.length - bn.length
  return an.localeCompare(bn)
}

// Block enforcement for tab-complete/mention candidates that have no platform
// context: a namespaced block (twitch:alice) never matched isUserBlocked(name)
// with platform=undefined, so a blocked user still surfaced as a completion.
// You blocked them — don't suggest them on ANY platform namespace.
function _isBlockedAnyPlat(name) {
  const u = String(name || '')
    .toLowerCase()
    .replace(/^@/, '')
  if (!u || typeof blockedUsers === 'undefined' || !blockedUsers.size) return false
  // yt: = legacy short form still matched by enforcement; heatsync: = blocks
  // made from heatsync-platform rows. Missing either let a blocked user keep
  // tab-completing.
  return (
    blockedUsers.has(u) ||
    blockedUsers.has(`twitch:${u}`) ||
    blockedUsers.has(`kick:${u}`) ||
    blockedUsers.has(`youtube:${u}`) ||
    blockedUsers.has(`yt:${u}`) ||
    blockedUsers.has(`heatsync:${u}`)
  )
}

// Merged autocomplete emote source: channel pools (tier 0) over the viewer's
// set (tier 1) over globals (tier 2) — channel written LAST so a name owned AND
// defined by the channel resolves to the channel image. findEmoteMatches runs
// on EVERY debounced keystroke-word, and rebuilding this merge — allocating
// two Maps across thousands of emotes each call — was the dominant typing-lag
// cost on emote-heavy channels. Memoize it, keyed by a cheap signature: active
// tab + the sizes of every source map. Any add/remove, tab switch, or pool
// (re)hydration moves a size or the tab and busts the cache; the only miss is
// a same-count in-place url swap, which leaves a stale thumbnail (never a
// wrong insertion — names stay authoritative) until the next size change.
// lowerByName rides along so the scan in findEmoteMatches reads a precomputed
// lowercase name instead of calling .toLowerCase() twice per entry.
let _acMergeCache = null // { sig, acEmotes, tierByName, lowerByName }
function _getMergedAcEmotes() {
  // activeTabEmotePools resolves the tab's twitch/kick slot names + yt handle —
  // pools are keyed by fetched owner name, and the raw tab id is NOT a pool key
  // on merged-identity/yt tabs (the kripparrian-vs-nl_kripp trap; see emotes.js).
  const acPools =
    typeof activeTabEmotePools === 'function'
      ? activeTabEmotePools()
      : [channelEmoteCaches[currentTab] || channelEmoteCaches[getCurrentChannel()]].filter(Boolean)
  let poolsSig = ''
  for (const p of acPools) poolsSig += `${p?.size || 0},`
  // The toggle rides in the signature: flipping it has to invalidate the memo,
  // otherwise suggestions keep serving the old pool until the next emote load.
  const acInventory = getSetting('suggestInventoryEmotes') !== false
  const sig = `${currentTab}|${emoteCache.size}|${viewerPersonalEmotes.size}|${poolsSig}|${acInventory ? 1 : 0}`
  if (_acMergeCache && _acMergeCache.sig === sig) return _acMergeCache
  const acEmotes = new Map()
  const tierByName = new Map()
  const lowerByName = new Map()
  for (const [k, v] of emoteCache) {
    acEmotes.set(k, v)
    tierByName.set(k, 2)
    lowerByName.set(k, k.toLowerCase())
  }
  // Off: names that exist ONLY in your inventory stop being offered. Names the
  // channel or a global pool also defines still complete — those are real words
  // in this chat regardless of what you collected.
  if (acInventory)
    for (const [k, v] of viewerPersonalEmotes) {
      acEmotes.set(k, v)
      tierByName.set(k, 1)
      lowerByName.set(k, k.toLowerCase())
    }
  for (const acChCache of acPools)
    for (const [k, v] of acChCache) {
      acEmotes.set(k, v)
      tierByName.set(k, 0)
      lowerByName.set(k, k.toLowerCase())
    }
  _acMergeCache = { sig, acEmotes, tierByName, lowerByName }
  return _acMergeCache
}

// Shared exclusion check for the autocomplete pool (dropdown + tab-cycle +
// remote catalog) — a blocked OR viewer-hidden-nsfw emote must never paint
// its real image in a suggestion, so it's filtered from the match POOL itself
// rather than only at insert time. Checks the name both raw and HTML-escaped
// (mirrors the rawWord/word double-check in emotes.js's render path) plus the
// emote's hash, so the same asset re-listed under a different alias is
// caught too. hsChannelNsfwHidden covers channel 7tv sets whose sexual flag
// is unfiltered (see emotes.js _buildChannelEmoteCache).
function _hsAcEmoteBlocked(name, emote) {
  if (!name) return false
  if (typeof hsChannelNsfwHidden === 'function' && hsChannelNsfwHidden(emote)) return true
  if (typeof blockedEmoteNames === 'undefined') return false
  if (blockedEmoteNames.has(name)) return true
  if (typeof unescapeHtml === 'function' && blockedEmoteNames.has(unescapeHtml(name))) return true
  if (typeof blockedEmoteHashes !== 'undefined' && emote?.hash && blockedEmoteHashes.has(String(emote.hash)))
    return true
  return false
}

function findEmoteMatches(search) {
  const matches = []

  // FFZ-style modifier tokens MUST NOT autocomplete — even if BTTV has an emote
  // literally named "w!". Use shared classifier; if it's a modifier, return [].
  if (hsModClassify(search, { allowPrefix: false }).kind === 'modifier') {
    return matches
  }

  // Check if searching for username (starts with @)
  const isUserSearch = search.startsWith('@')
  // Colon-triggered dropdown search (":kap") — strip the leading ':' so the
  // emote-name matching below sees the bare query, exactly like the bare-word
  // Tab-cycle path sees "kap". Without this, ":kap" only ever matched unicode
  // emoji shortcodes (see the dedicated ":prefix" block further down) because
  // no emote name literally starts with ':'.
  const isColonSearch = !isUserSearch && search.startsWith(':')
  const searchTerm = isUserSearch || isColonSearch ? search.slice(1) : search
  const searchLower = searchTerm.toLowerCase()

  // Username completion ONLY when explicit @prefix. Bare words never surface
  // usernames — they pollute emote results and the @ form is the supported way
  // to mention someone. Recency map / color prefetch only run on @search.
  if (isUserSearch) {
    const recency = getRecencyMap()
    const _hsPrefetchList = []
    for (const username of usernameCache) {
      if (!username) continue
      const userLower = username.toLowerCase()
      // YouTube usernames arrive as "@handle" — match and insert on the bare
      // name or yt chatters can never @-complete (typed query has no leading
      // @ after the trigger slice, and '@' + '@handle' would insert '@@').
      const bare = userLower.startsWith('@') ? userLower.slice(1) : userLower
      // Blocked users never surface as an @-completion suggestion (and don't
      // trigger a color prefetch for them).
      if (_isBlockedAnyPlat(bare)) continue
      let color = (typeof knownColors !== 'undefined' && knownColors.get(userLower)) || null
      if (!color && _hsUserColorCache.has(userLower)) color = _hsUserColorCache.get(userLower) || null
      if (!color) _hsPrefetchList.push(bare)
      const recencyRank = recency.get(bare)
      if (bare.startsWith(searchLower)) {
        matches.push({ name: `@${username.replace(/^@/, '')}`, url: null, priority: 0, type: 'user', recencyRank })
      }
    }
    if (_hsPrefetchList.length) {
      try {
        hsPrefetchUserColors(_hsPrefetchList.slice(0, 30))
      } catch {}
    }
  }

  // Search emote cache (unless explicitly searching users with @).
  // Three tiers, in order: 0 = current channel BTTV/FFZ/7TV, 1 = viewer's own set
  // (heatsync inventory + native sub emotes), 2 = globals. Tier rides on each
  // pushed match so the sort can rank "channel > own > global" without
  // re-walking the source maps.
  // Channel emotes are written into the merge map LAST so a name you own AND that
  // the channel also defines (e.g. nl_kripp's BTTV "SoupTime") resolves to the
  // CHANNEL image — that's what actually renders in this channel. Channel-first is
  // the user-chosen order (reverses the older own-first call).
  if (!isUserSearch) {
    const { acEmotes, tierByName, lowerByName } = _getMergedAcEmotes()
    for (const [name, emote] of acEmotes) {
      // Only tab-complete heatsync emotes you own (can't send emotes not in your set)
      if (emote.source === 'heatsync' && emote.state !== 'owned') continue
      // Blocked emotes never surface as an autocomplete suggestion — the
      // dropdown/tab-cycle preview paints entry.url unguarded (showEmojiDropdown),
      // so a blocked name/hash has to be excluded from the pool itself, not
      // just at insert time. Hash catches the same asset under a re-listed alias.
      if (_hsAcEmoteBlocked(name, emote)) continue
      const sub = !!emote.subscription
      const tier = tierByName.get(name) ?? 2
      const nameLower = lowerByName.get(name) ?? name.toLowerCase()
      if (nameLower.startsWith(searchLower)) {
        matches.push({
          name,
          url: emote.url,
          source: emote.source,
          priority: 0,
          tier,
          type: 'emote',
          sub,
          zeroWidth: !!emote.zeroWidth,
        })
      } else if (nameLower.includes(searchLower)) {
        matches.push({
          name,
          url: emote.url,
          source: emote.source,
          priority: 1,
          tier,
          type: 'emote',
          sub,
          zeroWidth: !!emote.zeroWidth,
        })
      }
    }
    // 7TV "name0" overlay convention: a trailing "0" turns an emote into a
    // zero-width overlay (e.g. "centipede0"). The literal "centipede0" matches
    // no emote name, so synthesize an overlay match from the base name. Without
    // this, re-completing a "name0" word (complete emote → backspace auto-space
    // → type 0 → Tab) finds nothing and the chip collapses back to plain text.
    // The insert path resolves the overlay flag via lookupEmoteWithOverlay and
    // stacks it onto the preceding emote.
    // Skip synthesis entirely when the literal "name0" is itself a real emote —
    // a channel emote actually named "lerolero0" is standalone and already
    // surfaced as a direct hit above; the strip-0 overlay must not shadow it
    // (and the prefix branch below would otherwise emit bogus "name00" doubles).
    const _literalIsReal = matches.some((m) => m.type === 'emote' && m.name.toLowerCase() === searchLower)
    if (!_literalIsReal && searchLower.length > 2 && searchLower.endsWith('0')) {
      const baseLower = searchLower.slice(0, -1)
      const seen = new Set(matches.filter((m) => m.type === 'emote').map((m) => m.name.toLowerCase()))
      for (const [name, emote] of acEmotes) {
        if (emote.source === 'heatsync' && emote.state !== 'owned') continue
        // A block on the base name must hide the synthesized "name0" overlay too.
        if (_hsAcEmoteBlocked(name, emote)) continue
        const nl = name.toLowerCase()
        const overlayName = `${name}0`
        if (seen.has(overlayName.toLowerCase())) continue
        const tier = tierByName.get(name) ?? 2
        if (nl === baseLower) {
          matches.push({
            name: overlayName,
            url: emote.url,
            source: emote.source,
            priority: 0,
            tier,
            type: 'emote',
            sub: !!emote.subscription,
            _synthOverlay: true,
          })
        } else if (nl.startsWith(baseLower)) {
          matches.push({
            name: overlayName,
            url: emote.url,
            source: emote.source,
            priority: 1,
            tier,
            type: 'emote',
            sub: !!emote.subscription,
            _synthOverlay: true,
          })
        }
      }
    }
  }

  // Recent-chatter completion — bare word (no @ / :): a chatter who JUST talked
  // and whose name PREFIX-matches outranks every emote. Typing a name prefix is
  // almost always addressing that person, so these jump above emotes (e.g.
  // "ashr" → ashrubberyboi over HahaShrugLeft), most-recent-first. Inserted as
  // the PLAIN name (no @) — respect what the user typed; they didn't type @, so
  // don't force a mention/ping (the @-search path keeps the @ the user typed).
  // Collected separately and prepended after the emote sort so emote ordering
  // stays untouched.
  const recentChatters = []
  if (!isUserSearch && !search.startsWith(':') && searchLower.length > 0 && typeof getRecencyMap === 'function') {
    for (const [userLower, rank] of getRecencyMap()) {
      if (!userLower.startsWith(searchLower)) continue
      recentChatters.push({
        name: _ucDisplay.get(userLower) || userLower,
        url: null,
        priority: 0,
        type: 'user',
        recencyRank: rank,
      })
    }
    recentChatters.sort((a, b) => a.recencyRank - b.recencyRank)
  }
  const _recentSeen = new Set(recentChatters.map((m) => m.name.toLowerCase().replace(/^@/, '')))

  // Bare-word username fallback — when nothing emote-y matched, scan
  // usernameCache for everyone NOT already surfaced as a recent chatter. Only
  // kicks in for searches that didn't start with @ / : so the explicit-@ path
  // keeps its dedicated behavior (recency + color prefetch). Inserted WITHOUT
  // the @ prefix so the user gets the same bare-name they typed (e.g. typing
  // "lichen" + Tab → "licheness").
  if (!isUserSearch && !search.startsWith(':') && matches.length === 0 && typeof usernameCache !== 'undefined') {
    for (const username of usernameCache) {
      if (!username) continue
      // Bare-name matching — yt cache entries carry a leading '@'.
      const userLower = username.toLowerCase().replace(/^@/, '')
      if (_recentSeen.has(userLower)) continue
      if (_isBlockedAnyPlat(userLower)) continue
      if (userLower.startsWith(searchLower)) {
        matches.push({ name: username, url: null, priority: 0, type: 'user' })
      } else if (userLower.includes(searchLower)) {
        matches.push({ name: username, url: null, priority: 1, type: 'user' })
      }
    }
  }

  // Emoji shortcodes when typing :prefix
  if (search.startsWith(':') && typeof EMOJI_DATA !== 'undefined') {
    const emojiPrefix = search.slice(1).toLowerCase()
    if (emojiPrefix.length > 0) {
      for (const entry of EMOJI_DATA) {
        if (matches.length >= 50) break
        const emojiMatch = {
          name: `:${entry.name}:`,
          url: null,
          priority: entry.name.startsWith(emojiPrefix) ? 0 : 1,
          type: 'emoji',
          emoji: entry.emoji,
        }
        if (entry.name.startsWith(emojiPrefix)) {
          matches.push(emojiMatch)
        } else if (entry.name.includes(emojiPrefix)) {
          emojiMatch.priority = 1
          matches.push(emojiMatch)
        }
      }
    }
  }

  const _frec = typeof loadEmoteFrecency === 'function' ? loadEmoteFrecency() : new Map()
  matches.sort((a, b) => compareAcMatches(a, b, searchLower, _frec))

  // Recent chatters (prefix, most-recent-first) lead the cycle, above all
  // emotes — see comment at recentChatters above.
  return recentChatters.length ? recentChatters.concat(matches) : matches
}

// Insert completion and keep cycling state
function insertCompletionKeepOpen(match) {
  const input = document.getElementById('hs-mc-input')
  if (!input || !match) return

  trackCompletionForAutoAdd(match)
  if (match.type === 'emote' && match.name && typeof recordRecentEmote === 'function') {
    // Usage must reflect where the user STOPS, not every candidate they cycle
    // through — otherwise the #1-ranked emote gets a bump on every Tab press
    // and entrenches itself (the KKonaLand loop: each "kko"+Tab attempt fed
    // the wrong emote before the user ever reached KKona). Within a session,
    // revert the previous candidate's bump before recording the new one; the
    // one still standing when the session closes keeps the credit.
    if (acState._frecBumped && acState._frecBumped !== match.name && typeof unbumpEmoteFrecency === 'function') {
      unbumpEmoteFrecency(acState._frecBumped)
    }
    if (acState._frecBumped !== match.name) recordRecentEmote(match.name)
    acState._frecBumped = match.name
  }

  if (wysiwygEnabled) {
    insertCompletionWysiwyg(match)
    return
  }

  // Use saved positions from acState for consistent cycling
  const beforeWord = input.value.slice(0, acState.wordStart)
  const insertText = match.type === 'emoji' ? match.emoji : match.name
  const newValue = `${beforeWord + insertText} ${acState.afterText}`

  input.value = newValue
  pendingMessage = input.value

  // Position cursor after the inserted word
  const newPos = beforeWord.length + insertText.length + 1
  input.selectionStart = input.selectionEnd = newPos
  input.focus()

  updateCharCount()
}

// Build a styled mention chip span for bare-username completion.
// Resolves color synchronously from caches FIRST (no white flash for known
// users), then async-fetches only if still unknown.
function createUserMentionSpan(username, color) {
  const span = document.createElement('span')
  span.className = 'hs-mc-user hs-cycling-user'
  const lower = username.toLowerCase()
  span.dataset.username = lower
  span.dataset.completionType = 'user-bare'
  span.textContent = username
  const sanitize = (c) => (typeof sanitizeColor === 'function' ? sanitizeColor(c || '#fff') : c || '#fff')

  // Sync cache resolution — instant for anyone we've already seen this session
  let finalColor = color && color !== '#fff' ? color : null
  if (!finalColor && _hsUserColorCache.has(lower)) finalColor = _hsUserColorCache.get(lower) || null
  if (!finalColor && typeof knownColors !== 'undefined') {
    const k = knownColors.get(lower)
    if (k && k !== '#fff') finalColor = k
  }

  span.style.color = sanitize(finalColor || '#fff')
  span.style.fontWeight = 'bold'
  span.style.cursor = 'pointer'
  span.contentEditable = 'false'
  span.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(`https://heatsync.org/user/${encodeURIComponent(lower)}`, '_blank', 'noopener,noreferrer')
  })
  // Only async-fetch when truly unknown
  if (!finalColor) hsFetchUserColorAndApply(lower, span)
  return span
}

// Cache: username (lower) → color hex (or null for "fetched but no color")
const _hsUserColorCache = new Map()
const _hsUserColorInflight = new Map()
// Cache: username (lower) → resolved Twitch userId (string), or null once
// resolved-but-no-twitch-link. Populated alongside _hsUserColorCache by the
// same /api/profile/ fetch in hsResolveUserColor — the response already
// carries twitch_user_id, so this piggybacks the existing lookup instead of
// firing a second request. Read directly (typeof-guarded, same convention as
// main.js's existing _hsUserColorCache read) once the color promise settles —
// see resolveMentionColor in main.js.
const _hsUserIdCache = new Map()

// Persist cache across page reloads — colors don't change often. Loads at startup.
try {
  ;(typeof api !== 'undefined' ? api : chrome).storage.local
    .get('hs_user_color_cache')
    .then((d) => {
      const obj = d?.hs_user_color_cache
      if (obj && typeof obj === 'object') {
        for (const k in obj) _hsUserColorCache.set(k, obj[k])
        while (_hsUserColorCache.size > 5000) _hsUserColorCache.delete(_hsUserColorCache.keys().next().value)
      }
    })
    .catch(() => {})
} catch {}

let _hsUserColorCacheSaveTimer = null
function _hsPersistUserColorCache() {
  if (_hsUserColorCacheSaveTimer) return
  _hsUserColorCacheSaveTimer = setTimeout(() => {
    _hsUserColorCacheSaveTimer = null
    const obj = {}
    for (const [k, v] of _hsUserColorCache) if (v) obj[k] = v // skip nulls
    try {
      ;(typeof api !== 'undefined' ? api : chrome).storage.local.set({ hs_user_color_cache: obj })
    } catch {}
  }, 2000)
}

// Prefetch colors for a list of usernames in the background. Deduped + batched
// via GQL so 10 names = 1 round-trip. Populates _hsUserColorCache for later
// instant lookup in createUserMentionSpan.
function hsPrefetchUserColors(usernames) {
  const needed = []
  for (const u of usernames || []) {
    const lower = String(u || '').toLowerCase()
    if (!lower) continue
    if (_hsUserColorCache.has(lower)) continue
    if (_hsUserColorInflight.has(lower)) continue
    // Don't re-fetch if knownColors already has them
    if (typeof knownColors !== 'undefined' && knownColors.get(lower)) continue
    needed.push(lower)
  }
  if (!needed.length) return
  // Mark inflight
  const batchPromise = (async () => {
    try {
      // Build batched GQL with aliases — single request for all users
      const aliases = needed.map((u, i) => `u${i}: user(login: "${u.replace(/"/g, '')}") { chatColor }`).join(' ')
      const resp = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
        body: JSON.stringify({ query: `{ ${aliases} }` }),
      })
      if (!resp.ok) return
      const j = await resp.json()
      const data = j?.data || {}
      for (let i = 0; i < needed.length; i++) {
        const u = needed[i]
        const c = data[`u${i}`]?.chatColor || null
        _hsUserColorCache.set(u, c)
        if (_hsUserColorCache.size > 5000) _hsUserColorCache.delete(_hsUserColorCache.keys().next().value)
        if (c) {
          try {
            setKnownColor(u, c)
          } catch {}
        }
      }
      _hsPersistUserColorCache()
    } catch {}
  })()
  for (const u of needed) _hsUserColorInflight.set(u, batchPromise)
  batchPromise.finally(() => {
    for (const u of needed) _hsUserColorInflight.delete(u)
  })
}
// Resolve a username's chat color, caching the result. Resolution order:
//   1. heatsync custom color (set on heatsync.org)
//   2. twitch chat color via unauthed GQL (no scope needed)
//   3. twitch's 15 auto-assigned colors (deterministic hash of username)
// So every user resolves to SOME color — never flat white — matching twitch.
// Deduped via _hsUserColorInflight; persisted via _hsUserColorCache. Shared by
// input chips (hsFetchUserColorAndApply) and message @mentions/reply links.
function hsResolveUserColor(lower) {
  // Short-circuit only when BOTH answers are cached — a cached color with an
  // unknown uid must still hit /api/profile, or the uid (which name paints
  // depend on) is starved forever by the color cache.
  if (_hsUserColorCache.has(lower) && _hsUserIdCache.has(lower)) {
    return Promise.resolve(_hsUserColorCache.get(lower) || null)
  }
  let p = _hsUserColorInflight.get(lower)
  if (!p) {
    p = (async () => {
      try {
        if (typeof apiFetch !== 'function') return null
        const resp = await apiFetch(`/api/profile/${encodeURIComponent(lower)}`)
        const profile = resp?.data?.profile
        // Twitch userId, when this name resolves to a linked Twitch identity —
        // same field profile-card.js/tooltips.js read (twitch_user_id, with a
        // twitch_id fallback for older payload shapes). Cached even when null
        // so a name with no Twitch link doesn't get re-derived every render.
        const uid = profile?.twitch_user_id || profile?.twitch_id || null
        _hsUserIdCache.set(lower, uid ? String(uid) : null)
        if (_hsUserIdCache.size > 5000) _hsUserIdCache.delete(_hsUserIdCache.keys().next().value)
        // 1. heatsync custom color (set on heatsync.org)
        let c = profile?.color || profile?.user_color || profile?.userColor || null
        // 2. fallback: fetch Twitch chat color via unauthed GQL (no scope needed)
        if (!c && profile?.twitch_username) {
          try {
            const gqlResp = await fetch('https://gql.twitch.tv/gql', {
              method: 'POST',
              credentials: 'omit',
              headers: {
                'Content-Type': 'application/json',
                'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
              },
              body: JSON.stringify({
                query: 'query($login:String!){user(login:$login){chatColor}}',
                variables: { login: profile.twitch_username },
              }),
            })
            if (gqlResp.ok) {
              const j = await gqlResp.json()
              c = j?.data?.user?.chatColor || null
            }
          } catch {}
        }
        // 3. fallback: Twitch's 15 auto-assigned colors (hash of username)
        if (!c) {
          const palette = [
            '#FF0000',
            '#0000FF',
            '#008000',
            '#B22222',
            '#FF7F50',
            '#9ACD32',
            '#FF4500',
            '#2E8B57',
            '#DAA520',
            '#D2691E',
            '#5F9EA0',
            '#1E90FF',
            '#FF69B4',
            '#8A2BE2',
            '#00FF7F',
          ]
          let h = 0
          for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) | 0
          c = palette[Math.abs(h) % palette.length]
        }
        _hsUserColorCache.set(lower, c || null)
        if (_hsUserColorCache.size > 5000) _hsUserColorCache.delete(_hsUserColorCache.keys().next().value)
        _hsPersistUserColorCache()
        if (c) {
          try {
            setKnownColor(lower, c)
          } catch {}
        }
        return c
      } catch {
        return null
      }
    })()
    _hsUserColorInflight.set(lower, p)
    p.finally(() => _hsUserColorInflight.delete(lower))
  }
  return p
}

function hsFetchUserColorAndApply(lower, span) {
  hsResolveUserColor(lower).then((c) => {
    if (c && span.isConnected) {
      span.style.color = typeof sanitizeColor === 'function' ? sanitizeColor(c) : c
    }
  })
}

// WYSIWYG emote insertion
// Overlay (zero-width) decision for a completion match.
//   1. Synth "name0" matches are overlays by construction.
//   2. The match's own truthy flag wins (remote 7TV hits carry it).
//   3. A false/stripped flag is RECOVERABLE when a cache entry for the same
//      provider ASSET (id parsed from the url) is flagged zero-width —
//      owned/inventory copies lose 7TV's flag (zeroWidthFromAnyCache doc), so
//      an owned overlay emote ("microwave") would otherwise Tab-complete as a
//      standalone chip instead of stacking. Asset identity (not name) keeps
//      the collision guarantee: a same-name different-asset overlay elsewhere
//      must never stack a non-overlay pick onto the preceding chip.
//   4. Flagless matches (dropdown picks, emoji) fall back to the name lookup.
function completionWantsOverlay(match, resolved) {
  if (match._synthOverlay) return true
  if (match.zeroWidth) return true
  if (typeof zeroWidthForSameAsset === 'function' && zeroWidthForSameAsset(match.name, match.url)) return true
  if (match.zeroWidth !== undefined) return false
  return !!resolved?.isOverlay
}

function insertCompletionWysiwyg(match) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return

  // Reflect block state on the inserted/cycled emote chip: a blocked emote must
  // show the 2px dashed outline, not the image. Clears any prior block state
  // first (the chip's src was just set to the new match) so a stale blocked src
  // can't leak across Tab-cycle steps, then re-marks if this match is blocked.
  const _applyInputBlock = (img) => {
    if (!img) return
    delete img.dataset.hsInputBlocked
    delete img.dataset.hsOrigSrc
    img.classList.remove('hs-state-blocked')
    delete img.dataset.state
    if (
      match.name &&
      typeof blockedEmoteNames !== 'undefined' &&
      // synth trailing-0 overlays carry "name0" but the block set holds the
      // base name — check the stripped base too
      (blockedEmoteNames.has(match.name) || (match._synthOverlay && blockedEmoteNames.has(match.name.slice(0, -1)))) &&
      typeof markInputEmoteBlocked === 'function'
    ) {
      markInputEmoteBlocked(img, true)
    }
  }

  // Check if we're replacing an existing cycling element (emote img, text span, or user span)
  const existingEmote = input.querySelector('img.hs-cycling-emote')
  const existingText = input.querySelector('span.hs-cycling-text')
  const existingUser = input.querySelector('span.hs-cycling-user')
  if (existingEmote) {
    if (match.url) {
      // Re-check overlay state: cycling through Tab matches can move between
      // overlay and non-overlay alternatives. Without this, the FIRST insert's
      // overlay state sticks — every cycle stays inside the stack span and
      // non-overlay matches appear to stack onto whatever's before them.
      const resolved = typeof lookupEmoteWithOverlay === 'function' ? lookupEmoteWithOverlay(match.name) : null
      const wantsOverlay = completionWantsOverlay(match, resolved)
      const stack = existingEmote.parentElement?.classList?.contains('hs-input-stack')
        ? existingEmote.parentElement
        : null
      if (stack && !wantsOverlay) {
        // Pull the cycling img out of the stack and place it after the stack
        // as a standalone unit. Strip the overlay class so its native sizing
        // returns. If the stack ends up with one child, unwrap it back to a
        // bare emote img.
        existingEmote.classList.remove('hs-input-overlay')
        stack.parentNode.insertBefore(existingEmote, stack.nextSibling)
        if (stack.children.length === 1) {
          const base = stack.firstElementChild
          stack.parentNode.insertBefore(base, stack)
          stack.remove()
        } else if (stack.children.length === 0) {
          stack.remove()
        }
        // Re-separate BOTH sides of the freed chip, adding only what's missing.
        // Left: the former base now sits flush against it, and touching chips
        // are exactly what unwrapStuckChips rewrites on the next input (which
        // yanks the caret back between them). Right: the trailing whitespace is
        // the caret's home, and caretOnActiveCompletion only accepts a caret in
        // the text node IMMEDIATELY after the chip — the old exact-nbsp compare
        // saw the plain space the overlay path leaves, inserted a SECOND
        // separator in front of it, and orphaned the caret one node too far
        // right, so the next Tab tore the cycle down instead of advancing
        // (overlay, overlay, overlay, then a non-overlay match: Tab and
        // Shift+Tab both went dead).
        if (isInlineChip(existingEmote.previousSibling)) {
          existingEmote.parentNode.insertBefore(document.createTextNode('\u00A0'), existingEmote)
        }
        let tail = existingEmote.nextSibling
        if (!(tail?.nodeType === Node.TEXT_NODE && /^\s/.test(tail.textContent || ''))) {
          tail = document.createTextNode('\u00A0')
          existingEmote.parentNode.insertBefore(tail, existingEmote.nextSibling)
        }
        placeCaretAfter(tail, 1)
      } else if (!stack && wantsOverlay) {
        // Cycle landed on an overlay match while the cycling img is standalone.
        // Find a preceding base — element chip or a raw emoji ending a
        // preceding text node (resolveOverlayBaseLeft wraps it) — and move the
        // img into a stack on top.
        const prev = resolveOverlayBaseLeft(existingEmote)
        if (prev) {
          // Drop whitespace nodes between base and the cycling img
          let ws = prev.nextSibling
          while (ws && ws !== existingEmote) {
            const rm = ws
            ws = ws.nextSibling
            rm.remove()
          }
          stackInputEmote(prev, existingEmote)
        }
      }
      existingEmote.src = match.url
      existingEmote.alt = match.name
      existingEmote.dataset.emoteName = match.name
      _applyInputBlock(existingEmote)
    } else if (match.type === 'emoji') {
      // Replace emote img with emoji span
      const span = document.createElement('span')
      span.className = 'hs-cycling-text'
      span.textContent = match.emoji
      span.dataset.completionName = match.name
      existingEmote.replaceWith(span)
      // Place caret after the span's trailing space
      const space = span.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(span)
    } else if (match.type === 'user-bare') {
      const userSpan = createUserMentionSpan(match.name, match.color)
      existingEmote.replaceWith(userSpan)
      const space = userSpan.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(userSpan)
    } else if (match.type === 'user') {
      // @user cycle marker — generic cycling-text span (matches emoji's pattern,
      // unwraps to plain text on cycle-end via hideAutocomplete).
      const span = document.createElement('span')
      span.className = 'hs-cycling-text'
      span.textContent = match.name
      span.dataset.completionName = match.name
      existingEmote.replaceWith(span)
      const space = span.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(span)
    } else {
      const textNode = document.createTextNode(`${match.name} `)
      existingEmote.replaceWith(textNode)
      placeCaretAfter(textNode)
    }
    pendingMessage = getInputText()
    updateCharCount()
    return
  }
  if (existingText) {
    if (match.url) {
      // Replace text span with emote img
      const img = document.createElement('img')
      img.src = match.url
      img.alt = match.name
      img.dataset.emoteName = match.name
      img.className = 'hs-input-emote hs-cycling-emote'
      img.draggable = false
      attachInputEmoteErrorRecovery(img)
      if (typeof hsAttachInputEmoteSnap === 'function') hsAttachInputEmoteSnap(img)
      _applyInputBlock(img)
      existingText.replaceWith(img)
      const space = img.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(img)
    } else if (match.type === 'emoji') {
      existingText.textContent = match.emoji
      existingText.dataset.completionName = match.name
      const space = existingText.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(existingText)
    } else if (match.type === 'user-bare') {
      const userSpan = createUserMentionSpan(match.name, match.color)
      existingText.replaceWith(userSpan)
      const space = userSpan.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(userSpan)
    } else if (match.type === 'user') {
      // @user cycle — update span text in place (same shape emoji uses)
      existingText.textContent = match.name
      existingText.dataset.completionName = match.name
      const space = existingText.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(existingText)
    } else {
      const textNode = document.createTextNode(`${match.name} `)
      existingText.replaceWith(textNode)
      placeCaretAfter(textNode)
    }
    pendingMessage = getInputText()
    updateCharCount()
    return
  }
  if (existingUser) {
    if (match.url) {
      // Replace user span with emote img
      const img = document.createElement('img')
      img.src = match.url
      img.alt = match.name
      img.dataset.emoteName = match.name
      img.className = 'hs-input-emote hs-cycling-emote'
      img.draggable = false
      attachInputEmoteErrorRecovery(img)
      if (typeof hsAttachInputEmoteSnap === 'function') hsAttachInputEmoteSnap(img)
      _applyInputBlock(img)
      existingUser.replaceWith(img)
      const space = img.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(img)
    } else if (match.type === 'emoji') {
      const span = document.createElement('span')
      span.className = 'hs-cycling-text'
      span.textContent = match.emoji
      span.dataset.completionName = match.name
      existingUser.replaceWith(span)
      const space = span.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(span)
    } else if (match.type === 'user-bare') {
      // Update existing user span in place
      existingUser.textContent = match.name
      existingUser.dataset.username = match.name.toLowerCase()
      const safeColor =
        typeof sanitizeColor === 'function' ? sanitizeColor(match.color || '#fff') : match.color || '#fff'
      existingUser.style.color = safeColor
      const space = existingUser.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(existingUser)
    } else if (match.type === 'user') {
      // Cycling from a bare-mention chip onto an @user — swap chip for cycling-text
      const span = document.createElement('span')
      span.className = 'hs-cycling-text'
      span.textContent = match.name
      span.dataset.completionName = match.name
      existingUser.replaceWith(span)
      const space = span.nextSibling
      if (space) placeCaretAfter(space, 1)
      else placeCaretAfter(span)
    } else {
      const textNode = document.createTextNode(`${match.name} `)
      existingUser.replaceWith(textNode)
      placeCaretAfter(textNode)
    }
    pendingMessage = getInputText()
    updateCharCount()
    return
  }

  // First Tab: replace word with emote image
  const sel = window.getSelection()
  if (!sel.rangeCount) return

  const range = sel.getRangeAt(0)
  // The lazy 7TV/BTTV/FFZ fetch lands here ASYNC (wasEmpty auto-insert) — by
  // then the selection can sit anywhere on the page (user clicked twitch's
  // native chat, a rebuild moved focus). Never rewrite DOM outside the
  // composer, and never wipe a word the caret is no longer touching.
  if (!input.contains(range.startContainer)) return
  let container = range.startContainer
  let rangeOffset = range.startOffset
  // Resolve element boundary to preceding text node
  if (container.nodeType === Node.ELEMENT_NODE && rangeOffset > 0) {
    const child = container.childNodes[rangeOffset - 1]
    if (child?.nodeType === Node.TEXT_NODE) {
      container = child
      rangeOffset = child.textContent.length
    }
  }
  if (container.nodeType !== Node.TEXT_NODE) return

  const textNode = container
  const offset = rangeOffset
  const text = textNode.textContent

  // Find word start
  let wordStart = offset
  while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart--

  // Find word end (skip past rest of word after cursor)
  let wordEnd = offset
  while (wordEnd < text.length && !/\s/.test(text[wordEnd])) wordEnd++

  // Split text: before | word | after
  const before = text.slice(0, wordStart)
  const after = text.slice(wordEnd)

  // Save afterText for cycling
  acState.afterText = after

  // Helper: insert element after textNode with before/after text
  const insertElement = (el) => {
    // Defensive leading separator: if the typed word started at textNode
    // offset 0 (so `before` is empty) and the previous sibling is a chip,
    // splice an nbsp into `before` so the new chip doesn't touch the prior
    // chip \u2014 otherwise unwrapStuckChips collapses both back to plain text.
    let leadBefore = before
    if (!leadBefore) {
      const prev = textNode.previousSibling
      const prevIsChip =
        prev?.nodeType === Node.ELEMENT_NODE &&
        ((prev.tagName === 'IMG' && (prev.classList?.contains('hs-input-emote') || prev.dataset?.emoteName)) ||
          prev.classList?.contains('hs-input-stack') ||
          prev.classList?.contains('hs-mc-emoji') ||
          prev.classList?.contains('hs-mc-user') ||
          prev.classList?.contains('hs-cycling-emote') ||
          prev.classList?.contains('hs-cycling-text'))
      if (prevIsChip) leadBefore = '\u00A0'
    }
    textNode.textContent = leadBefore
    // Auto-space after Tab uses nbsp \u2014 at end of contenteditable, regular
    // trailing spaces collapse to 0 width and look invisible. Backspace
    // handler still consumes this in one keystroke, so it behaves like a
    // typed space (1st press eats it, 2nd press deletes the chip).
    const space = document.createTextNode(` ${after}`)
    const parent = textNode.parentNode
    const nextSibling = textNode.nextSibling
    if (nextSibling) {
      parent.insertBefore(el, nextSibling)
      parent.insertBefore(space, nextSibling)
    } else {
      parent.appendChild(el)
      parent.appendChild(space)
    }
    placeCaretAfter(space, 1)
  }

  if (match.url) {
    // Create emote image
    const img = document.createElement('img')
    img.src = match.url
    img.alt = match.name
    img.dataset.emoteName = match.name
    img.className = 'hs-input-emote hs-cycling-emote'
    img.draggable = false
    attachInputEmoteErrorRecovery(img)
    if (typeof hsAttachInputEmoteSnap === 'function') hsAttachInputEmoteSnap(img)
    _applyInputBlock(img)
    // Zero-width / overlay: stack onto preceding emote so the input preview
    // matches how chat will render the same word sequence.
    const resolved = typeof lookupEmoteWithOverlay === 'function' ? lookupEmoteWithOverlay(match.name) : null
    const wantsOverlay = completionWantsOverlay(match, resolved)
    if (wantsOverlay && before.trim() === '') {
      // Base = element chip OR a raw emoji ending a PRECEDING text node
      // (split-node input — resolveOverlayBaseLeft wraps it into a span).
      const prev = resolveOverlayBaseLeft(textNode)
      if (prev) {
        // Drop whitespace nodes between prev base and current text node
        let ws = prev.nextSibling
        while (ws && ws !== textNode) {
          const rm = ws
          ws = ws.nextSibling
          rm.remove()
        }
        stackInputEmote(prev, img)
        textNode.textContent = after || ' '
        placeCaretAfter(textNode, 1)
        pendingMessage = getInputText()
        updateCharCount()
        input.focus()
        return
      }
    }
    // Overlay onto a raw unicode emoji typed/pasted as plain text in `before`
    // (parity with the typed live-replace path and chat render).
    if (wantsOverlay && typeof peelTrailingEmoji === 'function') {
      const peeled = peelTrailingEmoji(before.replace(/\s+$/, ''))
      if (peeled) {
        const parent = textNode.parentNode
        const restNode = peeled.rest ? document.createTextNode(peeled.rest) : null
        const emojiSpan = document.createElement('span')
        emojiSpan.className = 'hs-mc-emoji'
        emojiSpan.textContent = peeled.emoji
        if (restNode) parent.insertBefore(restNode, textNode)
        parent.insertBefore(emojiSpan, textNode)
        stackInputEmote(emojiSpan, img)
        textNode.textContent = after || ' '
        placeCaretAfter(textNode, 1)
        pendingMessage = getInputText()
        updateCharCount()
        input.focus()
        return
      }
    }
    insertElement(img)
  } else if (match.type === 'emoji') {
    // Create emoji tracking span
    const span = document.createElement('span')
    span.className = 'hs-cycling-text'
    span.textContent = match.emoji
    span.dataset.completionName = match.name
    insertElement(span)
  } else if (match.type === 'user-bare') {
    // Bare-name mention chip: colored, hoverable, clickable
    const userSpan = createUserMentionSpan(match.name, match.color)
    insertElement(userSpan)
  } else if (match.type === 'user') {
    // @user — wrap in cycling-text span so subsequent Tabs replace this chip
    // (without a marker, the cycle would append a second @user onto the line).
    const span = document.createElement('span')
    span.className = 'hs-cycling-text'
    span.textContent = match.name
    span.dataset.completionName = match.name
    insertElement(span)
  } else {
    // Plain text completion (fallback)
    const newText = `${before + match.name} ${after}`
    textNode.textContent = newText
    const newPos = before.length + match.name.length + 1
    range.setStart(textNode, newPos)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  pendingMessage = getInputText()
  updateCharCount()
  input.focus()
}

function placeCaretAfter(node, offset = 0) {
  const sel = window.getSelection()
  const range = document.createRange()
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, Math.min(offset, node.length))
  } else {
    range.setStartAfter(node)
  }
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

// Cycle-depth + visibility readout for the current Tab match. "cat" tells you
// WHERE in the cycle you are (channel → your set → global → 7tv search, getting
// rarer as you go); "vis" tells you WHO actually sees the image if you send it:
//   everyone   — text/unicode or native Twitch emotes, no extension needed
//   {prov} users — bttv/ffz/7tv emote active in this channel/globally: anyone
//                  running that provider's extension sees it (heatsync too)
//   heatsync only — your personal set + 7tv catalog-search hits: only viewers
//                   running heatsync render these; everyone else sees plain text
// Colors form a breadth gradient: green (all) → yellow (needs an ext) → orange
// (heatsync only), so you can feel how deep / how niche the current pick is.
function emoteCycleMeta(m) {
  if (!m) return { cat: '', vis: null }
  if (m.type === 'user' || m.type === 'user-bare') return { cat: 'chatter', vis: { t: 'everyone', c: 'var(--hs-ok)' } }
  if (m.type === 'emoji') return { cat: 'emoji', vis: { t: 'everyone', c: 'var(--hs-ok)' } }
  if (m.remote) return { cat: '7tv search', vis: { t: 'heatsync only', c: 'var(--hs-brand)' } }
  const tier = m.tier ?? 2
  const cat = tier === 0 ? 'channel' : tier === 1 ? 'your inventory' : 'global'
  if (m.source === 'twitch') return { cat, vis: { t: 'all twitch', c: 'var(--hs-ok)' } }
  // Kick-native channel/sub emotes are platform-native too — every Kick viewer
  // sees them, no extension needed.
  if (m.source === 'kick') return { cat, vis: { t: 'all kick', c: 'var(--hs-ok)' } }
  // Your personal set (tier 1) or a heatsync-hosted emote: others only see it via
  // heatsync's sender-set merge — non-heatsync viewers get plain text.
  if (tier === 1 || m.source === 'heatsync') return { cat, vis: { t: 'heatsync only', c: 'var(--hs-brand)' } }
  // Third-party emote active in the channel/global set — provider-ext users see it.
  return { cat, vis: { t: `${m.source || 'ext'} users`, c: 'var(--hs-gold)' } }
}

function showCycleTooltip() {
  let tt = document.getElementById('hs-mc-cycle-tooltip')
  if (!tt) {
    tt = document.createElement('div')
    tt.id = 'hs-mc-cycle-tooltip'
    tt.style.cssText =
      'position:absolute;bottom:100%;left:8px;background:#000;color:#fff;padding:4px 8px;font-size:13px;border-radius:0;z-index:1003;margin-bottom:4px;white-space:nowrap;'
    document.getElementById('hs-mc-inputbar')?.appendChild(tt)
  }
  const m = acState.matches[acState.index]
  if (!m) {
    tt.style.display = 'none'
    return
  }
  const meta = emoteCycleMeta(m)
  const mkSpan = (text, css) => {
    const s = document.createElement('span')
    s.textContent = text
    if (css) s.style.cssText = css
    return s
  }
  const dot = () => mkSpan(' · ', 'color:#555;')
  tt.replaceChildren()
  tt.appendChild(mkSpan(`${acState.index + 1}/${acState.matches.length}`, 'color:#888;'))
  tt.appendChild(mkSpan(` ${m.type === 'emoji' ? `${m.emoji} ${m.name}` : m.name}`, 'color:#fff;'))
  if (meta.cat) {
    tt.appendChild(dot())
    tt.appendChild(mkSpan(meta.cat, 'color:#9e9e9e;'))
  }
  if (meta.vis) {
    tt.appendChild(dot())
    tt.appendChild(mkSpan(meta.vis.t, `color:${meta.vis.c};`))
  }
  // Surface the live catalog fetch so you know when a 7tv search is firing.
  if (acState.remotePending) {
    tt.appendChild(dot())
    tt.appendChild(mkSpan('searching 7tv…', 'color:var(--hs-gold);'))
  }
  tt.style.display = 'block'
}

function hideCycleTooltip() {
  const tt = document.getElementById('hs-mc-cycle-tooltip')
  if (tt) tt.style.display = 'none'
}

function hideAutocomplete() {
  acState.active = false
  acState.matches = []
  acState.index = 0
  acState.wordStart = 0
  acState.afterText = ''
  acState.search = ''
  acState._frecBumped = null // session over — whatever was last bumped is the commit
  acState.remoteDone = false
  acState.remotePending = false
  acState._remotePage = 0
  acState._remoteExhausted = null
  acState._aiSeq = 0
  _acRemoteToken++ // invalidate any in-flight 7TV fetch
  if (_acRemoteAbort) {
    try {
      _acRemoteAbort.abort()
    } catch (_) {}
  }
  hideCycleTooltip()

  // WYSIWYG: finalize cycling elements (remove cycling class so they're permanent)
  if (wysiwygEnabled) {
    const input = document.getElementById('hs-mc-input')
    const cyclingEmote = input?.querySelector('.hs-cycling-emote')
    if (cyclingEmote) {
      cyclingEmote.classList.remove('hs-cycling-emote')
    }
    const cyclingText = input?.querySelector('.hs-cycling-text')
    if (cyclingText) {
      // Emoji spans must stay wrapped (caret would otherwise snap mid-grapheme
      // around the U+FE0F variation selector). For non-emoji cycling text,
      // unwrap to a plain text node so it merges naturally with surrounding text.
      if (cyclingText.classList.contains('hs-mc-emoji')) {
        cyclingText.classList.remove('hs-cycling-text')
        delete cyclingText.dataset.completionName
      } else {
        const textNode = document.createTextNode(cyclingText.textContent)
        cyclingText.replaceWith(textNode)
      }
    }
    const cyclingUser = input?.querySelector('.hs-cycling-user')
    if (cyclingUser) {
      // Keep the styled mention span — just clear the cycling marker
      cyclingUser.classList.remove('hs-cycling-user')
    }
  }
}

// --- Colon dropdown (emotes + emoji) and @-mention dropdown ---
// Both share one shape: detect a live "<trigger><query>" run touching the
// caret, list ranked matches, let arrow/Enter/Tab/click pick one, and hand
// the pick off to acState so Tab-cycle can keep refining it from there.
// getTriggerContext is the only DOM-cursor logic (wysiwyg vs plain-text) —
// everything mode-specific lives there once instead of twice.

// Precompiled per (triggerChar,minLen) combo — the 2 call sites below are the
// only ones that exist, so building fresh RegExps per keystroke was pure waste.
const _hsTriggerContextRe = {
  emojiColon: /:([a-z0-9_]{2,})$/i,
  mention: /@([a-z0-9_]{0,})$/i,
}

function getTriggerContext(input, triggerChar, minLen) {
  const re =
    triggerChar === ':' && minLen === 2
      ? _hsTriggerContextRe.emojiColon
      : triggerChar === '@' && minLen === 0
        ? _hsTriggerContextRe.mention
        : new RegExp(`${triggerChar}([a-z0-9_]{${minLen},})$`, 'i')
  if (wysiwygEnabled) {
    const sel = window.getSelection()
    if (!sel?.rangeCount) return null
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node?.nodeType !== Node.TEXT_NODE) return null
    const before = node.textContent.slice(0, range.startOffset)
    const match = before.match(re)
    return match ? { query: match[1] } : null
  }
  const text = input.value
  const before = text.slice(0, input.selectionStart)
  const match = before.match(re)
  return match ? { query: match[1] } : null
}

function getEmojiColonContext(input) {
  return getTriggerContext(input, ':', 2)
}

function getMentionContext(input) {
  // minLen 0: a bare '@' pops the dropdown immediately with recent chatters
  // ranked first (mellen's ask — see the visible-dropdown request). Typing
  // narrows; Escape or a space dismisses.
  return getTriggerContext(input, '@', 0)
}

function showEmojiDropdown(matches, selectedIndex) {
  let dd = document.getElementById('hs-mc-emoji-dropdown')
  if (!dd) {
    dd = document.createElement('div')
    dd.id = 'hs-mc-emoji-dropdown'
    document.getElementById('hs-mc-inputbar')?.appendChild(dd)
  }
  dd.textContent = ''
  matches.forEach((entry, i) => {
    const row = document.createElement('div')
    row.className = `hs-mc-emoji-row${i === selectedIndex ? ' selected' : ''}`
    row.dataset.index = i

    if (entry.type === 'emoji') {
      const emojiSpan = document.createElement('span')
      emojiSpan.className = 'hs-mc-emoji-preview'
      emojiSpan.textContent = entry.emoji
      row.appendChild(emojiSpan)
    } else if (entry.url) {
      const img = document.createElement('img')
      img.className = 'hs-mc-emote-preview'
      img.src = entry.url
      img.alt = entry.name
      img.loading = 'lazy'
      row.appendChild(img)
    }

    const nameSpan = document.createElement('span')
    nameSpan.className = 'hs-mc-emoji-name'
    nameSpan.textContent = entry.type === 'emoji' ? `:${entry.name}:` : entry.name
    row.appendChild(nameSpan)

    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      insertEmojiFromDropdown(entry)
      showCycleTooltip()
    })

    dd.appendChild(row)
  })
  dd.style.display = 'block'
}

function hideEmojiDropdown() {
  emojiAcState.active = false
  emojiAcState.matches = []
  emojiAcState.index = 0
  emojiAcState.query = ''
  const dd = document.getElementById('hs-mc-emoji-dropdown')
  if (dd) dd.style.display = 'none'
}

// Route the pick through the exact insertion path Tab-cycle uses (chip vs
// plain text, overlay stacking, frecency bump, blocked-emote outline) — see
// insertCompletionKeepOpen/insertCompletionWysiwyg — then hand off to
// acState so further Tab presses keep cycling this same ranked list. A
// dropdown pick becomes indistinguishable from typing the word + Tab once.
function insertEmojiFromDropdown(match) {
  const input = document.getElementById('hs-mc-input')
  if (!input || !match) return
  if (!wysiwygEnabled) captureAcWordBounds(input)
  insertCompletionKeepOpen(match)

  acState.matches = emojiAcState.matches
  acState.index = emojiAcState.matches.indexOf(match)
  if (acState.index === -1) acState.index = 0
  acState.active = true
  acState.search = `:${emojiAcState.query}`
  acState.remoteDone = false
  acState.remotePending = false

  hideEmojiDropdown()
  input.focus()
}

function checkEmojiAutocomplete() {
  const input = document.getElementById('hs-mc-input')
  if (!input) return

  const ctx = getEmojiColonContext(input)
  if (!ctx) {
    if (emojiAcState.active) hideEmojiDropdown()
    return
  }

  // Same match + rank logic Tab-cycle uses (findEmoteMatches + the shared
  // compareAcMatches comparator) — own inventory, channel emotes, cached
  // 7tv/bttv/ffz sets, and unicode emoji. Local-cache reads only, so this is
  // safe to run on every debounced keystroke (no network in the hot path).
  const matches = findEmoteMatches(`:${ctx.query}`).slice(0, EMOJI_DROPDOWN_MAX)
  if (matches.length === 0) {
    if (emojiAcState.active) hideEmojiDropdown()
    return
  }

  emojiAcState.active = true
  emojiAcState.matches = matches
  emojiAcState.query = ctx.query
  emojiAcState.index = 0
  showEmojiDropdown(matches, 0)
}

function showMentionDropdown(matches, selectedIndex) {
  let dd = document.getElementById('hs-mc-mention-dropdown')
  if (!dd) {
    dd = document.createElement('div')
    dd.id = 'hs-mc-mention-dropdown'
    document.getElementById('hs-mc-inputbar')?.appendChild(dd)
  }
  dd.textContent = ''
  matches.forEach((entry, i) => {
    const row = document.createElement('div')
    row.className = `hs-mc-emoji-row${i === selectedIndex ? ' selected' : ''}`
    row.dataset.index = i

    const nameSpan = document.createElement('span')
    nameSpan.className = 'hs-mc-emoji-name'
    nameSpan.textContent = entry.name
    // Sync-cache color only — zero per-row network fetch in the dropdown;
    // the async color fetch (if still unknown) happens on actual insert via
    // the same path bare-mention chips already use.
    const lower = entry.name.replace(/^@/, '').toLowerCase()
    const cached = (typeof knownColors !== 'undefined' && knownColors.get(lower)) || _hsUserColorCache.get(lower)
    if (cached) nameSpan.style.color = typeof sanitizeColor === 'function' ? sanitizeColor(cached) : cached
    row.appendChild(nameSpan)

    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      insertMentionFromDropdown(entry)
      showCycleTooltip()
    })

    dd.appendChild(row)
  })
  dd.style.display = 'block'
}

function hideMentionDropdown() {
  mentionAcState.active = false
  mentionAcState.matches = []
  mentionAcState.index = 0
  mentionAcState.query = ''
  const dd = document.getElementById('hs-mc-mention-dropdown')
  if (dd) dd.style.display = 'none'
}

function insertMentionFromDropdown(match) {
  const input = document.getElementById('hs-mc-input')
  if (!input || !match) return
  if (!wysiwygEnabled) captureAcWordBounds(input)
  insertCompletionKeepOpen(match)

  acState.matches = mentionAcState.matches
  acState.index = mentionAcState.matches.indexOf(match)
  if (acState.index === -1) acState.index = 0
  acState.active = true
  acState.search = `@${mentionAcState.query}`
  acState.remoteDone = false
  acState.remotePending = false

  hideMentionDropdown()
  input.focus()
}

function checkMentionAutocomplete() {
  const input = document.getElementById('hs-mc-input')
  if (!input) return

  const ctx = getMentionContext(input)
  if (!ctx) {
    if (mentionAcState.active) hideMentionDropdown()
    return
  }

  // findEmoteMatches('@'+query) already ranks current-channel recent
  // chatters (getRecencyMap) ahead of the rest of usernameCache — the same
  // comparator Tab-cycle uses for an explicit @-search.
  const matches = findEmoteMatches(`@${ctx.query}`).slice(0, MENTION_DROPDOWN_MAX)
  if (matches.length === 0) {
    if (mentionAcState.active) hideMentionDropdown()
    return
  }

  mentionAcState.active = true
  mentionAcState.matches = matches
  mentionAcState.query = ctx.query
  mentionAcState.index = 0
  showMentionDropdown(matches, 0)
}

// Reply state management
function setReplyState(state) {
  replyState = state
  showInputBar()
  const bar = document.getElementById('hs-mc-inputbar')
  if (!bar) return
  // Remove existing indicator
  document.getElementById('hs-mc-reply-indicator')?.remove()
  const indicator = document.createElement('div')
  indicator.id = 'hs-mc-reply-indicator'
  const label = document.createElement('span')
  label.textContent = `\u21a9 ${t('mc_input_replying_to', [String(state.user || '').replace(/^@+/, '')])}`
  const cancel = document.createElement('button')
  cancel.id = 'hs-mc-reply-cancel'
  cancel.textContent = '✕'
  cancel.title = t('mc_input_cancel_reply')
  cancel.addEventListener('click', () => {
    clearReplyState()
    hideInputBar() // explicit cancel — ok to re-hide an empty composer
  })
  indicator.appendChild(label)
  indicator.appendChild(cancel)
  bar.insertBefore(indicator, bar.firstChild)
  document.getElementById('hs-mc-input')?.focus()
}

function clearReplyState() {
  replyState = null
  document.getElementById('hs-mc-reply-indicator')?.remove()
  // NO hideInputBar here — sendMessage clears reply state on EVERY send, and
  // the hide nuked composer focus for auto-hide users (focus() can't reach an
  // element inside a hidden bar). The two explicit cancel paths (✕ button,
  // Escape) hide at their call sites instead.
}

// Get Twitch auth token from cookie
function getTwitchAuthToken() {
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf('=')
    if (eqIdx === -1) continue
    const key = cookie.slice(0, eqIdx).trim()
    const value = cookie.slice(eqIdx + 1).trim()
    if (key === 'auth-token' && value) {
      return decodeURIComponent(value)
    }
  }
  return null
}

// Async version — returns { token, username } for cross-platform Twitch posting
// Tries document.cookie first, falls back to background.js cookies API
async function getTwitchAuthTokenAsync() {
  const localToken = getTwitchAuthToken()
  if (localToken) return { token: localToken, username: null }
  // Cross-domain: ask background.js to read Twitch cookies
  try {
    const resp = await safeSendMessage({ type: 'get_twitch_auth_token' })
    return { token: resp?.token || null, username: resp?.username || null }
  } catch {}
  return { token: null, username: null }
}

// Send message to current tab's channel
// Emoji lookup map — LAZY. emoji-data.js is a sibling content script; the
// manifest lists it before the bundle in the same entry (same-block order IS
// guaranteed; cross-block order is not — 43f297b bet on it and silently
// killed twitch/kick emoji autocomplete). The lazy retry makes any residual
// ordering weirdness self-heal on first use instead of freezing empty forever.
const _emojiMap = new Map()
function _ensureEmojiMap() {
  if (_emojiMap.size === 0 && typeof EMOJI_DATA !== 'undefined') {
    for (const e of EMOJI_DATA) _emojiMap.set(e.name, e.emoji)
  }
  return _emojiMap
}
_ensureEmojiMap()

// Replace :shortcode: patterns with emoji characters
function convertEmojiShortcodes(text) {
  if (_ensureEmojiMap().size === 0) return text
  return text.replace(/:([a-z0-9_]+):/g, (match, name) => _emojiMap.get(name) || match)
}

function clearInput(input) {
  hideEmojiDropdown()
  hideMentionDropdown()
  hideSlashDropdown()
  if (wysiwygEnabled) input.textContent = ''
  else input.value = ''
  pendingMessage = ''
  updateCharCount()
  // programmatic clears fire no input event — queue the auto-hide here.
  // Deferred a tick because several send paths arm the rapid-fire window
  // AFTER clearing; a synchronous hide would land before keepComposerOpen
  // and yank the composer mid-send. Once armed, the retry timer hides the
  // idle empty bar when stickiness expires; bare clears hide next tick.
  cleanup.setTimeout(() => hideInputBar(), 0)
}

// Match a "/<partial>" query against both canonical command names AND aliases,
// so "/hl" completes to /highlight, "/to" to /timeout, etc. Alias hits resolve
// to their canonical command (insertSlashCommand inserts the real name). Without
// this, typing a documented alias + Tab silently did nothing (only cmd names
// matched) — reported live for /hl. Canonical matches rank first, then aliases.
function matchSlashCommands(q) {
  const byCmd = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q))
  if (!q) return byCmd
  const seen = new Set(byCmd.map((c) => c.cmd))
  const viaAlias = []
  for (const [alias, target] of Object.entries(SLASH_ALIASES)) {
    if (typeof target !== 'string') continue // null = explicit pass-through
    if (!alias.startsWith(q) || seen.has(target)) continue
    const c = SLASH_COMMANDS.find((x) => x.cmd === target)
    if (c) {
      viaAlias.push(c)
      seen.add(target)
    }
  }
  return [...byCmd, ...viaAlias]
}

function checkSlashAutocomplete(precomputedText) {
  const text =
    typeof precomputedText === 'string'
      ? precomputedText
      : (typeof getInputText === 'function' ? getInputText() : '') || ''
  const m = text.match(/^\/([a-z?]*)$/i)
  if (!m) {
    hideSlashDropdown()
    return
  }
  const q = m[1].toLowerCase()
  const matches = matchSlashCommands(q).slice(0, 8)
  if (matches.length === 0) {
    hideSlashDropdown()
    return
  }
  if (!slashAcState.active || slashAcState.index >= matches.length) slashAcState.index = 0
  slashAcState.active = true
  slashAcState.matches = matches
  showSlashDropdown(matches, slashAcState.index)
}

function showSlashDropdown(matches, idx) {
  let dd = document.getElementById('hs-mc-slash-dropdown')
  if (!dd) {
    dd = document.createElement('div')
    dd.id = 'hs-mc-slash-dropdown'
    document.getElementById('hs-mc-inputbar')?.appendChild(dd)
  }
  dd.textContent = ''
  matches.forEach((c, i) => {
    const row = document.createElement('div')
    row.className = `hs-mc-slash-row${i === idx ? ' selected' : ''}`
    row.dataset.index = i
    const name = document.createElement('span')
    name.className = 'hs-mc-slash-name'
    name.textContent = `/${c.cmd}`
    const args = document.createElement('span')
    args.className = 'hs-mc-slash-args'
    args.textContent = c.args ? ` ${c.args}` : ''
    const desc = document.createElement('span')
    desc.className = 'hs-mc-slash-desc'
    desc.textContent = c.desc
    row.appendChild(name)
    row.appendChild(args)
    row.appendChild(desc)
    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      insertSlashCommand(c)
    })
    dd.appendChild(row)
  })
  dd.style.display = 'block'
}

function hideSlashDropdown() {
  slashAcState.active = false
  slashAcState.matches = []
  slashAcState.index = 0
  const dd = document.getElementById('hs-mc-slash-dropdown')
  if (dd) dd.style.display = 'none'
}

function insertSlashCommand(c) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  const inserted = `/${c.cmd}${c.args ? ' ' : ''}`
  if (wysiwygEnabled) {
    input.textContent = inserted
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  } else {
    input.value = inserted
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(inserted.length, inserted.length)
    }
  }
  hideSlashDropdown()
  pendingMessage = inserted
  if (typeof updateCharCount === 'function') updateCharCount()
  input.focus()
}

// Slash commands we own. Anything not in here falls through to the platform
// (Twitch IRC / Kick) so /ban /timeout /mod /vip /raid /clear /slow /me etc
// just work for users with mod perms.
//
// Handler return contract:
//   true     -> consumed, do nothing else
//   string   -> rewrite the outgoing text to this and continue normal send
//   anything else -> not a slash command we handle, pass through unchanged
const SLASH_ALIASES = {
  post: 'op',
  whisper: 'w',
  re: 'r',
  reply: 'r',
  // /ban /unban /timeout /to /b /untimeout /delete — handled below via GQL,
  // not passthrough. Twitch deprecated these as IRC chat commands in Feb 2023;
  // sending them as text now silently no-ops, which is what caused multichat's
  // pre-fix /unban to do nothing. Aliases map all common shorthands to the
  // canonical command.
  hl: 'highlight',
  b: 'ban',
  to: 'timeout',
  untimeout: 'unban',
  unto: 'unban',
  del: 'delete',
  lc: 'lclear',
  '?': 'help',
  pred: 'prediction',
  predict: 'prediction',
  // chat-mode aliases → canonical mode command (see CHAT_MODES)
  followersonly: 'followers',
  followeronly: 'followers',
  slowmode: 'slow',
  emote: 'emoteonly',
  emoteonlymode: 'emoteonly',
  subonly: 'subscribers',
  subsonly: 'subscribers',
  subscribersonly: 'subscribers',
  subs: 'subscribers',
  uniquechat: 'unique',
  r9k: 'unique',
  r9kbeta: 'unique',
}

// Twitch chat modes — set via Helix /chat/settings (setTwitchChatMode). Each maps
// to the Helix boolean field; `dur` modes also take a duration arg. follower
// duration is MINUTES (0–129600), slow is SECONDS (3–120). Kick has no chat-mode
// write API wired yet, so these are twitch-only (clear message below).
const CHAT_MODES = {
  followers: { field: 'follower_mode', dur: 'follower_mode_duration', unit: 'min', label: 'followers-only' },
  slow: { field: 'slow_mode', dur: 'slow_mode_wait_time', unit: 'sec', label: 'slow mode' },
  emoteonly: { field: 'emote_mode', label: 'emote-only' },
  subscribers: { field: 'subscriber_mode', label: 'subscribers-only' },
  unique: { field: 'unique_chat_mode', label: 'unique-chat' },
}

// Kick supports four of the five (no unique-chat/r9k equivalent).
const KICK_MODE_CMDS = new Set(['slow', 'followers', 'subscribers', 'emoteonly'])

// Parse a chat-mode duration arg into the unit Twitch expects.
// minutes: bare number = minutes; m/h/d/w suffixes; s rounds up to a minute.
// seconds: bare number = seconds. Returns null on malformed input.
function _parseModeDuration(arg, unit) {
  const m = arg.match(/^(\d+)\s*([smhdw]?)$/)
  if (!m) return null
  let n = parseInt(m[1], 10)
  const suf = m[2]
  if (unit === 'sec') {
    if (suf === 'm') n *= 60
    else if (suf === 'h') n *= 3600
    return Math.min(86400, Math.max(0, n))
  }
  // minutes
  if (suf === 'h') n *= 60
  else if (suf === 'd') n *= 1440
  else if (suf === 'w') n *= 10080
  else if (suf === 's') n = Math.ceil(n / 60)
  return Math.min(129600, Math.max(0, n))
}

async function handleSlashCommand(text, input) {
  const parts = text.match(/^\/(\w+|\?)\s*(.*)$/)
  if (!parts) return false
  let [, cmd, rest] = parts
  cmd = cmd.toLowerCase()
  if (SLASH_ALIASES[cmd] === null) return false // explicit pass-through
  if (typeof SLASH_ALIASES[cmd] === 'string') cmd = SLASH_ALIASES[cmd]

  if (cmd === 'op') {
    if (!rest.trim()) {
      showToast(t('mc_input_usage_op'))
      return true
    }
    if (!hsAuthToken) {
      showToast(t('mc_input_login_first_op'), 'error')
      return true
    }
    const ok = await postFeedMessage(rest.trim(), { topLevel: true })
    // postFeedMessage already surfaces the specific failure (401/429/409) —
    // a second generic toast on top of it just says less, twice.
    if (ok) showToast(t('mc_input_success'), 'success')
    clearInput(input)
    return true
  }

  // /opr <text> — reply to the last feed [OP] that appeared inline in chat.
  // Deliberately NOT wired to /re: that is an alias of /r, which sends a
  // WHISPER. Repointing it would turn a mistyped private reply into a public
  // post, and that is not a direction this should ever fail in.
  if (cmd === 'opr') {
    if (!rest.trim()) {
      showToast('usage: /opr <text>')
      return true
    }
    if (!hsAuthToken) {
      showToast(t('mc_input_login_first_op'), 'error')
      return true
    }
    if (!lastInlineFeedOpId) {
      showToast('no post in chat to reply to yet', 'error')
      return true
    }
    const ok = await postFeedMessage(rest.trim(), { replyTo: lastInlineFeedOpId })
    if (ok) showToast(t('mc_input_success'), 'success')
    clearInput(input)
    return true
  }

  if (cmd === 'w') {
    const match = rest.match(/^@?(\S+)\s+(.+)$/)
    if (match) {
      await sendSlashWhisper('twitch', match[1], match[2], input)
      return true
    }
    // Bare "/w <user>" (no message) → open the conversation instead of hinting.
    const bare = rest.trim().replace(/^@/, '')
    if (bare && !/\s/.test(bare)) {
      await openWhisperConversation('twitch', bare, input)
      return true
    }
    showToast(t('mc_input_usage_w'))
    return true
  }

  if (cmd === 'dm') {
    const match = rest.match(/^@?(\S+)\s+(.+)$/)
    if (match) {
      await sendSlashWhisper('heatsync', match[1], match[2], input)
      return true
    }
    // Bare "/dm <user>" (no message) → open the conversation instead of hinting.
    const bare = rest.trim().replace(/^@/, '')
    if (bare && !/\s/.test(bare)) {
      await openWhisperConversation('heatsync', bare, input)
      return true
    }
    showToast(t('mc_input_usage_dm'))
    return true
  }

  if (cmd === 'r') {
    if (!rest.trim()) {
      showToast(t('mc_input_usage_r'))
      return true
    }
    // armed (↩-clicked) target takes priority and survives incoming whispers
    // retargeting lastWhisperKey; plain /r without arming falls back to it
    const target = typeof armedReplyKey !== 'undefined' && armedReplyKey ? armedReplyKey : lastWhisperKey
    if (!target) {
      showToast(t('mc_input_no_one_to_reply'), 'error')
      return true
    }
    let ok = false
    try {
      ok = await sendWhisperMessage(target, rest.trim())
    } finally {
      if (typeof armedReplyKey !== 'undefined' && armedReplyKey === target) armedReplyKey = null
    }
    clearInput(input)
    // Same containment as /w: stay put on success, surface whispers on failure.
    if (ok) showToast(t('mc_whisper_sent', [whisperUsers.get(target)?.displayName || '']), 'success')
    else if (currentTab !== 'whispers') switchTab('whispers')
    settleComposerAfterSend(input)
    return true
  }

  if (cmd === 'follow' || cmd === 'unfollow') {
    const u = rest.trim().replace(/^@/, '').toLowerCase()
    if (!u) {
      showToast(t('mc_input_usage_follow', [cmd]))
      return true
    }
    if (typeof resolveIdentity !== 'function') {
      showToast(t('mc_input_not_ready'), 'error')
      return true
    }
    const ri = await resolveIdentity(u, {})
    const p = ri?.profile
    const id = p?.id || p?.userId
    if (!id) {
      if (ri?.transient) {
        showToast(
          ri.status === 429
            ? t('mc_input_rate_limited')
            : t('mc_input_server_unreachable', [String(ri.status || 'net')]),
          'error',
        )
      } else {
        showToast(t('mc_input_not_on_heatsync', [u]), 'error')
      }
      return true
    }
    const yf = !!(p.relationship?.youFollow || p.relationship?.isFollowing)
    const wantFollow = cmd === 'follow'
    if (wantFollow && yf) {
      showToast(t('mc_input_already_following', [u]))
      return true
    }
    if (!wantFollow && !yf) {
      showToast(t('mc_input_not_following', [u]))
      return true
    }
    // pcToggleFollow flips the current state — pass `yf` as currentlyFollowing
    pcToggleFollow(id, u, yf)
    return true
  }

  // Every namespace form of a bare name — right-click/profile mutes store
  // platform-scoped keys (twitch:alice), but slash commands have no platform,
  // so match/clear across all of them plus any profile-linked alias keys.
  // `yt:` is the legacy short form (canonPlatform now writes `youtube:` but
  // old storage still carries it and enforcement matches it); `heatsync:`
  // comes from muting on a heatsync-platform row. Both must be clearable or
  // an unmute reports success while the entry keeps hiding the user.
  const _muteKeyForms = (bare, aliasKeys) =>
    Array.from(
      new Set([
        bare,
        `twitch:${bare}`,
        `kick:${bare}`,
        `youtube:${bare}`,
        `yt:${bare}`,
        `heatsync:${bare}`,
        ...(aliasKeys || []),
      ]),
    )

  if (cmd === 'mute') {
    const u = rest.trim().replace(/^@/, '').toLowerCase()
    if (!u) {
      showToast(t('mc_input_usage_mute'))
      return true
    }
    // platform unknown from slash command — expandUserAliasKeys does both the
    // sync local-link fan-out AND the async server-linked-account fan-out, same
    // as right-click mute (_toggleMcMute); null platform → userKey returns bare
    // key, so /mute stays global (correct: no platform context from bare name).
    const aliasKeys = typeof expandUserAliasKeys === 'function' ? await expandUserAliasKeys(u, null) : [u]
    const already = _muteKeyForms(u, aliasKeys).some((k) => mutedUsers.has(k))
    if (already) {
      showToast(t('mc_input_already_muted', [u]))
      return true
    }
    for (const k of aliasKeys) mutedUsers.add(k)
    persistMcMuted()
    const exp = Date.now() + 86400000
    for (const k of aliasKeys) safeSendMessage({ type: 'mute_user', username: k, expiresAt: exp })
    const aliasNote = aliasKeys.length > 1 ? ` (+@${aliasKeys[1]})` : ''
    showToast(t('mc_input_muted', [u + aliasNote]), 'success')
    renderMessages(currentTab)
    return true
  }

  if (cmd === 'unmute') {
    const u = rest.trim().replace(/^@/, '').toLowerCase()
    if (!u) {
      showToast(t('mc_input_usage_unmute'))
      return true
    }
    // Same async fan-out as /mute and right-click mute — covers server-linked
    // accounts, not just sync-local links.
    const aliasKeys = typeof expandUserAliasKeys === 'function' ? await expandUserAliasKeys(u, null) : [u]
    const forms = _muteKeyForms(u, aliasKeys)
    const wasMuted = forms.some((k) => mutedUsers.has(k))
    if (!wasMuted) {
      showToast(t('mc_input_not_muted', [u]))
      return true
    }
    for (const k of forms) mutedUsers.delete(k)
    persistMcMuted()
    for (const k of aliasKeys) safeSendMessage({ type: 'unmute_user', username: k })
    showToast(t('mc_input_unmuted', [u]), 'success')
    renderMessages(currentTab)
    return true
  }

  if (cmd === 'shrug') {
    return `${rest.trim() ? `${rest.trim()} ` : ''}¯\\_(ツ)_/¯`
  }

  if (cmd === 'tableflip') {
    return `${rest.trim() ? `${rest.trim()} ` : ''}(╯°□°)╯︵ ┻━┻`
  }

  if (cmd === 'unflip') {
    return `${rest.trim() ? `${rest.trim()} ` : ''}┬─┬ノ( ゜-゜ノ)`
  }

  if (cmd === 'lclear') {
    let cleared = 0
    if (irc?.channels?.has(currentTab)) {
      irc.channels.get(currentTab).clear?.()
      cleared++
    }
    if (kickChat?.channels?.has(currentTab)) {
      kickChat.channels.get(currentTab).clear?.()
      cleared++
    }
    renderMessages(currentTab)
    showToast(cleared ? t('mc_input_buffer_cleared') : t('mc_input_nothing_to_clear'), cleared ? 'success' : undefined)
    clearInput(input)
    return true
  }

  if (cmd === 'help') {
    showSlashHelp()
    clearInput(input)
    return true
  }

  // /status [channel] — show current chat modes + stream info for a twitch
  // channel. Defaults to the current channel tab. Mod-only fields (chat
  // delay) light up automatically when the viewer mods the channel.
  if (cmd === 'status' || cmd === 'modes') {
    const arg = rest.trim().toLowerCase().replace(/^#/, '')
    const ch =
      arg && /^[a-z0-9_]{2,40}$/.test(arg)
        ? arg
        : typeof currentTab === 'string' && /^[a-z0-9_]{2,40}$/.test(currentTab)
          ? currentTab
          : null
    if (!ch) {
      showToast(t('mc_input_status_needs_channel'), 'error')
      return true
    }
    clearInput(input)
    showChatStatusPanel(ch)
    return true
  }

  // ─── Mod actions ─── Twitch via GQL, Kick via tab-relay API.
  // On a Twitch+Kick dual-link tab, dispatch to BOTH and surface a combined toast
  // so a mod can sanction a user everywhere with one command.
  // currentTab = channel login when on a per-channel tab; on aggregate tabs we
  // can't pick a single channel, so refuse with a useful toast.
  const modChannel = typeof currentTab === 'string' && /^[a-z0-9_]{2,40}$/i.test(currentTab) ? currentTab : null
  const _modCh = modChannel ? config.channels.find((c) => c.id === modChannel) : null
  const _twitchModName = _modCh?.twitch || (modChannel && !_modCh ? modChannel : null)
  const _kickModSlug = _modCh?.kick || null
  // Dual-platform dispatch + per-platform notice injection + combined toast all
  // live in the shared backbone (main.js dispatchModAction / showModResultToast).

  // YouTube leg for typed mod commands. YT moderation is message-scoped (the
  // relay drives YT's own message menu), so a typed "/ban name" resolves the
  // target's newest buffered YT message. Exact name match only — fuzzy
  // matching could moderate the wrong person.
  const _ytModMsgFor = (target) => {
    if (!_modCh?.youtube || typeof channelYtMessages === 'undefined') return null
    const tgt = String(target || '')
      .replace(/^@/, '')
      .toLowerCase()
    if (!tgt) return null
    const buf = channelYtMessages.get(modChannel) || []
    for (let i = buf.length - 1; i >= 0; i--) {
      const m = buf[i]
      if (
        m?.id &&
        String(m?.user || '')
          .replace(/^@/, '')
          .toLowerCase() === tgt
      )
        return m
    }
    return null
  }
  // skipConfirm: true when a twitch/kick fanout already ran (its confirm
  // dialog covered this action); false on YT-only tabs so the ban-confirm
  // gate still applies.
  const _ytModLeg = async (action, target, label, skipConfirm) => {
    if (!_modCh?.youtube) return null
    const m = _ytModMsgFor(target)
    if (!m) {
      const tgtName = String(target || '').replace(/^@/, '')
      showToast(
        t('mc_input_yt_mod_no_recent_msg', [tgtName]) ||
          `youtube: no recent message from ${tgtName} — use the message menu`,
        'error',
      )
      return null
    }
    const y = await dispatchModAction({
      channel: modChannel,
      platform: 'youtube',
      action,
      target,
      msgId: m.id,
      skipConfirm,
    })
    showModResultToast(label, target, y)
    return y
  }

  // Logged-out Twitch on a twitch-only tab: dispatch would die deep in the GQL
  // channel-id resolve and surface a misleading "<action> failed: channel not
  // found" toast. Root cause is unauthenticated, not a missing channel — show
  // plain-send's sticky not-logged-in cue instead and never dispatch. A
  // kick-capable tab still dispatches (its kick leg may be authed; the twitch
  // side's error then surfaces in the combined toast).
  const _twitchModAuthOk = async () => {
    if (!_twitchModName || _kickModSlug) return true
    // Hard ceiling: getTwitchAuthTokenAsync's background-SW fallback
    // (chrome.runtime.sendMessage) has no built-in timeout — if the SW
    // exists but its handler never calls sendResponse, this hangs forever
    // and every mod command downstream reads to the user as "Enter does
    // nothing" with zero feedback (2026-07-20 live incident). Race it.
    const { token } = await Promise.race([
      getTwitchAuthTokenAsync(),
      new Promise((resolve) => setTimeout(() => resolve({ token: null }), 5000)),
    ])
    if (token) return true
    try {
      HsNotifs.emit('twitch-auth-required', { text: t('mc_input_not_logged_in') || 'log into twitch.tv to chat' })
    } catch (_) {}
    return false
  }

  if (cmd === 'ban' || cmd === 'timeout' || cmd === 'unban') {
    if (!modChannel) {
      showToast(t('mc_input_mod_needs_channel_tab', [cmd]), 'error')
      return true
    }
    const _hasTk = !!(_twitchModName || _kickModSlug)
    if (!_hasTk && !_modCh?.youtube) {
      showToast(t('mc_input_mod_needs_platform_channel', [cmd]), 'error')
      return true
    }
    if (_hasTk && !(await _twitchModAuthOk())) return true
    if (cmd === 'ban') {
      const m = rest.match(/^@?(\S+)(?:\s+(.+))?$/)
      if (!m) {
        showToast(t('mc_input_usage_ban'), 'error')
        return true
      }
      const [, target, reason] = m
      const r = _hasTk
        ? await dispatchModAction({ channel: modChannel, action: 'ban', target, reason, fanout: true })
        : null
      if (r) showModResultToast(t('mc_mod_label_banned'), target, r)
      if (r?.cancelled) return true
      const y = await _ytModLeg('ban', target, t('mc_mod_label_banned'), !!r)
      if (r?.anyOk || y?.anyOk) clearInput(input)
      return true
    }
    if (cmd === 'timeout') {
      const m = rest.match(/^@?(\S+)(?:\s+(\d+))?(?:\s+(.+))?$/)
      if (!m) {
        showToast(t('mc_input_usage_timeout'), 'error')
        return true
      }
      const [, target, secStr, reason] = m
      const sec = secStr ? Math.max(1, parseInt(secStr, 10)) : 600
      const r = _hasTk
        ? await dispatchModAction({
            channel: modChannel,
            action: 'timeout',
            target,
            durationSec: sec,
            reason,
            fanout: true,
          })
        : null
      if (r) showModResultToast(t('mc_mod_label_timed_out', [String(sec)]), target, r)
      const y = await _ytModLeg('timeout', target, t('mc_mod_label_timed_out', [String(sec)]), !!r)
      if (r?.anyOk || y?.anyOk) clearInput(input)
      return true
    }
    if (cmd === 'unban') {
      const target = rest.trim().replace(/^@/, '')
      if (!target) {
        showToast(t('mc_input_usage_unban'), 'error')
        return true
      }
      const r = _hasTk ? await dispatchModAction({ channel: modChannel, action: 'unban', target, fanout: true }) : null
      if (r) showModResultToast(t('mc_mod_label_unbanned'), target, r)
      const y = await _ytModLeg('unban', target, t('mc_mod_label_unbanned'), !!r)
      if (r?.anyOk || y?.anyOk) clearInput(input)
      return true
    }
  }

  if (cmd === 'testnotices') {
    // Local-only showcase: one synthetic row per supported twitch event type,
    // fed through the REAL pipeline (irc._handleMsg → classifier → renderer).
    // isSynthetic gates the archive relay; nothing leaves the machine.
    // _handleMsg drops channels that aren't JOINed in irc.channels — target
    // the current tab if joined, else the first joined channel.
    let ch = modChannel && irc?.channels?.has?.(modChannel) ? modChannel : null
    if (!ch) {
      try {
        ch = irc?.channels?.keys?.().next?.().value || null
      } catch (_) {}
    }
    if (!ch) {
      showToast('/testnotices: no joined twitch channel', 'error')
      return true
    }
    if (rest.trim() === 'raw') {
      // Raw-parse mode: authentic raw IRC lines through parseIrcLine — proves
      // the PARSE layer (tag reads), not just classifier+render. Local only.
      const TS = Date.now()
      let ri = 0
      const U = () => `hs-raw-${TS}-${ri++}`
      const P = (tags, login, text) =>
        `@${tags};id=${U()};tmi-sent-ts=${TS} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${ch} :${text}`
      const UN = (tags, text) =>
        `@${tags};id=${U()};tmi-sent-ts=${TS} :tmi.twitch.tv USERNOTICE #${ch}${text ? ` :${text}` : ''}`
      const L = [
        P(
          'badges=;color=#00FF7F;display-name=SharedGuy;room-id=111;source-room-id=222;source-id=x;user-id=901',
          'sharedguy',
          'raw shared-chat message from partner channel',
        ),
        UN(
          'badges=;color=;display-name=PartnerSub;login=partnersub;msg-id=sharedchatnotice;source-msg-id=resub;room-id=111;source-room-id=222;msg-param-cumulative-months=3;msg-param-sub-plan=1000;system-msg=PartnerSub\\ssubscribed\\sat\\sTier\\s1\\s(shared);user-id=902',
          'raw shared resub',
        ),
        P(
          'badges=;color=#FF0000;display-name=GigaGuy;msg-id=gigantified-emote-message;emotes=25:16-20;room-id=111;user-id=903',
          'gigaguy',
          'raw gigantified Kappa',
        ),
        P(
          'badges=;color=#5F87FF;display-name=FxGuy;msg-id=animated-message;animation-id=rainbow-eclipse;room-id=111;user-id=904',
          'fxguy',
          'raw message effect',
        ),
        P(
          'badges=;color=#00FFFF;display-name=NewGuy;msg-id=user-intro;room-id=111;user-id=905',
          'newguy',
          'raw hi im new to chat',
        ),
        P(
          'badges=;color=#FFD700;display-name=FirstGuy;first-msg=1;room-id=111;user-id=906',
          'firstguy',
          'raw first message ever',
        ),
        P(
          'badges=;color=#FF00FF;display-name=HighGuy;msg-id=highlighted-message;room-id=111;user-id=907',
          'highguy',
          'raw highlighted redeem',
        ),
        UN(
          'badges=;color=;display-name=CharityGuy;login=charityguy;msg-id=charitydonation;system-msg=CharityGuy\\sdonated\\s$10\\sto\\sSave\\sthe\\sKripps!;user-id=908',
          '',
        ),
        UN(
          'badges=;color=;display-name=PrimeGuy;login=primeguy;msg-id=primepaidupgrade;system-msg=PrimeGuy\\sconverted\\sfrom\\sPrime\\sto\\sTier\\s1!;user-id=909',
          '',
        ),
        UN(
          'badges=;color=;display-name=FwdGuy;login=fwdguy;msg-id=standardpayforward;system-msg=FwdGuy\\sis\\spaying\\sforward\\stheir\\sgift!;user-id=910',
          '',
        ),
      ]
      let ok = 0
      for (const rawLine of L) {
        try {
          const m = parseIrcLine(rawLine)
          if (m) {
            m.isSynthetic = true // never relay raw-test rows to the archive
            irc?._handleMsg?.(m)
            ok++
          }
        } catch (_) {}
      }
      showToast(`raw-parsed ${ok}/${L.length} lines into #${ch} (local only)`, ok === L.length ? 'success' : 'error')
      clearInput(input)
      return true
    }
    const now = Date.now()
    let i = 0
    const base = () => ({
      channel: ch,
      time: now + i,
      isSynthetic: true,
      id: `hs-test-${now}-${i++}`,
      color: '#fff',
      badges: '',
    })
    const un = (msgId, systemMsg, extra) => ({
      ...base(),
      type: 'usernotice',
      msgId,
      user: 'testuser',
      text: '',
      systemMsg,
      ...extra,
    })
    const no = (noticeType, systemMsg) => ({ ...base(), type: 'notice', noticeType, systemMsg })
    const pm = (text, extra) => ({ ...base(), user: 'testuser', login: 'testuser', userId: '0', text, ...extra })
    const kappa = { Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' }
    const rows = [
      un('sub', 'testuser subscribed at Tier 1.'),
      un('resub', 'testuser subscribed at Tier 1. They’ve been here 14 months!', {
        subMonths: 14,
        text: 'love this place',
      }),
      un('subgift', 'testuser gifted a Tier 1 sub to somebody!', { recipient: 'somebody' }),
      un('submysterygift', 'testuser is gifting 5 Tier 1 subs to the community!', { giftCount: 5 }),
      un('giftpaidupgrade', 'testuser is continuing the gift sub they got!'),
      un('primepaidupgrade', 'testuser converted from a Prime sub to a Tier 1 sub!'),
      un('extendsub', 'testuser extended their Tier 1 sub through next month!'),
      un('standardpayforward', 'testuser is paying forward the gift they got!'),
      un('communitypayforward', 'testuser is paying forward the gift they got to the community!'),
      un('rewardgift', 'testuser’s cheer shared rewards with the chat!'),
      un('raid', '12 raiders from testraider have joined!', { raidFrom: 'testraider', raidViewers: 12 }),
      un('unraid', 'the raid has been cancelled.'),
      un('announcement', '', { text: 'big announcement text' }),
      un('bitsbadgetier', 'bits badge tier notification', { bitsTier: 1000 }),
      un('watchstreak', 'testuser watched 5 consecutive streams and sparked a watch streak!', { streakCount: 5 }),
      un('viewermilestone', 'testuser reached a viewer milestone!'),
      un('mod-anniversary', 'testuser is celebrating 6 months as a mod!'),
      un('charitydonation', 'testuser donated $5 to Save the Kripps!'),
      un('ritual', 'testuser is new here — say hello!'),
      un('resub', 'shared-chat resub from the partner channel', {
        msgId: 'sharedchatnotice',
        sourceMsgId: 'resub',
        sharedChat: true,
      }),
      no('slow_on', 'this room is now in slow mode.'),
      no('ban_success', 'baduser was permanently banned'),
      no('timeout_success', 'baduser was timed out for 600s'),
      no('unban_success', 'baduser is no longer banned'),
      no('delete_message_success', 'message deleted'),
      no('mod_success', 'gooduser is now a moderator'),
      no('vip_success', 'gooduser is now a VIP'),
      no('pin', 'pinned testuser: check the discord for scrims'),
      no('msg_banned', 'you cannot send messages here (error family)'),
      pm('plain message baseline'),
      pm('waves at everyone', { isAction: true }),
      pm('cheer100 great play', { bits: 100 }),
      pm('used points to highlight this', { isHighlighted: true }),
      pm('redeemed a custom reward', { redeemed: true, rewardId: 'hs-test-reward' }),
      pm('first message ever in this channel', { isFirstMsg: true }),
      pm('back after a long break', { isReturningChatter: true }),
      pm('hi i’m new to chat', { userIntro: true }),
      pm('gigantified Kappa', { gigantified: true, twitchEmotes: kappa }),
      pm('paid message effect', { animationId: 'rainbow-eclipse' }),
      pm('hello from the partner channel', { sharedChat: true }),
    ]
    for (const r of rows) {
      try {
        irc?._handleMsg?.(r)
      } catch (_) {}
    }
    showToast(`injected ${rows.length} test rows into #${ch} (local only)`, 'success')
    clearInput(input)
    return true
  }

  if (cmd === 'highlight') {
    // Highlight My Message — twitch Bits power-up. Posts the message AND
    // applies the highlight in one GQL mutation, spending the user's own Bits
    // (same category as our prediction-betting / points-redemption). Twitch-only
    // (kick/youtube have no equivalent); the highlighted message echoes back
    // through the normal IRC read socket, so we do NOT also PRIVMSG it.
    // Resolve the twitch channel to highlight in, using ONLY helpers in scope
    // here. getLiveChannel is block-scoped to main.js — reach it through the
    // typeof guard the rest of input.js uses; an unguarded call (or the
    // getActiveTwitchChannel wrapper, which itself calls getLiveChannel on
    // live/feed/aggregate tabs) throws a ReferenceError that silently kills
    // this async handler → "no toast, no send".
    let twitchLogin = _modCh?.twitch || null
    if (!twitchLogin && currentTab === 'live' && typeof getLiveChannel === 'function') twitchLogin = getLiveChannel()
    // Twitch-only channel tab: the tab id itself is the twitch login.
    if (!twitchLogin && modChannel && modChannel !== 'live' && !_modCh) twitchLogin = modChannel
    if (!twitchLogin) {
      showToast(t('mc_input_highlight_needs_twitch') || '/highlight needs a twitch channel tab', 'error')
      return true
    }
    const message = rest.trim()
    if (!message) {
      showToast(t('mc_input_usage_highlight') || '/highlight <message>', 'error')
      return true
    }
    if (!getTwitchAuthToken()) {
      showToast(t('mc_input_highlight_login') || 'log into twitch.tv first', 'error')
      return true
    }
    const { id: channelId, transient: chTransient } = await resolveTwitchChannelIdEx(twitchLogin)
    if (!channelId) {
      showToast(
        chTransient
          ? t('mc_input_twitch_unreachable') || 'twitch unreachable — try again'
          : t('mc_input_highlight_no_channel') || 'could not resolve channel',
        'error',
      )
      return true
    }
    const replyParentId = replyState?.msgId || null
    const r = await sendHighlightedTwitchMessage(channelId, message, null, replyParentId)
    if (r?.ok) {
      clearInput(input)
      if (typeof replyState !== 'undefined' && replyState) clearReplyState()
      if (typeof r.balance === 'number') {
        showToast(
          t('mc_input_highlight_sent', [formatPoints(r.balance)]) || `highlighted · ${r.balance} bits left`,
          'success',
        )
      }
      settleComposerAfterSend(input)
    } else if (r?.unconfirmed) {
      // A client-side timeout — the highlight may already have posted and
      // charged. Do NOT clear the input (so a resend is one keystroke away) and
      // do NOT call it a failure. The transaction is idempotent at Twitch's bits
      // layer (sendHighlightedTwitchMessage caches transactionID), so a resend
      // of the same text charges once no matter what — say so.
      showToast(
        t('mc_input_highlight_unconfirmed') || 'highlight didn’t confirm — resend is safe, bits charge once',
        'warn',
      )
      settleComposerAfterSend(input)
    } else {
      showToast(
        t('mc_input_highlight_failed', [r?.error || 'unknown']) || `highlight failed: ${r?.error || 'unknown'}`,
        'error',
      )
    }
    return true
  }

  // ── poll / prediction commands (twitch) ─────────────────────────────────
  // Drive the same functions the predictions/polls panel uses. create / lock /
  // resolve / cancel / endpoll are broadcaster-only (twitch gates them
  // server-side; we surface the error). vote / bet are viewer actions. All
  // twitch-only. modChannel/_modCh/currentTab are resolved above (see /highlight).
  if (['poll', 'prediction', 'vote', 'bet', 'endpoll', 'lockpred', 'cancelpred', 'resolvepred'].includes(cmd)) {
    const _ppLogin = () => {
      let login = _modCh?.twitch || null
      if (!login && currentTab === 'live' && typeof getLiveChannel === 'function') login = getLiveChannel()
      if (!login && modChannel && modChannel !== 'live' && !_modCh) login = modChannel
      return login
    }
    // Resolve the twitch channel + require login; toast + null on failure.
    const _ppGate = () => {
      const login = _ppLogin()
      if (!login) {
        showToast(t('mc_input_pp_needs_twitch') || 'this needs a twitch channel tab', 'error')
        return null
      }
      if (!getTwitchAuthToken()) {
        showToast(t('mc_input_pp_login') || 'log into twitch.tv first', 'error')
        return null
      }
      return login
    }
    // "a | b | c | 60" → {title, items:[…], secs}. A trailing pure-number
    // segment is the duration, but only when a title + ≥2 items already precede
    // it (so a numeric last choice/outcome isn't mistaken for a duration).
    const _ppParse = (raw, defSecs, minSecs, maxSecs) => {
      const segs = raw
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
      let secs = defSecs
      if (segs.length >= 4 && /^\d+$/.test(segs[segs.length - 1])) {
        secs = Math.max(minSecs, Math.min(maxSecs, parseInt(segs.pop(), 10)))
      }
      return { title: segs.shift() || '', items: segs, secs }
    }
    // Live poll / prediction — fetch on demand if the panel was never opened, so
    // /vote and /bet work standalone.
    const _ppActivePoll = async (login) => {
      if (_lastPollData?.choices?.length) return _lastPollData
      const pr = await fetchPoll(login).catch(() => null)
      const poll = pr?.poll || null
      if (poll) _lastPollData = poll
      return poll
    }
    const _ppActivePred = async (login) => {
      if (_lastPredResult?.prediction?.outcomes?.length) return _lastPredResult.prediction
      const r = await fetchPrediction(login).catch(() => null)
      if (r) _lastPredResult = r
      return r?.prediction || null
    }

    if (cmd === 'poll' || cmd === 'prediction') {
      const login = _ppGate()
      if (!login) return true
      const isPoll = cmd === 'poll'
      const { title, items, secs } = _ppParse(rest, 120, isPoll ? 15 : 30, 1800)
      const maxItems = isPoll ? 5 : 10
      if (!title || items.length < 2 || items.length > maxItems) {
        showToast(
          isPoll
            ? t('mc_input_usage_poll') || '/poll question | choice1 | choice2 [| … up to 5] [| secs]'
            : t('mc_input_usage_prediction') || '/prediction title | outcome1 | outcome2 [| … up to 10] [| secs]',
          'error',
        )
        return true
      }
      const { id: channelId, transient } = await resolveTwitchChannelIdEx(login)
      if (!channelId) {
        showToast(
          transient
            ? t('mc_input_twitch_unreachable') || 'twitch unreachable — try again'
            : t('mc_input_pp_no_channel') || 'could not resolve channel',
          'error',
        )
        return true
      }
      const r = isPoll
        ? await createTwitchPoll(channelId, title, secs, items)
        : await createPrediction(channelId, title, secs, items)
      if (r?.ok) {
        showToast(
          isPoll
            ? t('mc_input_poll_created') || 'poll created'
            : t('mc_input_prediction_created') || 'prediction started',
          'success',
        )
        clearInput(input)
      } else {
        // Don't append "(broadcaster only)" unconditionally — it turned an
        // extension-side block ("mutation not allowed", the op missing from the
        // MAIN-world allowlist) into what read as a permissions problem, and
        // sent the user looking at their own twitch role instead of the bug.
        // Only say it when twitch actually refused on authorization.
        const _ppErr = String(r?.error || 'unknown')
        const _ppDenied = /forbidden|unauthorized|permission|not.?allowed.*channel|broadcaster/i.test(_ppErr)
        showToast(
          `${isPoll ? 'poll' : 'prediction'} failed: ${_ppErr}${_ppDenied ? ' (broadcaster only)' : ''}`,
          'error',
        )
      }
      return true
    }

    if (cmd === 'endpoll') {
      const login = _ppGate()
      if (!login) return true
      const poll = await _ppActivePoll(login)
      if (!poll) {
        showToast(t('mc_input_no_active_poll') || 'no active poll', 'error')
        return true
      }
      const r = await endTwitchPoll(poll.id)
      showToast(
        r?.ok
          ? t('mc_input_poll_ended') || 'poll ended'
          : `end poll failed: ${r?.error || 'unknown'} (broadcaster only)`,
        r?.ok ? 'success' : 'error',
      )
      if (r?.ok) clearInput(input)
      return true
    }

    if (cmd === 'vote') {
      const login = _ppGate()
      if (!login) return true
      const poll = await _ppActivePoll(login)
      if (!poll) {
        showToast(t('mc_input_no_active_poll') || 'no active poll', 'error')
        return true
      }
      const n = parseInt(rest.trim(), 10)
      if (!Number.isInteger(n) || n < 1 || n > poll.choices.length) {
        const opts = poll.choices.map((c, i) => `${i + 1}=${c.title}`).join('  ')
        showToast(`${t('mc_input_usage_vote') || '/vote <n>'} · ${opts}`, 'error')
        return true
      }
      const choice = poll.choices[n - 1]
      const r = await votePoll(poll.id, choice.id)
      showToast(
        r?.ok
          ? t('mc_input_voted', [choice.title]) || `voted: ${choice.title}`
          : `vote failed: ${r?.error || 'unknown'}`,
        r?.ok ? 'success' : 'error',
      )
      if (r?.ok) clearInput(input)
      return true
    }

    if (cmd === 'bet') {
      const login = _ppGate()
      if (!login) return true
      const pred = await _ppActivePred(login)
      if (!pred) {
        showToast(t('mc_input_no_active_pred') || 'no active prediction', 'error')
        return true
      }
      const m = rest.trim().match(/^(\d+)\s+(\d+)$/)
      const n = m ? parseInt(m[1], 10) : NaN
      const points = m ? parseInt(m[2], 10) : NaN
      if (!Number.isInteger(n) || n < 1 || n > pred.outcomes.length || !Number.isInteger(points) || points < 1) {
        const opts = pred.outcomes.map((o, i) => `${i + 1}=${o.title}`).join('  ')
        showToast(`${t('mc_input_usage_bet') || '/bet <n> <points>'} · ${opts}`, 'error')
        return true
      }
      const outcome = pred.outcomes[n - 1]
      const r = await placePredictionBet(pred.id, outcome.id, points)
      showToast(
        r?.ok
          ? t('mc_input_bet_placed', [String(points), outcome.title]) || `bet ${points} on ${outcome.title}`
          : `bet failed: ${r?.error || 'unknown'}`,
        r?.ok ? 'success' : 'error',
      )
      if (r?.ok) clearInput(input)
      return true
    }

    if (cmd === 'lockpred' || cmd === 'cancelpred' || cmd === 'resolvepred') {
      const login = _ppGate()
      if (!login) return true
      const pred = await _ppActivePred(login)
      if (!pred) {
        showToast(t('mc_input_no_active_pred') || 'no active prediction', 'error')
        return true
      }
      let r
      let okMsg
      if (cmd === 'lockpred') {
        r = await lockPrediction(pred.id)
        okMsg = t('mc_input_pred_locked') || 'prediction locked'
      } else if (cmd === 'cancelpred') {
        r = await cancelPrediction(pred.id)
        okMsg = t('mc_input_pred_canceled') || 'prediction canceled'
      } else {
        const n = parseInt(rest.trim(), 10)
        if (!Number.isInteger(n) || n < 1 || n > pred.outcomes.length) {
          const opts = pred.outcomes.map((o, i) => `${i + 1}=${o.title}`).join('  ')
          showToast(`${t('mc_input_usage_resolvepred') || '/resolvepred <n>'} · ${opts}`, 'error')
          return true
        }
        const outcome = pred.outcomes[n - 1]
        r = await resolvePrediction(pred.id, outcome.id)
        okMsg = t('mc_input_pred_resolved', [outcome.title]) || `resolved: ${outcome.title}`
      }
      showToast(r?.ok ? okMsg : `failed: ${r?.error || 'unknown'} (broadcaster only)`, r?.ok ? 'success' : 'error')
      if (r?.ok) clearInput(input)
      return true
    }
  }

  // ── user notes + block ──────────────────────────────────────────────────
  // Local, no rights. Notes are alias-canonical across linked accounts, keyed
  // on the current host platform. /block toggles (account-level for registered
  // users, local hide otherwise) and the underlying flow shows its own toast.
  if (cmd === 'note' || cmd === 'delnote') {
    const m = rest.match(/^@?(\S+)(?:\s+([\s\S]+))?$/)
    const user = m?.[1]
    if (!user) {
      showToast(
        cmd === 'note'
          ? t('mc_input_usage_note') || '/note <user> <text>'
          : t('mc_input_usage_delnote') || '/delnote <user>',
        'error',
      )
      return true
    }
    const plat = hostPlatform || 'twitch'
    if (cmd === 'delnote') {
      const ok = await hsNoteDelete(user, plat)
      showToast(
        ok
          ? t('mc_input_note_deleted', [user]) || `note removed for ${user}`
          : t('mc_input_note_none', [user]) || `no note for ${user}`,
        ok ? 'success' : 'error',
      )
      if (ok) clearInput(input)
      return true
    }
    const noteText = (m?.[2] || '').trim()
    if (!noteText) {
      showToast(t('mc_input_usage_note') || '/note <user> <text>', 'error')
      return true
    }
    const rec = await hsNoteSave(user, plat, noteText)
    showToast(
      rec
        ? t('mc_input_note_saved', [user]) || `note saved for ${user}`
        : t('mc_input_note_failed') || 'could not save note',
      rec ? 'success' : 'error',
    )
    if (rec) clearInput(input)
    return true
  }

  if (cmd === 'block') {
    const user = rest.trim().replace(/^@/, '')
    if (!user || /\s/.test(user)) {
      showToast(t('mc_input_usage_block') || '/block <user> — toggles block', 'error')
      return true
    }
    // hsBlockFromMenu resolves the identity and toggles; pcToggleBlock /
    // _toggleMcBlock inside it show their own success/error toast, so don't add
    // a second one here.
    await hsBlockFromMenu(user, hostPlatform || 'twitch')
    clearInput(input)
    return true
  }

  // ── /hide, /unhide — per-tab, ephemeral (see _tabHide) ──────────────────
  if (cmd === 'hide' || cmd === 'unhide') {
    const user = rest.trim().replace(/^@/, '')
    if (!user || /\s/.test(user)) {
      showToast(`/${cmd} <user> — ${cmd === 'hide' ? 'hides' : 'unhides'} in this tab`, 'error')
      return true
    }
    await _tabHide(user, hostPlatform || 'twitch', cmd)
    clearInput(input)
    return true
  }

  // ── /set — change any registry setting from the composer ────────────────
  // setSetting owns coercion + validation (returns false on unknown key or bad
  // value — never corrupts the sync blob), so this is just key/alias resolution
  // plus the one gap a raw string can't cross: bool, where coerceSettingValue
  // does !!v and "off" would read as true.
  if (cmd === 'set') {
    const m = rest.match(/^(\S+)\s+([\s\S]+)$/)
    if (!m) {
      showToast(t('mc_input_usage_set') || '/set <setting> <value>', 'error')
      return true
    }
    const rawKey = m[1]
    const lk = rawKey.toLowerCase()
    const def =
      typeof SETTINGS !== 'undefined' ? SETTINGS.find((d) => d.key.toLowerCase() === lk || d.alias === lk) : null
    if (!def) {
      showToast(t('mc_input_set_unknown', [rawKey]) || `unknown setting: ${rawKey}`, 'error')
      return true
    }
    if (def.type === 'multiselect' || def.type === 'boolmap' || def.type === 'json') {
      showToast(t('mc_input_set_complex') || 'change that one in the settings panel', 'error')
      return true
    }
    let val = m[2].trim()
    if (def.type === 'bool') {
      const on = /^(on|true|1|yes|enabled?|show)$/i.test(val)
      const off = /^(off|false|0|no|disabled?|hide)$/i.test(val)
      if (!on && !off) {
        showToast(t('mc_input_set_bool', [def.key]) || `use on/off for ${def.key}`, 'error')
        return true
      }
      val = on
    }
    const ok = typeof setSetting === 'function' && setSetting(def.key, val)
    if (ok) {
      showToast(t('mc_input_set_done', [def.key, String(val)]) || `${def.key} = ${val}`, 'success')
      clearInput(input)
    } else {
      let hint = ''
      if (def.type === 'enum' && Array.isArray(def.options)) hint = ` · ${def.options.map((o) => o.value).join('/')}`
      else if (def.type === 'range' && def.options) hint = ` · ${def.options.min}-${def.options.max}`
      showToast(`${t('mc_input_set_invalid', [def.key]) || `invalid value for ${def.key}`}${hint}`, 'error')
    }
    return true
  }

  // ── /tab — switch tab from the composer ─────────────────────────────────
  // Only ever switches to a real special tab or a configured channel (matched
  // by id or any platform login), never a bare switchTab(id) that could blank
  // the view on an unknown id.
  if (cmd === 'tab') {
    const q = rest.trim().toLowerCase().replace(/^#/, '')
    if (!q) {
      showToast(t('mc_input_usage_tab') || '/tab <live|feed|mentions|whispers|settings|channel>', 'error')
      return true
    }
    const SPECIAL = ['live', 'feed', 'mentions', 'whispers', 'discover', 'pinned', 'modlog', 'add', 'settings']
    let target = null
    if (SPECIAL.includes(q)) {
      target = q
    } else if (typeof config !== 'undefined' && config.channels) {
      const ch = config.channels.find(
        (c) =>
          c.id === q || c.twitch?.toLowerCase() === q || c.kick?.toLowerCase() === q || c.youtube?.toLowerCase() === q,
      )
      if (ch) target = ch.id
    }
    if (!target) {
      showToast(t('mc_input_tab_unknown', [q]) || `no tab: ${q}`, 'error')
      return true
    }
    if (typeof switchTab !== 'function') {
      showToast(t('mc_input_tab_unavailable') || 'tabs unavailable', 'error')
      return true
    }
    switchTab(target)
    clearInput(input)
    return true
  }

  // ── /vip /unvip /mod /unmod (twitch broadcaster) ────────────────────────
  // Op names + input shapes captured live from twitch's Roles Manager. Ride the
  // proven mod-action path (Apollo+integrity → persisted-hash fallback).
  if (cmd === 'vip' || cmd === 'unvip' || cmd === 'mod' || cmd === 'unmod') {
    const add = cmd === 'vip' || cmd === 'mod'
    const isVip = cmd === 'vip' || cmd === 'unvip'
    const user = rest.trim().replace(/^@/, '').toLowerCase()
    if (!user || /\s/.test(user)) {
      const usageKey = isVip
        ? add
          ? 'mc_input_usage_vip'
          : 'mc_input_usage_unvip'
        : add
          ? 'mc_input_usage_mod'
          : 'mc_input_usage_unmod'
      showToast(t(usageKey) || `/${cmd} <user>`, 'error')
      return true
    }
    let twitchLogin = _modCh?.twitch || null
    if (!twitchLogin && currentTab === 'live' && typeof getLiveChannel === 'function') twitchLogin = getLiveChannel()
    if (!twitchLogin && modChannel && modChannel !== 'live' && !_modCh) twitchLogin = modChannel
    if (!twitchLogin) {
      showToast(t('mc_input_pp_needs_twitch') || 'this needs a twitch channel tab', 'error')
      return true
    }
    if (!getTwitchAuthToken()) {
      showToast(t('mc_input_pp_login') || 'log into twitch.tv first', 'error')
      return true
    }
    const { id: channelId, transient } = await resolveTwitchChannelIdEx(twitchLogin)
    if (!channelId) {
      showToast(
        transient
          ? t('mc_input_twitch_unreachable') || 'twitch unreachable — try again'
          : t('mc_input_pp_no_channel') || 'could not resolve channel',
        'error',
      )
      return true
    }
    const r = isVip ? await vipTwitchUser(channelId, user, add) : await modTwitchUser(channelId, user, add)
    if (r?.ok) {
      const doneKey = isVip
        ? add
          ? 'mc_input_vip_done'
          : 'mc_input_unvip_done'
        : add
          ? 'mc_input_mod_done'
          : 'mc_input_unmod_done'
      showToast(t(doneKey, [user]) || `${cmd}: ${user}`, 'success')
      clearInput(input)
    } else {
      showToast(`${cmd} failed: ${r?.error || 'unknown'} (broadcaster only)`, 'error')
    }
    return true
  }

  if (
    cmd === 'announce' ||
    cmd === 'announceblue' ||
    cmd === 'announcegreen' ||
    cmd === 'announceorange' ||
    cmd === 'announcepurple'
  ) {
    if (!modChannel) {
      showToast(t('mc_input_mod_needs_channel_tab', [cmd]) || `/${cmd} needs a channel tab`, 'error')
      return true
    }
    if (!_twitchModName) {
      showToast(t('mc_input_announce_twitch_only') || '/announce is twitch-only', 'error')
      return true
    }
    if (!(await _twitchModAuthOk())) return true
    const message = rest.trim()
    if (!message) {
      showToast(t('mc_input_usage_announce') || '/announce <message>', 'error')
      return true
    }
    const color = cmd === 'announce' ? 'PRIMARY' : cmd.slice('announce'.length).toUpperCase()
    const r = await announceTwitchChat(_twitchModName, message, color)
    if (r?.ok) {
      clearInput(input)
    } else {
      showToast(`announce failed: ${r?.error || 'unknown error'}`, 'error')
    }
    return true
  }

  if (cmd === 'delete') {
    if (!modChannel) {
      showToast(t('mc_input_delete_needs_channel_tab'), 'error')
      return true
    }
    const messageID = rest.trim()
    if (!messageID) {
      showToast(t('mc_input_usage_delete'), 'error')
      return true
    }
    if (!_twitchModName && !_kickModSlug) {
      showToast(t('mc_input_delete_needs_platform_channel'), 'error')
      return true
    }
    if (!(await _twitchModAuthOk())) return true
    // Raw id → platform unknown; dispatcher tries Twitch first, then Kick.
    const r = await dispatchModAction({ channel: modChannel, action: 'delete', msgId: messageID })
    const err = (r?.tResp || r?.kResp)?.error || t('mc_common_unknown')
    showToast(r?.anyOk ? t('mc_mod_label_deleted') : t('mc_input_delete_failed', [err]), r?.anyOk ? 'success' : 'error')
    if (r?.anyOk) clearInput(input)
    return true
  }

  // /nuke <term> [seconds] — bulk-delete recent messages whose text contains
  // <term> (case-insensitive substring; NOT regex, so no ReDoS surface) within
  // the last [seconds] (default 30, capped). Reads the local buffers and issues
  // one delete per match via the same single-delete path /delete uses. Guarded:
  // min 2-char term, hard match cap, and a confirm modal before anything fires.
  if (cmd === 'nuke') {
    if (!modChannel) {
      showToast(t('mc_input_nuke_needs_channel_tab'), 'error')
      return true
    }
    if (!_twitchModName && !_kickModSlug) {
      showToast(t('mc_input_nuke_needs_platform_channel'), 'error')
      return true
    }
    if (!(await _twitchModAuthOk())) return true
    const NUKE_MAX = 100 // never delete more than this in one invocation
    const NUKE_MAX_WINDOW = 300 // seconds — furthest lookback allowed
    const nm = rest.trim().match(/^(.+?)(?:\s+(\d+))?$/)
    const term = nm ? nm[1].trim() : ''
    if (term.length < 2) {
      showToast(t('mc_input_usage_nuke'), 'error')
      return true
    }
    const windowSec = Math.min(NUKE_MAX_WINDOW, nm?.[2] ? Math.max(1, parseInt(nm[2], 10)) : 30)
    const since = Date.now() - windowSec * 1000
    const needle = term.toLowerCase()
    // Collect deletable matches from both platform buffers, newest dropped first
    // if over the cap (keep the oldest so a raid's leading edge is cleared).
    const seenIds = new Set()
    const targets = []
    // Buffers are keyed by twitch login / kick slug, NOT the tab id — a
    // dual-linked tab (kick slug != twitch login) or an ephemeral auto_ tab
    // matched nothing. Use the resolved channel names, same as /ban dispatch.
    const _tw = irc?.channels?.get((_twitchModName || modChannel).toLowerCase())
    const _kk = kickChat?.channels?.get((_kickModSlug || modChannel).toLowerCase())
    for (const buf of [_tw, _kk]) {
      if (!buf?.getAll) continue
      for (const m of buf.getAll()) {
        if (!m?.id || typeof m.text !== 'string') continue
        if ((m.time || 0) < since) continue
        if (!m.text.toLowerCase().includes(needle)) continue
        if (seenIds.has(m.id)) continue
        seenIds.add(m.id)
        targets.push({ msgId: m.id, platform: m.platform })
      }
    }
    if (targets.length === 0) {
      showToast(t('mc_input_nuke_no_matches', [term, String(windowSec)]), 'error')
      return true
    }
    const capped = targets.length > NUKE_MAX
    const batch = capped ? targets.slice(0, NUKE_MAX) : targets
    const { ok } = await hsConfirm(
      `nuke ${batch.length}${capped ? `+ (capped from ${targets.length})` : ''} message${batch.length === 1 ? '' : 's'} matching "${term}" in #${modChannel}?`,
      'nuke',
    )
    if (!ok) return true
    const results = await Promise.allSettled(
      batch.map((t) =>
        dispatchModAction({ channel: modChannel, platform: t.platform, action: 'delete', msgId: t.msgId }),
      ),
    )
    const okCount = results.filter((r) => r.status === 'fulfilled' && r.value?.anyOk).length
    showToast(t('mc_input_nuke_done', [String(okCount), String(batch.length), term]), okCount ? 'success' : 'error')
    if (okCount) clearInput(input)
    return true
  }

  // ─── Chat modes (mod) ─── followers/slow/emoteonly/subscribers/unique.
  // Twitch via Helix /chat/settings (setTwitchChatMode). `/<mode> off` disables;
  // duration modes take an optional arg (/followers 30, /slow 10). Kick writes
  // via setKickChatMode (PUT /chatrooms/<id>), read-back verified below.
  if (CHAT_MODES[cmd]) {
    // All five modes now go through the one GQL mutation twitch actually has
    // (updateChatSettings) and are verified by reading the mode back — see
    // setTwitchChatMode. Kick rides its own PUT (no unique-chat there, and kick
    // ignores an exact slow interval) — see setKickChatMode.
    // Target the twitch channel you're moderating: a real channel tab's twitch
    // login, else the twitch channel you're currently viewing (so it works from
    // the live/aggregate tab too, where currentTab='live' is not a channel).
    const twitchTarget =
      _modCh?.twitch || (hostPlatform === 'twitch' ? (getCurrentChannel() || '').toLowerCase().replace(/^#/, '') : null)
    const _kickSide = _modCh?.kick || (hostPlatform === 'kick' ? (getCurrentChannel() || '').toLowerCase() : null)
    if (!twitchTarget && !_kickSide) {
      showToast(t('mc_input_followers_twitch_only'), 'error')
      return true
    }
    if (!twitchTarget && _kickSide && !KICK_MODE_CMDS.has(cmd)) {
      // kick has no unique-chat equivalent — say so instead of silently no-oping
      showToast(t('mc_input_mode_kick_unsupported', [cmd]), 'error')
      return true
    }
    const spec = CHAT_MODES[cmd]
    const arg = rest.trim().toLowerCase()
    const off = arg === 'off'
    // Duration modes carry a number; the boolean modes are a plain on/off.
    // followers encodes off as -1 (0 means "any follower, no age gate"), slow
    // encodes off as 0 — both read back as null, which the verifier accepts.
    let value
    if (!spec.dur) {
      value = !off
    } else if (off) {
      value = cmd === 'followers' ? -1 : 0
    } else if (!arg) {
      value = cmd === 'followers' ? 0 : spec.unit === 'sec' ? 30 : 0
    } else {
      value = _parseModeDuration(arg, spec.unit)
      if (value == null) {
        showToast(t('mc_input_usage_mode', [cmd]), 'error')
        return true
      }
    }
    // Kick leg: same command, kick's own PUT, when the tab has a kick side and
    // kick actually has that mode (no unique-chat on kick).
    const kickTarget = _modCh?.kick || (hostPlatform === 'kick' ? (getCurrentChannel() || '').toLowerCase() : null)
    const kickPromise =
      kickTarget && typeof setKickChatMode === 'function' && KICK_MODE_CMDS.has(cmd)
        ? setKickChatMode(kickTarget, cmd, value)
        : Promise.resolve(null)
    const [resp, kickResp] = await Promise.all([
      twitchTarget ? setTwitchChatMode(twitchTarget, cmd, value) : Promise.resolve(null),
      kickPromise,
    ])
    // Twitch can't do the boolean modes (see TWITCH_CHAT_MODE_SPEC). If kick
    // handled it, that's a real success — don't surface twitch's refusal.
    if (resp?.unsupported && kickResp?.ok) {
      showToast(off ? t('mc_input_mode_off', [spec.label]) : t('mc_input_mode_on', [spec.label]), 'success')
      clearInput(input)
      return true
    }
    if (resp?.unsupported && !kickResp?.ok) {
      showToast(t('mc_input_mode_twitch_unsupported', [cmd]), 'error')
      return true
    }
    if (kickResp && !kickResp.ok && !resp?.ok) {
      showToast(t('mc_input_mode_failed', [spec.label, kickResp.error]), 'error')
      return true
    }
    if (!resp && kickResp?.ok) {
      showToast(off ? t('mc_input_mode_off', [spec.label]) : t('mc_input_mode_on', [spec.label]), 'success')
      clearInput(input)
      return true
    }
    if (resp?.ok) {
      const label = spec.label
      showToast(
        off
          ? t('mc_input_mode_off', [label])
          : spec.dur && value
            ? t('mc_input_mode_on_dur', [label, String(value) + (spec.unit === 'sec' ? 's' : 'm')])
            : t('mc_input_mode_on', [label]),
        'success',
      )
      clearInput(input)
    } else {
      showToast(t('mc_input_mode_failed', [spec.label, resp.error]), 'error')
    }
    return true
  }

  // Twitch deprecated chat commands over IRC in Feb 2023 (same deprecation
  // that broke /ban /timeout /unban /delete — those got real GQL handlers, the
  // rest of the list never did). With no handler they fall through to a plain
  // send, so the broadcaster's own moderation command goes out over the wire
  // as message text. Refuse loudly instead. Twitch only: kick is a different
  // chat server and nothing here proves its commands are dead too, so a
  // kick-side tab keeps its existing passthrough.
  if (DEAD_TWITCH_CHAT_COMMANDS.has(cmd) && (_modCh?.twitch || (!_modCh && hostPlatform === 'twitch'))) {
    showToast(t('mc_input_cmd_twitch_removed', [cmd]) || `twitch removed /${cmd} from chat`, 'error')
    return true
  }

  return false
}

const SLASH_HELP_LINES = [
  '/op <text>             — post to home',
  '/opr <text>            — reply to last [OP] in chat',
  '/w <user> <msg>        — twitch whisper',
  '/dm <user> <msg>       — heatsync DM',
  '/r <msg>               — reply to last whisper',
  '/mute <user>           — local mute (24h)',
  '/unmute <user>         — local unmute',
  '/shrug [text]          — append ¯\\_(ツ)_/¯',
  '/tableflip [text]      — append (╯°□°)╯︵ ┻━┻',
  '/unflip [text]         — append ┬─┬ノ( ゜-゜ノ)',
  '/lclear                — clear current tab locally',
  '/status [channel]      — show chat modes + stream info',
  '/help                  — this list',
  '',
  'mod (need a channel tab — fires both twitch+kick if linked):',
  '/ban <user> [reason]   — perma ban',
  '/timeout <user> [s] [r]— timeout, default 600s',
  '/unban <user>          — unban or end timeout',
  '/delete <msg-id>       — delete one message',
  '/nuke <term> [secs]    — delete recent msgs matching term (default 30s)',
  '/vip <user>            — VIP a user (twitch broadcaster)',
  '/unvip <user>          — remove a user VIP (twitch broadcaster)',
  '/mod <user>            — mod a user (twitch broadcaster)',
  '/unmod <user>          — unmod a user (twitch broadcaster)',
  '',
  'chat modes (twitch, mod):',
  '/followers [mins]      — followers-only ("/followers off")',
  '/slow [secs]           — slow mode, default 30s ("/slow off")',
  '/emoteonly             — emote-only ("/emoteonly off")',
  '/subscribers           — subs-only ("/subscribers off")',
  '/unique                — unique-chat/r9k ("/unique off")',
  '',
  '/announce <msg>        — announcement (blue/green/orange/purple variants)',
  '/highlight <msg>       — highlight your message (twitch bits power-up, /hl)',
  '/testnotices           — render every event type locally (dev)',
  '',
  '/me and chat pass through to twitch & kick.',
  '/clear /color /raid /commercial /marker not wired —',
  'twitch dropped them from chat. use its own mod tools.',
]

function showSlashHelp() {
  // Reuse toast for short feedback — but the help list is multi-line, so build a
  // lightweight inline overlay instead.
  let panel = document.getElementById('hs-mc-slash-help')
  if (panel) {
    panel.remove()
    return
  }
  panel = document.createElement('div')
  panel.id = 'hs-mc-slash-help'
  panel.style.cssText =
    "position:fixed;bottom:60px;right:20px;z-index:99999;background:#000;border:2px solid #fff;padding:10px 14px;font:13px/1.4 'CozetteVector','Courier New',monospace;color:#fff;white-space:pre;max-width:420px;box-shadow:0 0 12px rgba(255,255,255,0.3)"
  panel.textContent = SLASH_HELP_LINES.join('\n')
  panel.addEventListener('click', () => panel.remove())
  document.body.appendChild(panel)
  setTimeout(() => panel?.remove(), 12000)
}

// Mounts the status panel built by buildChatStatusPanel into a fixed
// overlay anchored bottom-right (matches /help). Click panel or wait 20s
// to dismiss. Re-invoking /status replaces the existing panel.
async function showChatStatusPanel(channel) {
  document.getElementById('hs-mc-status-overlay')?.remove()
  const wrap = document.createElement('div')
  wrap.id = 'hs-mc-status-overlay'
  wrap.className = 'hs-mc-status-overlay'
  const loading = document.createElement('div')
  loading.className = 'hs-mc-status-loading'
  loading.textContent = `fetching #${channel}…`
  wrap.appendChild(loading)
  wrap.addEventListener('click', () => wrap.remove())
  document.body.appendChild(wrap)
  let panel
  try {
    panel = await buildChatStatusPanel(channel)
  } catch (_) {
    panel = null
  }
  if (!document.body.contains(wrap)) return
  if (!panel) {
    loading.textContent = `could not fetch #${channel} (offline or not on twitch?)`
    setTimeout(() => wrap?.remove(), 5000)
    return
  }
  loading.remove()
  wrap.appendChild(panel)
  setTimeout(() => wrap?.remove(), 20000)
}

// Resolve a username → whisper key, registering the user in whisperUsers so the
// timeline/placeholder can name+paint them. Returns the key, or null after
// surfacing the right error toast. Shared by the send (/w /dm) and open paths.
async function resolveWhisperTarget(platform, username) {
  const lowerUser = username.toLowerCase()
  if (platform === 'twitch') {
    const key = `twitch:${lowerUser}`
    if (!whisperUsers.has(key)) {
      // Canonical first-party resolver (Twitch GQL; heatsync.org/api/resolve as
      // its own internal last-resort fallback).
      let body
      try {
        body = await resolveTwitchChannelId(lowerUser)
      } catch (_) {
        showToast(t('mc_whisper_resolve_failed'), 'error')
        return null
      }
      if (!body) {
        showToast(t('mc_whisper_user_not_found', [username]), 'error')
        return null
      }
      whisperUsersSet(key, { platform: 'twitch', userId: body, displayName: username, color: '#fff' })
    }
    return key
  }
  // HeatSync DM — resolve username → user id via profile API. The endpoint
  // returns profile.id (+ display_name/color); the old checks read
  // profile.user_id / user_color, which don't exist, so resolve ALWAYS failed
  // and every /dm silently no-op'd. Read the real field names.
  const profileResp = await apiFetch(`/api/profile/${encodeURIComponent(lowerUser)}`)
  // A failed REQUEST is NOT "this user doesn't exist". apiFetch returns
  // {ok:false, error:'context invalidated'} while the service worker restarts —
  // exactly what happens for a few seconds after an extension reload — and the
  // old guard reported that as "heatsync user X not found", which sent us
  // chasing a phantom resolve bug. Only a real 404 (or a 200 carrying no id)
  // means the user is actually missing; anything else is a transient failure.
  if (!profileResp?.ok && profileResp?.status !== 404) {
    showToast(t('mc_whisper_hs_unreachable'), 'error')
    return null
  }
  const prof = profileResp?.data?.profile
  if (!prof?.id) {
    showToast(t('mc_whisper_hs_not_found', [username]), 'error')
    return null
  }
  const userId = String(prof.id)
  const key = `hs:${userId}`
  whisperUsersSet(key, {
    platform: 'heatsync',
    userId,
    displayName: prof.display_name || username,
    color: prof.color || '#fff',
  })
  return key
}

async function sendSlashWhisper(platform, username, text, input) {
  const key = await resolveWhisperTarget(platform, username)
  if (!key) return
  // Containment: a quick /w or /dm from a channel must NOT yank the view to the
  // whispers tab. Send in place, toast to confirm, keep the composer focused for
  // rapid-fire. Only on failure surface the whispers tab, where the failed
  // message shows with its retry.
  const ok = await sendWhisperMessage(key, text)
  clearInput(input)
  if (ok) showToast(t('mc_whisper_sent', [username]), 'success')
  else if (currentTab !== 'whispers') switchTab('whispers')
  armComposerStickyFocus(input)
}

// Bare "/w <user>" / "/dm <user>" with no message: resolve + open that
// conversation in the whispers tab and point /r at it, instead of silently
// flashing a usage hint (the "nothing happened" trap). The placeholder then
// reads "/r to reply to <user>", so the next step is obvious.
async function openWhisperConversation(platform, username, input) {
  const key = await resolveWhisperTarget(platform, username)
  if (!key) return
  lastWhisperKey = key
  clearInput(input)
  if (currentTab !== 'whispers') switchTab('whispers')
  updateInputPlaceholder()
  try {
    input?.focus()
  } catch (_) {}
  armComposerStickyFocus(input)
}

// Auto-add to the viewer's set any remote-searched (7TV/BTTV/FFZ) emote that's in
// the outgoing message but not yet owned — so an emote you Tab-searched and sent
// becomes yours and renders next time, instead of going out as bare text. Only
// names tracked in recentRemoteCompletions qualify, so channel/global/owned
// emotes (which already render) never burn slots. Fire-and-forget.
function autoAddInputEmotes(text) {
  if (!text || !recentRemoteCompletions.size) return
  const seen = new Set()
  for (const word of text.split(/\s+/)) {
    if (!word || seen.has(word)) continue
    seen.add(word)
    const rec = recentRemoteCompletions.get(word)
    if (!rec) continue
    if (typeof blockedEmoteNames !== 'undefined' && blockedEmoteNames.has(word)) continue
    if (typeof inventoryEmotes !== 'undefined' && inventoryEmotes.has(word)) continue
    if (pendingEmoteOps?.has(word)) continue
    // Skip heatsync curated globals — server rejects with "global emotes cannot
    // be added to personal inventory" and they already render for everyone, so
    // the POST is wasted and the failure toast misleads ("failed to add Wave"
    // when in fact Wave was never meant to be added).
    if (typeof emoteCache !== 'undefined') {
      const cached = emoteCache.get(word)
      if (cached?.state === 'global') continue
    }
    // Optimistically register locally so the own-message echo (arrives in ~ms,
    // before the server add resolves) renders the emote image instead of raw
    // text — text has no wrapper, so a late add can't retro-fix it. Mirrors the
    // picker's optimistic add (emotes.js). addEmoteToInventory then persists it.
    if (typeof viewerPersonalEmotes !== 'undefined' && !viewerPersonalEmotes.has(word)) {
      viewerPersonalEmotes.set(word, {
        url: rec.url,
        source: rec.source,
        state: 'owned',
        zeroWidth: !!rec.zeroWidth,
        addedAt: Date.now(),
      })
    }
    if (typeof addEmoteToInventory === 'function') {
      // Roll back the optimistic own-set entry if the server add fails (offline,
      // logged out, 4xx). Without this, a never-owned emote stays phantom-"owned"
      // for the whole tab session — picker, tab-complete and the own-echo all
      // resolve it via viewerPersonalEmotes first, and nothing ever clears it
      // because a FAILED add never writes emote_inventory to fire the reload.
      // Mirrors the picker click handler's _rollback (emotes.js).
      const _rollbackWord = word
      const _rollback = () => {
        if (
          typeof viewerPersonalEmotes !== 'undefined' &&
          typeof inventoryEmotes !== 'undefined' &&
          !inventoryEmotes.has(_rollbackWord)
        ) {
          viewerPersonalEmotes.delete(_rollbackWord)
        }
      }
      Promise.resolve(addEmoteToInventory(word, rec.url, rec.source, undefined, !!rec.zeroWidth, /* silent */ true))
        .then((ok) => {
          if (!ok) _rollback()
        })
        .catch(_rollback)
    }
  }
}

// Sticky-focus window after a send (ms). Inside it the composer reasserts focus
// on any blur — covering late own-echo render churn AND host-page focus grabs so
// rapid-fire chat never loses the cursor. Refreshed on every send.
const COMPOSER_STICKY_MS = 1000
let _composerStickyUntil = 0
// Reclaim composer focus, UNLESS the user deliberately moved to another of OUR
// editable fields (message search, settings) or opened the emote picker, or the
// bar was auto-hidden. Our fields live under an #hs-mc-* container; host-page
// inputs don't — so focus stolen by the host page IS reclaimed.
function reassertComposerFocus() {
  const live = document.getElementById('hs-mc-input')
  if (!live || document.activeElement === live) return
  if (document.getElementById('hs-mc-inputbar')?.classList.contains('hs-hidden')) return
  if (document.getElementById('hs-mc-emote-picker')?.classList.contains('visible')) return
  const ae = document.activeElement
  if (
    ae &&
    ae !== live &&
    (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) &&
    ae.closest('[id^="hs-mc-"]')
  )
    return
  live.focus()
}

// Lock the composer to the cursor for the rapid-fire window after a send:
// suppresses the empty-bar auto-hide and reasserts focus across any blur latency
// (network echo, own-echo DOM rebuild). Shared by the normal-send tail and the
// slash-whisper/reply paths so a /w or /r never drops the cursor.
function armComposerStickyFocus(input) {
  if (!input) return
  _composerStickyUntil = performance.now() + COMPOSER_STICKY_MS
  keepComposerOpen(COMPOSER_STICKY_MS)
  input.focus()
  queueMicrotask(reassertComposerFocus)
  requestAnimationFrame(reassertComposerFocus)
  cleanup.setTimeout(reassertComposerFocus, 120)
}

// Post-send composer settle — the ONE tail every send path ends with.
// Auto-hide users mean "done" by Enter: hide the bar NOW. Routing the hide
// through the sticky window deferred it ~1s behind the retry timer — a visible
// lag on every send. Rapid-fire survives the hide: the type-to-reveal handler
// reveals on the next printable key and types it. When a guard keeps the bar
// up anyway (picker open, unconfirmed send left text in place), or auto-hide
// is off, fall through to the sticky-focus window so the visible composer
// never drops the cursor.
function settleComposerAfterSend(input) {
  if (autoHideEligible()) {
    _keepComposerOpenUntil = 0
    _composerStickyUntil = 0
    hideInputBar()
    if (!syncInputBarVisible()) return
  }
  armComposerStickyFocus(input)
}

async function sendMessage() {
  const input = document.getElementById('hs-mc-input')
  if (!input) return

  let text = convertEmojiShortcodes(getInputText().trim())
  if (!text) return

  // Remote-searched emotes in the outgoing message get added to the set on send.
  autoAddInputEmotes(text)

  // Resub-share mode — typed text becomes the celebration BODY via Twitch's
  // Chat_ShareResub_UseResubToken GQL mutation. consume() fires that mutation
  // and injects a local synthetic for instant visual feedback. Returns true
  // when the text was consumed AS the celebration body (don't send again as
  // plain PRIVMSG — would duplicate); returns false in the no-token fallback
  // path so the typed text still lands as a normal chat message.
  if (window.__hsResubShare?.active?.()) {
    try {
      if (window.__hsResubShare.consume(text) === true) {
        clearInput(document.getElementById('hs-mc-input'))
        return
      }
    } catch (_) {}
  }
  // Watch-streak share mode — same contract as resub-share. consume() fires
  // the native broadcast + injects a local synth, then we fall through so the
  // user's typed body also lands as a normal PRIVMSG (visible to everyone).
  if (window.__hsWatchstreakShare?.active?.()) {
    try {
      window.__hsWatchstreakShare.consume(text)
    } catch (_) {}
  }

  // Slash commands — work from any tab. Handler may return:
  //   true   -> consumed, exit
  //   string -> rewrite outgoing text and continue normal send
  //   else   -> not ours, pass raw text through to platform
  if (text.startsWith('/')) {
    // A throw inside any command handler must never silently swallow the send
    // (an unguarded ReferenceError once made /highlight fail with no toast, no
    // send). Surface it and stop — passing the raw "/cmd" through to the
    // platform as literal text would be worse.
    let result
    try {
      result = await handleSlashCommand(text, input)
    } catch (e) {
      console.error('[hs] slash command threw:', e?.message || e)
      showToast(
        t('mc_input_command_failed', [e?.message || 'error']) || `command failed: ${e?.message || 'error'}`,
        'error',
      )
      return
    }
    if (result === true) return
    if (typeof result === 'string') text = result
  }

  // Feed tab: plain text + media paste posts directly to home feed.
  // Slash commands are still respected (e.g. /op explicit, /w whisper).
  // Contextual, not topLevel: with a thread open, typing here replies to
  // that thread; only /op forces a top-level post from thread view.
  if (currentTab === 'feed') {
    await postFeedMessage(text)
    return
  }

  // Whispers/mentions: still require slash commands
  if (currentTab === 'whispers' || currentTab === 'mentions') {
    // Both refuse a plain send by design — whispers need /r to name a target,
    // mentions span channels so there's no single destination. The bare flash
    // never said which, so it read as "the send broke".
    flashInputError(input)
    showToast(currentTab === 'mentions' ? t('mc_input_mentions_readonly') : t('mc_whisper_hint'), 'error')
    return
  }

  // Nothing to send to from here (add/settings/discover/pinned/modlog, the
  // live tab off a channel page, or a stale id from a removed channel). The
  // composer isn't reachable on those tabs any more — but if one ever slips
  // through, say so instead of falling through to the resolver below, where
  // targetChannel defaulted to the TAB ID and addressed a channel named
  // "modlog". Text stays in the box.
  if (!tabAcceptsInput(currentTab)) {
    flashInputError(input)
    showToast(t('mc_input_no_channel'), 'error')
    return
  }

  // Determine target channel + platform
  let targetChannel
  let ch = null
  if (currentTab === 'live') {
    targetChannel = getLiveChannel()
    // Live tab itself isn't a config entry. Resolve the linked channel pair
    // by matching the live channel name to either twitch or kick slug so a
    // dual-link channel fans out to BOTH platforms on Live tab, not just the
    // host. Without this, sending from Live on twitch.tv to a twitch+kick
    // dual-link channel skipped Kick (kickSlug undefined → sendToKick=false).
    if (targetChannel) {
      const lower = targetChannel.toLowerCase()
      ch = config.channels.find((c) => c.twitch?.toLowerCase() === lower || c.kick?.toLowerCase() === lower) || null
    }
  } else {
    ch = config.channels.find((c) => c.id === currentTab)
    targetChannel = ch?.twitch || ch?.kick || currentTab
  }

  if (!targetChannel) {
    // A bare red flash doesn't say WHY — on a no-channel page (/directory,
    // /settings) there's simply nothing selected to send to. Say so, and keep
    // the text in the box so the user doesn't lose what they typed.
    flashInputError(input)
    showToast(t('mc_input_no_channel'), 'error')
    return
  }

  // Resolve platform targets. Anonymous-live (no ch match) falls back to the
  // host platform only. Configured channels (with ch) fan out to every linked
  // platform regardless of the host.
  const kickSlug = ch?.kick
  const twitchName = ch?.twitch
  const anonLive = currentTab === 'live' && !ch

  // Orphan slash command: starts with /word but nothing here consumed it
  // (handleSlashCommand returned false / explicit pass-through) and it isn't
  // /me. Twitch parses slash commands server-side so passing it through is
  // correct there, but Kick/YouTube sends are plain REST posts — "/announce
  // hi" would land as literal chat text. Gate those platforms off; /me is
  // exempt (each platform gets its wire form below).
  const orphanSlash = /^\/[a-zA-Z]/.test(text) && !/^\/me\b/i.test(text)

  const ytUrl = ch?.youtube
  const isLiveYt = currentTab === 'live' && hostPlatform === 'yt'

  // Per-channel sendTargets override (composer chips). Only applies to
  // configured channels — anonLive has no persisted config to read, so it
  // keeps the unconditional host-platform-only behavior above untouched.
  // Absent ch.sendTargets resolves every linked platform ON, so an
  // unconfigured channel fans out exactly as before this feature existed.
  const sendTargets = ch
    ? resolveSendTargets(ch.sendTargets, { twitch: !!twitchName, kick: !!kickSlug, youtube: !!ytUrl })
    : null

  const sendToKick =
    (!!kickSlug || (anonLive && hostPlatform === 'kick')) && !orphanSlash && (!sendTargets || sendTargets.kick)
  const sendToTwitch = (!!twitchName || (anonLive && hostPlatform === 'twitch')) && (!sendTargets || sendTargets.twitch)
  const ytWanted = (!!ytUrl || isLiveYt) && !orphanSlash && (!sendTargets || sendTargets.youtube)
  // Exact stream video id (or '' if not concretely known) — lets background
  // auto-open a login-inheriting live_chat bridge tab when no YT tab is open.
  const ytVideoId = ytWanted ? currentYoutubeVideoId(ytUrl) : ''
  // FORT KNOX: only actually fan out to YouTube when we can target the EXACT
  // stream — the Live tab (the sender page IS the stream you're on) or a
  // concrete videoId. A channel tab with a youtube link but no RESOLVED live id
  // must NOT send: background would fall back to the sender's own tab, which —
  // when you're parked on a DIFFERENT stream's watch page — posts into that
  // host page's chat (the "my message leaked into another tab's host chat"
  // bug). Drop the youtube leg entirely; twitch/kick still go through.
  const sendToYoutube = ytWanted && (isLiveYt || !!ytVideoId)
  const isDualSend = sendToKick && sendToTwitch

  // Orphan slash with no twitch leg = nothing left to send (kick/yt-only
  // target). Fail loud and keep the input so the text isn't lost.
  if (orphanSlash && !sendToTwitch) {
    showToast(t('mc_input_unknown_command'), 'error')
    flashInputError(input)
    return
  }

  // /me action — give each platform the right wire form for an action message.
  // Twitch IRC carries actions as a CTCP ACTION (\x01ACTION text\x01) — the same
  // primitive Twitch echoes back and irc.js already parses — so we send that
  // directly instead of relying on Twitch's "/me" chat-command parser (which is
  // a deprecation-exempt special case we'd rather not depend on). Kick and
  // YouTube send over REST, which has no action concept: a "/me ..." literal
  // would post verbatim on Kick and is dropped on YouTube, so they get the bare
  // body. A bare "/me" with no body falls through as ordinary text.
  const meMatch = text.match(/^\/me\s+(\S[\s\S]*)$/i)
  const restText = meMatch ? meMatch[1].trim() : text
  const twitchText = meMatch ? `\x01ACTION ${restText}\x01` : text

  // Register pending-send tracker — echo confirmation is our ground truth
  // for "did the platform deliver?", separate from sendIrc/Kick's "did we
  // write to the socket?" return value. See pendingSends in this file.
  const _pendingPlatforms = []
  if (sendToTwitch) _pendingPlatforms.push('twitch')
  if (sendToKick) _pendingPlatforms.push('kick')
  // YT echoes don't loop back through chat-message handlers — only the
  // pure-YT send path explicitly confirms via confirmPending(id, 'yt').
  // For dual/triple sends including YT, YT side-fires as best-effort and
  // we don't await its echo (tracking would always fire no_echo on YT).
  if (sendToYoutube && !sendToKick && !sendToTwitch) _pendingPlatforms.push('yt')
  // Track by restText, not text: for a /me action every platform's echo carries
  // the bare body (Twitch strips the CTCP wrapper, Kick/YT never saw the /me),
  // so the pending tracker and peekSentHost/isSentEcho must key on the body or
  // the echo never matches — firing a false "did not confirm" warning and
  // losing badge attribution + dual-send dedup. Identical to text when not /me.
  const _synthId = registerPendingSend({
    text: restText,
    channel: targetChannel,
    platforms: _pendingPlatforms,
    replyParentId: replyState?.msgId || null,
    replyUser: replyState?.user || null,
    noEcho: isNonEchoingCommand(text),
  })

  // Track every send (not just dual-send). The host platform stored on each
  // entry powers two things: (1) dedup of dual-send second echoes, (2) badge
  // attribution via peekSentHost so own messages render with the platform
  // the user is viewing FROM (extension input on kick.com → [K]) regardless
  // of which relay platform actually echoed back.
  // echoes = one per platform whose chat stream loops the message back, so the
  // dedup entry survives until the last echo (twitch + kick + youtube triple).
  const _echoCount = (sendToTwitch ? 1 : 0) + (sendToKick ? 1 : 0) + (sendToYoutube ? 1 : 0)
  // Badge attribution: prefer "the platform you're viewing FROM" (the host page)
  // — but ONLY when the message actually went there. On a YouTube page sending
  // to a twitch+kick channel (no YT leg), the host badge [Y] is a lie: the
  // message never touched YouTube. Fall back to a real send target so an own-echo
  // shows [T]/[K] for a twitch/kick send instead of a phantom [Y].
  const _echoHost =
    hostPlatform === 'yt' && sendToYoutube
      ? 'yt'
      : hostPlatform === 'twitch' && sendToTwitch
        ? 'twitch'
        : hostPlatform === 'kick' && sendToKick
          ? 'kick'
          : sendToTwitch
            ? 'twitch'
            : sendToKick
              ? 'kick'
              : sendToYoutube
                ? 'yt'
                : hostPlatform
  trackSentMessage(restText, _echoHost, _synthId, _echoCount || 1, !!replyState?.msgId)

  // Push to message history (dedup consecutive, cap at max)
  if (mcMessageHistory[0] !== text) {
    mcMessageHistory.unshift(text)
    if (mcMessageHistory.length > MC_HISTORY_MAX) mcMessageHistory.length = MC_HISTORY_MAX
  }
  mcHistoryIndex = -1

  const replyParentId = replyState?.msgId || null
  // YouTube has no reply-threading API — the @mention prepend is the only way
  // a reply's context survives on that leg. Capture the author BEFORE
  // clearReplyState() wipes replyState below; Twitch/Kick keep carrying the
  // real replyParentId and never see this text.
  const replyAuthor = replyState?.user || null
  // Stash the parent context for the own-echo reply bar (see peekOwnReply).
  // Resolve parent text/userId from whichever buffer holds the parent —
  // best-effort, a miss still yields a correct bar from the author name alone.
  // Must run BEFORE clearReplyState() wipes replyState.
  //
  // NOT gated on the twitch leg. It used to be, and that was the whole reason a
  // reply sent on kick or youtube came back with no bar on your own message:
  // kick's echo of our own send carries no reply payload and youtube has no
  // reply threading at all, so those legs have NOTHING to render the bar from
  // except what we remember here. Whether we replied is a fact about the send,
  // not about which chat it went to.
  //
  // Keyed on restText, not twitchText: `/me` wraps twitchText in CTCP ACTION,
  // which no echo ever carries back (irc.js unwraps it, kick/youtube never had
  // it) — so a /me reply missed its own bar on every leg including twitch.
  if (replyParentId) {
    let _parent = null
    try {
      _parent =
        irc?.channels
          ?.get((twitchName || '').toLowerCase())
          ?.getAll?.()
          .find((m) => m?.id === replyParentId) ||
        kickChat?.channels
          ?.get(kickSlug || targetChannel)
          ?.getAll?.()
          .find((m) => m?.id === replyParentId) ||
        null
    } catch (_) {}
    rememberOwnReply(restText, {
      user: replyAuthor || _parent?.user || '',
      text: _parent?.text || '',
      id: replyParentId,
      userId: _parent?.userId || '',
    })
  }
  // Degraded reply text for the YouTube leg only — see ytReplyText
  // (send-targets.js). Twitch/Kick below always send restText/twitchText.
  const ytText = ytReplyText(restText, replyAuthor)
  clearReplyState()

  // Clear input immediately, then settle: auto-hide users get the instant
  // hide (Enter = done), everyone else keeps focus through the sticky-focus
  // window so rapid-fire chatting never retypes into a dead cursor.
  if (wysiwygEnabled) input.textContent = ''
  else input.value = ''
  pendingMessage = ''
  updateCharCount()
  // Settle the composer: auto-hide → instant hide, otherwise open the
  // sticky-focus window so a blur at ANY latency in the send tail (network
  // echo + own-echo DOM rebuild, often past a few hundred ms) can't drop the
  // cursor on the visible composer.
  settleComposerAfterSend(input)

  // --- Kick send path (single, dual, or triple including YT) ---
  if (sendToKick) {
    const slug = kickSlug || targetChannel
    // Reply-threading: resolve the parent from the kick buffer (id + content +
    // sender) — the relay sends kick's reply-shaped payload; a missing parent
    // (scrolled out of buffer) or sender id degrades to a flat send exactly as
    // before, never a failure.
    let kickReply = null
    if (replyParentId && kickChat?.channels?.get(slug)) {
      const parent = kickChat.channels
        .get(slug)
        .getAll()
        .find((m) => m?.id === replyParentId)
      if (parent?.id) {
        kickReply = {
          id: parent.id,
          content: parent.text || '',
          senderId: parent.userId || null,
          senderUsername: parent.user || '',
        }
      }
    }
    // Kick-native emotes need their [emote:id:name] wire form — see
    // kickifyEmoteText. Only the kick leg gets rewritten; twitchText/ytText
    // below still carry the bare words.
    const kickPromise = sendKickMessage(slug, kickifyEmoteText(restText), kickReply)
    const twitchPromise = sendToTwitch
      ? getTwitchAuthTokenAsync().then(({ token: tok, username: twitchNick }) =>
          sendIrcMessage(twitchName, twitchText, tok, replyParentId, twitchNick),
        )
      : Promise.resolve(null)

    // Best-effort YouTube — fire alongside Kick/Twitch so a triple-link
    // channel (twitch+kick+youtube) actually mirrors to all three. Carry the
    // tab's videoId like the other two yt legs — without it the BG falls back
    // to "any youtube tab" and can post into an unrelated stream's chat.
    if (sendToYoutube) {
      sendYoutubeMessage(ytText, ytVideoId)
        .then((result) => {
          if (result !== true && result !== 'no_youtube_tab') {
            // The mirror leg used to flatten every reason into "youtube send
            // failed" while the yt-only path surfaced the real one — same
            // failure, two different truths depending on which leg you were on.
            showToast(youtubeSendErrorMessage(result), 'error')
          }
        })
        .catch(() => showToast(t('mc_yt_send_failed'), 'error'))
    }

    Promise.all([kickPromise, twitchPromise])
      .then(([kickResult, twitchResult]) => {
        const kickOk = kickResult === true
        // twitchResult null = no twitch leg on this send. It still counts as
        // "not failed" (twitchOk) for the queued/partial logic below, but it
        // is NOT a delivery — the success gate must use twitchSent, or a
        // kick-only relay failure routes to "partial success" and dies
        // silently (no red border, no retry notif, just a no_echo warning
        // 20s later).
        const twitchSent = twitchResult === true
        const twitchOk = twitchSent || twitchResult === null
        // 'queued' = IRC was offline, message stuffed in send-queue for next
        // reconnect (could be never). Treat as a visible yellow cue, not silent
        // success — without this the input clears and the user thinks the
        // message went through.
        const twitchQueued = twitchResult === 'queued'
        if (twitchQueued && !kickOk) {
          // Most common: not logged into Twitch IRC (no auth-token cookie) AND
          // not on Kick. Persistent notif (markPendingFailed) replaces the
          // 2.5s placeholder flash users physically couldn't read in time.
          input.style.borderColor = 'var(--hs-danger)'
          setTimeout(() => {
            input.style.borderColor = ''
            updateInputPlaceholder()
          }, 1500)
          markPendingFailed(_synthId, 'auth_failed')
          try {
            HsNotifs.emit('twitch-auth-required', { text: t('mc_input_auth_failed') || 'log into twitch.tv to chat' })
          } catch (_) {}
          return
        }

        if (kickOk || twitchSent) {
          // Dual-send partial success: at least one platform delivered. Drain
          // the failed platform from the pending tracker's awaiting set so the
          // no_echo toast doesn't fire 20s later for the side that locally
          // failed (no echo can ever arrive — the send never made it out).
          // Silent: no partial-failure toast — the user got the message into
          // the channel they're viewing, that's what matters for the dominant
          // use-case (one platform open at a time, kick/yt mirror as bonus).
          if (isDualSend && !twitchOk) {
            try {
              confirmPending(_synthId, 'twitch')
            } catch (_) {}
          }
          if (isDualSend && !kickOk) {
            try {
              confirmPending(_synthId, 'kick')
            } catch (_) {}
          }
        } else {
          // Both failed (or single Kick failed). Surface via persistent notif —
          // input.placeholder flash was too fast to read. Reason carries the
          // dominant platform's error so the retry notif tells the user what
          // actually went wrong (auth/connect/queue/kick-login).
          input.style.borderColor = 'var(--hs-danger)'
          setTimeout(() => {
            input.style.borderColor = ''
            updateInputPlaceholder()
          }, 1500)
          let reason
          if (sendToTwitch && twitchResult && twitchResult !== true && twitchResult !== null) {
            reason = twitchResult
          } else {
            reason = kickResult || 'send_failed'
          }
          markPendingFailed(_synthId, reason)
          if (reason === 'auth_failed' || reason === 'no_user') {
            try {
              HsNotifs.emit('twitch-auth-required', { text: t('mc_input_auth_failed') || 'log into twitch.tv to chat' })
            } catch (_) {}
          }
        }
      })
      .catch((err) => {
        // A leg rejected (context invalidation, throw) rather than returning an
        // error string — without this the pending '•' hangs forever.
        log(`dual-send rejected: ${err?.message || err}`)
        input.style.borderColor = 'var(--hs-danger)'
        setTimeout(() => {
          input.style.borderColor = ''
          updateInputPlaceholder()
        }, 1500)
        markPendingFailed(_synthId, 'send_failed')
      })
    return
  }

  // --- YouTube-only send path (no Twitch, no Kick) ---
  if (sendToYoutube && !sendToKick && !sendToTwitch) {
    sendYoutubeMessage(ytText, ytVideoId)
      .then((result) => {
        if (result === true) {
          // YT echoes don't loop back through our IRC handlers, so the timer
          // would always fire "no_echo" for pure-YT sends. Confirm here, with
          // explicit 'yt' platform so the per-platform awaiting set drains.
          confirmPending(_synthId, 'yt')
        } else {
          // Pass the rich code through (chat_restricted:<yt's reason>, no_input,
          // chat_disabled…) — the persistent retry notif is what users actually
          // read; collapsing to 'send_failed' here hid WHY on every gated chat.
          const reason = String(result || 'send_failed')
          markPendingFailed(_synthId, reason)
          showToast(youtubeSendErrorMessage(result), 'error')
        }
      })
      .catch((err) => {
        log(`yt-only send rejected: ${err?.message || err}`)
        markPendingFailed(_synthId, 'send_failed')
      })
    return
  }
  // Twitch + YouTube (and no Kick) — fire YouTube as best-effort alongside Twitch send below
  if (sendToYoutube && sendToTwitch && !sendToKick) {
    sendYoutubeMessage(ytText, ytVideoId)
      .then((result) => {
        if (result !== true && result !== 'no_youtube_tab') {
          showToast(youtubeSendErrorMessage(result), 'error')
        }
      })
      .catch(() => showToast(t('mc_yt_send_failed'), 'error'))
    // fall through to Twitch path
  }

  // --- Twitch-only send path (existing behavior) ---
  const { token, username: twitchNick } = await getTwitchAuthTokenAsync()
  if (!token) {
    markPendingFailed(_synthId, 'auth_failed')
    try {
      HsNotifs.emit('twitch-auth-required', { text: t('mc_input_not_logged_in') || 'log into twitch.tv to chat' })
    } catch (_) {}
    return
  }

  const wsState = authState.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][authState.ws.readyState] : 'null'
  log(`IRC SEND → #${targetChannel} ws=${wsState} ready=${authState.ready} queue=${authState.sendQueue.length}`)
  sendIrcMessage(targetChannel, twitchText, token, replyParentId, twitchNick)
    .then((result) => {
      if (result === true) {
        if (wsState !== 'OPEN') {
          input.style.borderColor = 'var(--hs-warn)'
          setTimeout(() => {
            input.style.borderColor = ''
          }, 1500)
        }
        // success-from-socket only; echo confirmation handled by pending tracker
      } else {
        input.style.borderColor = 'var(--hs-danger)'
        setTimeout(() => {
          input.style.borderColor = ''
          updateInputPlaceholder()
        }, 1500)
        markPendingFailed(_synthId, result || 'send_failed')
        if (result === 'auth_failed' || result === 'no_user') {
          try {
            HsNotifs.emit('twitch-auth-required', { text: t('mc_input_auth_failed') || 'log into twitch.tv to chat' })
          } catch (_) {}
        }
      }
    })
    .catch((err) => {
      log(`twitch send rejected: ${err?.message || err}`)
      input.style.borderColor = 'var(--hs-danger)'
      setTimeout(() => {
        input.style.borderColor = ''
        updateInputPlaceholder()
      }, 1500)
      markPendingFailed(_synthId, 'send_failed')
    })
}

// The exact live video id for the stream currently being composed to, from the
// same poller-fed source the popout trusts (youtubeLinks[currentTab].videoId).
// Falls back to a concrete watch?v= id in the channel's saved YT url. NEVER a
// guess: a channel-only url resolves to '' so background won't auto-open a tab
// to the wrong stream. `ytUrl` is ch?.youtube.
function currentYoutubeVideoId(ytUrl) {
  try {
    if (typeof youtubeLinks !== 'undefined' && typeof currentTab !== 'undefined') {
      const vid = youtubeLinks.get(currentTab)?.videoId
      if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) return vid
    }
  } catch (_) {}
  return extractYoutubeVideoId(ytUrl)
}

// Drive a YouTube send. `videoId` (when known) lets background auto-open a
// hidden, pinned live_chat bridge tab if the user has no youtube.com tab open —
// the tab inherits their YouTube login cookies, so send "just works" whenever
// they're signed into YouTube in Chrome. Returns true, or an error code string.
async function sendYoutubeMessage(text, videoId) {
  try {
    const resp = await safeSendMessage({ type: 'youtube_send_message', text, videoId: videoId || undefined })
    if (resp?.ok) return true
    log('YouTube send failed:', resp?.error, resp?.reason || '')
    // chat_restricted carries YT's human reason ("Subscribers-only mode") —
    // ride it on the code string so the toast can show WHY instead of a
    // generic failure. youtubeSendErrorMessage splits it back off.
    if (resp?.error && resp?.reason) return `${resp.error}:${resp.reason}`
    return resp?.error || 'send_failed'
  } catch (e) {
    log('YouTube send error:', e.message)
    return 'send_failed'
  }
}

// ============================================
// MEDIA UPLOAD — paste image, drag-drop file
// ============================================

const MC_UPLOAD_MAX_IMG = 5 * 1024 * 1024 // 5MB
const MC_UPLOAD_MAX_VID = 50 * 1024 * 1024 // 50MB
let _mcUploading = false

// One status line, one timer. The auto-clear lives here rather than at each
// call site because the upload path chains messages — "upload done" can be
// replaced by a warning about what the upload cost you — and two call sites each
// holding their own setTimeout meant the FIRST one's timer wiped the SECOND
// one's message a moment after it appeared.
let _mcStatusTimer = null
function showUploadStatus(msg, isError, clearAfterMs) {
  if (_mcStatusTimer) {
    clearTimeout(_mcStatusTimer)
    _mcStatusTimer = null
  }
  if (clearAfterMs) _mcStatusTimer = setTimeout(() => showUploadStatus(null), clearAfterMs)
  const bar = document.getElementById('hs-mc-upload-status')
  if (msg) {
    if (bar) {
      bar.textContent = msg
      bar.style.color = isError ? 'var(--hs-danger)' : '#fff'
      bar.style.display = 'block'
      return
    }
    const inputbar = document.getElementById('hs-mc-inputbar')
    if (!inputbar) return
    const el = document.createElement('div')
    el.id = 'hs-mc-upload-status'
    el.style.cssText = 'padding:2px 8px;font-size:13px;color:#fff;background:#000;border-top:1px solid #808080;'
    el.textContent = msg
    inputbar.insertBefore(el, inputbar.firstChild)
  } else if (bar) {
    bar.remove()
  }
}

async function uploadMediaFile(file) {
  if (_mcUploading) {
    showUploadStatus('upload in progress...', true)
    return null
  }
  if (!file) return null
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  if (!isImage && !isVideo) {
    showUploadStatus('only images/videos allowed', true, 2500)
    return null
  }
  const maxSize = isImage ? MC_UPLOAD_MAX_IMG : MC_UPLOAD_MAX_VID
  if (file.size > maxSize) {
    showUploadStatus(`file too large (max ${maxSize / 1048576}MB)`, true, 2500)
    return null
  }
  _mcUploading = true
  // No percentage. This used to be a raw XMLHttpRequest purely so it could
  // report upload progress — and that choice is what broke it. A content
  // script's own request is subject to the HOST page's CORS, and heatsync.org
  // does not allow twitch.tv / kick.com / youtube.com as origins, so the
  // response was rejected before any handler saw it and the XHR fired its
  // generic `error` event: "upload failed: network error", on every host page,
  // for every paste. (It worked when the same code ran on heatsync.org, which
  // is same-origin — which is how it passed as working.) It also relied on
  // withCredentials cookies, which don't ride a cross-site request at all.
  //
  // So it goes through the background worker like every other API call in the
  // extension (see apiFetch in social.js) — that path bypasses CORS via
  // host_permissions and carries the stored auth token. Messaging can't stream
  // progress back, and an honest "uploading..." beats a percentage on a
  // request that never left the page.
  showUploadStatus('uploading...')
  try {
    // FileReader, not btoa over a Uint8Array: building the binary string a
    // char at a time overflows the stack somewhere in the low megabytes, and
    // the video cap here is 50MB.
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.addEventListener('load', () => resolve(String(fr.result || '')))
      fr.addEventListener('error', () => reject(new Error('could not read file')))
      fr.readAsDataURL(file)
    })
    const resp = await safeSendMessage({
      type: 'api_upload',
      name: file.name || 'paste',
      mime: file.type,
      dataUrl,
    })
    if (!resp?.ok || !resp.url) throw new Error(resp?.error || 'upload failed')
    const url = resp.url
    showUploadStatus('upload done', false, 1500)
    return url
  } catch (e) {
    showUploadStatus(`upload failed: ${e.message}`, true, 3500)
    return null
  } finally {
    _mcUploading = false
  }
}

// The original source URL behind a pasted/dropped image, when the clipboard
// carries one. Chromium's "copy image" writes TWO flavors: a bitmap — which for
// an animated gif is a single flattened frame, the animation already gone — and
// a text/html fragment holding the original <img src>, which still points at the
// live animated file. Reading that flavor is how gmail/docs paste a gif and keep
// it moving; without it there is no path back to the frames.
//
// Exactly one <img> or nothing: a copy of page CONTENT (a paragraph with images
// in it) also produces html, and guessing which of several images was meant is
// how you post the wrong picture. One image means the copy WAS that image.
function clipboardImageSourceUrl(dt) {
  try {
    const html = dt?.getData?.('text/html')
    if (!html) return ''
    const imgs = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img[src]')
    if (imgs.length !== 1) return ''
    // Resolved against a sentinel base so a relative src — unusable, we have no
    // idea what page it came from — lands on the sentinel host and is dropped.
    const u = new URL(imgs[0].getAttribute('src') || '', 'https://relative.invalid')
    if (u.protocol !== 'https:' || u.hostname === 'relative.invalid') return ''
    return u.toString()
  } catch {
    return ''
  }
}

// Ask the server for its own stored copy of a remote image. Returns '' on any
// failure — the caller falls back to uploading the clipboard bitmap, so the
// worst case is the old behaviour, never a lost paste.
async function storeRemoteMedia(srcUrl) {
  if (_mcUploading) return ''
  _mcUploading = true
  showUploadStatus('uploading...')
  try {
    const resp = await safeSendMessage({ type: 'api_store_remote', url: srcUrl })
    if (!resp?.ok || !resp.url) return ''
    showUploadStatus('upload done', false, 1500)
    return resp.url
  } catch {
    return ''
  } finally {
    _mcUploading = false
  }
}

async function handleMediaUpload(file, sourceUrl) {
  // The source url is used ONLY when it looks animated, never for stills.
  // Resolving it means handing our server a url the user never meant to share —
  // they meant to share the picture — and for a still there is nothing to gain:
  // Chromium's clipboard bitmap is lossless PNG, so the upload is already an
  // exact copy. Animation is the one thing the clipboard destroys, so animation
  // is the only thing worth spending a url on.
  const maybeAnimated = /\.(gif|webp|avif)(\?|#|$)/i.test(sourceUrl || '')
  let url = maybeAnimated ? await storeRemoteMedia(sourceUrl) : ''
  const lostAnimation = maybeAnimated && !url
  if (!url) url = await uploadMediaFile(file)
  if (!url) return
  // Say it out loud. The fallback posts a picture either way, so the failure is
  // invisible — you'd just be left wondering why your gif came out frozen.
  if (lostAnimation) {
    showUploadStatus("couldn't reach the original — posted a still frame", true, 4000)
  }
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  showInputBar()
  input.focus()
  if (input.isContentEditable) {
    if (!document.execCommand('insertText', false, `${url} `)) {
      input.textContent = `${(input.textContent || '') + url} `
    }
  } else {
    input.value = `${(input.value || '') + url} `
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

let _mcDropHandlersInstalled = false
function setupMediaDropHandlers() {
  if (_mcDropHandlersInstalled) return
  _mcDropHandlersInstalled = true
  const overlay = document.getElementById('hs-mc-overlay')
  if (!overlay) return

  let dragCounter = 0
  const showDropZone = () => {
    let dz = document.getElementById('hs-mc-drop-zone')
    if (!dz) {
      dz = document.createElement('div')
      dz.id = 'hs-mc-drop-zone'
      dz.style.cssText =
        'position:absolute;inset:0;background:rgba(255,255,255,0.1);border:2px dashed #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;z-index:99998;pointer-events:none;'
      dz.textContent = 'drop image/video to upload'
      overlay.appendChild(dz)
    }
  }
  const hideDropZone = () => {
    document.getElementById('hs-mc-drop-zone')?.remove()
    dragCounter = 0
  }

  overlay.addEventListener(
    'dragenter',
    (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      dragCounter++
      showDropZone()
    },
    { signal: mcSignal },
  )
  overlay.addEventListener(
    'dragover',
    (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    { signal: mcSignal },
  )
  overlay.addEventListener(
    'dragleave',
    (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      dragCounter--
      if (dragCounter <= 0) hideDropZone()
    },
    { signal: mcSignal },
  )
  overlay.addEventListener(
    'drop',
    (e) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      hideDropZone()
      const file = e.dataTransfer.files[0]
      // A drag out of a web page carries the same html flavor as a copy, so a
      // dragged gif gets the same route back to its frames.
      handleMediaUpload(file, clipboardImageSourceUrl(e.dataTransfer))
    },
    { signal: mcSignal },
  )
}

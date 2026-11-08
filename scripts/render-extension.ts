/**
 * Assert the overlay's real geometry in a real browser.
 *
 *   bun run test:render
 *
 * Why this exists: most test files never touch a DOM. Many assert that source
 * text contains expected substrings, which is a drift tripwire, not a safety
 * net — and every expensive bug in this project's history has been a
 * RENDERING bug found by eye, days later. Chip smear, blurry text, paints frozen
 * at frame 0, white video, the player-collapse trio, and an overlay showing an
 * inch of chat. Not one of them was catchable by grepping source.
 *
 * How it gets a page: Chrome matches content scripts on URL, not on who served
 * the bytes. So the request for a twitch URL is fulfilled locally with a
 * fixture, the page URL stays `https://www.twitch.tv/...`, and the extension
 * injects for real. A NON-CHANNEL twitch url is used deliberately — main.js has
 * a body-mount path for those (`Twitch non-channel page — body-mount overlay`),
 * so no React tree has to be faked.
 *
 * heatsync.org is routed to abort: the harness must never depend on, or write
 * to, production.
 *
 * Opt-in, like smoke-extension.ts: it needs a real browser binary, which the
 * unit suite deliberately does not depend on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuilt, launchWithExtension } from './lib/chromium'
import { composerAndPickerCheck } from './render/composer'
import { diagQuietCheck } from './render/diag-quiet'
import { emoteEffectsCheck } from './render/emote-effects'
import { gateCheck } from './render/gate'
import { gifsTabCheck } from './render/gifs'
import { kickModCheck } from './render/kick-mod'
import { kickSendCheck } from './render/kick-send'
import { closeContext, errors, fail, checks } from './render/lib'
import { pickerClickCheck } from './render/picker'
import { platformsGeometry } from './render/platforms-geometry'
import { rowKeysCheck } from './render/row-keys'
import { soundCheck } from './render/sounds'
import { tabCompleteCheck } from './render/tab-complete'
import { tourCheck } from './render/tour'
import { twitchIrcCheck } from './render/twitch-send'
import { emoteUploadCheck } from './render/upload'
import { youtubeDeleteCheck } from './render/youtube-delete'
import { ytInsertCheck } from './render/youtube-insert'
import { youtubeSendCheck } from './render/youtube-send'

const profile = mkdtempSync(join(tmpdir(), 'hs-ext-render-'))
let ctx: any = null

try {
  assertBuilt()
  ctx = await launchWithExtension(profile, ['--window-size=1600,900'])
  ctx.on('page', (p: any) => p.on('pageerror', (e: unknown) => errors.push(`page: ${String(e).slice(0, 300)}`)))
  // Same reason as in the picker check: nothing below may navigate until the
  // extension is live, or there is no content-script injection to wait for.
  if (!ctx.serviceWorkers()[0]) await ctx.waitForEvent('serviceworker', { timeout: 20_000 })

  await platformsGeometry(ctx)
  await emoteEffectsCheck(ctx)
  await youtubeDeleteCheck(ctx)
  await diagQuietCheck(ctx)

  // ── the chat kill-switches, in both directions ───────────────────────────
  // Every source test around subsystem gates is a grep. This is the only check
  // that answers the question the user actually asks: "I turned twitch chat
  // off — is it off?" It was NOT, and no grep could have told us: the switch
  // gated `irc.connect()`, which is a no-op because the background owns the
  // socket, so the listener that renders twitch rows was registered anyway.
  //
  // Both polarities, because a gate fix that only proves the OFF half is
  // indistinguishable from having broken chat. Runs in its own contexts —
  // the subsystem map has to be seeded before the content script boots.
  await gateCheck()

  // ── the youtube picker's emote insert ────────────────────────────────────
  // Proves the transport, with a control, against the real listener: the same
  // message sent both ways in one run. runtime.sendMessage — what the picker
  // used — never arrives at a content script, and nothing reports that.
  await ytInsertCheck()

  // ── and the same thing through the actual UI, on every platform ──────────
  // The check above drives the message by hand. This one clicks the button,
  // opens the panel and clicks a tile — the path a person takes. Reverting the
  // youtube fix and re-running it leaves that input empty, which is what the
  // bug was; twitch and kick are here because nothing had ever driven them.
  await pickerClickCheck()

  // ── the gifs tab, in a real browser ──────────────────────────────────────
  // The grid PAINTS STILLS and animates exactly the tile under the pointer.
  // Nothing about that is visible to a source test, and getting it wrong is
  // 24 gif decoders running over a live video player.
  await gifsTabCheck()
  await emoteUploadCheck()

  // ── the whole point of the product, end to end ───────────────────────────
  // Compose a message, press Enter, watch it leave on the IRC wire, echo it
  // back the way twitch does, and see it render. Against a LOCAL mock server —
  // twitch is never contacted.
  // Twice, because `dim timed-out messages` picks between two treatments and
  // the OFF one — hide — did not exist in the overlay until today.
  await twitchIrcCheck({ dim: true, full: true })
  await twitchIrcCheck({ dim: false, full: false })

  // ── the other two send paths ─────────────────────────────────────────────
  // Three platforms, three completely different transports. Twitch is a socket
  // (above), kick is an authenticated POST relayed through a kick.com tab, and
  // youtube drives youtube's own composer. Only the first was covered.
  await kickSendCheck()
  await kickModCheck()
  await youtubeSendCheck()

  // ── the most-pressed key in the composer ─────────────────────────────────
  // Tab-complete carries four recorded incidents in its ranking alone and had
  // never been pressed by a test — every existing check reads the comparator's
  // source and confirms it still says what it used to. This one types, presses
  // Tab, and reads what came out.
  await tabCompleteCheck()

  // ── the chat rows, for someone who never touches the mouse ───────────────
  // Row mode (alt+r), the row's right-click menu as a real ARIA menu, reply by
  // key, a tab's "move" items, and the screen reader modes. All of it is focus,
  // paint and key handling — nothing a grep of the source can vouch for.
  await rowKeysCheck()

  // ── the first-run tour card ───────────────────────────────────────────────
  // A fresh profile is a first run: the card must be there, change the real
  // chat through the real settings, and never come back once it is closed.
  await tourCheck()

  // ── highlight rule sounds: a picked file, a volume, one rate limit ───────
  // A rule's own audio file through the real Web Audio, the real autoplay
  // policy and the real settings form, and an export that stays small.
  await soundCheck()

  // ── the composer and the picker, for someone who never touches the mouse ──
  // Sent history across a reload, the live spellcheck setting, the autocomplete
  // list as an ARIA combobox, and the picker's arrow-key cursor on both the
  // main grid and search results.
  await composerAndPickerCheck()

  if (errors.length) fail(`runtime errors:\n  ${errors.join('\n  ')}`)
  console.log(`\n✓ render checks passed — ${checks.length} assertions`)
} catch (e) {
  console.error(`\n✗ render checks FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  // Bounded, like every other context here. A plain close() on a persistent
  // context can hang forever, and on the failure path that turned a 2-minute
  // run into a 10-minute wedge with the real error already printed and nothing
  // left to do.
  if (ctx) await closeContext(ctx, 'main harness', profile)
  rmSync(profile, { recursive: true, force: true })
}
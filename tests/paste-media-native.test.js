/**
 * Native chat (twitch/kick/youtube) media paste/drop: the upload must never
 * be triggerable by a bare postMessage.
 *
 * autocomplete-hook.js runs in the MAIN world, which shares its JS context
 * with every other script on the page — ads, third-party embeds, anything
 * twitch.tv loads. A privileged action (spending the user's own heatsync
 * auth token to upload a file) must not be reachable from there: any page
 * script could window.postMessage straight into it and burn the user's
 * upload quota / trip moderation, with no DOM interaction at all. The upload
 * has to live in an isolated-world script instead, gated on a real
 * paste/drop event's clipboardData/dataTransfer — this file locks that in,
 * plus the single shared upload helper every native surface goes through.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const AC_SRC = readFileSync(join(ROOT, 'chrome/autocomplete-hook.js'), 'utf8')
const CONTENT_SRC = readFileSync(join(ROOT, 'chrome/content.js'), 'utf8')
const SHARED_SRC = readFileSync(join(ROOT, 'chrome/shared-utils.js'), 'utf8')
const KICK_SRC = readFileSync(join(ROOT, 'chrome/kick-autocomplete-hook.js'), 'utf8')
const YT_SRC = readFileSync(join(ROOT, 'chrome/youtube-content.js'), 'utf8')

describe('the MAIN-world twitch hook cannot trigger an upload', () => {
  test('no api_upload reachable from autocomplete-hook.js', () => {
    // MAIN world has no chrome.runtime at all, so a direct call would just
    // throw — the risk is a postMessage bridge that does the privileged part
    // FOR it. Neither should exist here.
    expect(AC_SRC).not.toMatch(/api_upload/)
    expect(AC_SRC).not.toMatch(/chrome\.runtime/)
  })

  test('no paste/drop listeners at all — that moved to content.js', () => {
    expect(AC_SRC).not.toMatch(/addEventListener\(\s*['"]paste['"]/)
    expect(AC_SRC).not.toMatch(/addEventListener\(\s*['"]drop['"]/)
  })

  test('only accepts a bounded, already-built url as text — never file bytes', () => {
    const handler = AC_SRC.slice(AC_SRC.indexOf("'heatsync-insert-text'"))
    const body = handler.slice(0, handler.indexOf('{ signal: acSignal }'))
    expect(body).toMatch(/text\.length < 1 \|\| text\.length > 2000/)
    expect(body).not.toMatch(/dataUrl|FileReader|mime/)
  })
})

describe('the upload lives in content.js (isolated world), gated on a real event', () => {
  test('twitch paste/drop are scoped to the real chat input and require a file', () => {
    expect(CONTENT_SRC).toMatch(/function isTwitchChatInput/)
    expect(CONTENT_SRC).toMatch(/data-slate-editor="true"/)
    // Both listeners bail out before doing anything if there's no matching
    // file — a bare postMessage forgery has no clipboardData/dataTransfer to
    // read, so there is nothing for it to trigger.
    const pasteBlock = CONTENT_SRC.slice(
      CONTENT_SRC.indexOf("'twitch-media-paste'") - 800,
      CONTENT_SRC.indexOf("'twitch-media-paste'"),
    )
    expect(pasteBlock).toMatch(/isTwitchChatInput\(e\.target\)/)
    expect(pasteBlock).toMatch(/e\.clipboardData\?\.\items/)
  })

  test('capture phase, so it runs before Slate’s own bubble-phase handling', () => {
    expect(CONTENT_SRC).toMatch(/'twitch-media-paste'/)
    expect(CONTENT_SRC).toMatch(/'twitch-media-drop'/)
    const idx = CONTENT_SRC.indexOf('isTwitchChatInput')
    const region = CONTENT_SRC.slice(idx, idx + 2500)
    expect(region.match(/\{ capture: true \}/g) || []).toHaveLength(2)
  })

  test('the upload goes through the one shared helper, not a local copy', () => {
    expect(CONTENT_SRC).toMatch(/window\.HS\.uploadMediaFiles/)
    expect(CONTENT_SRC).not.toMatch(/api_upload/)
  })

  test('the old relay message type is gone entirely', () => {
    for (const src of [AC_SRC, CONTENT_SRC]) {
      expect(src).not.toMatch(/heatsync-upload-media/)
    }
  })
})

describe('window.HS.uploadMediaFiles is the single source of caps/filter/upload/toast', () => {
  test('shared-utils.js defines it and exposes it on window.HS', () => {
    expect(SHARED_SRC).toMatch(/async function uploadMediaFiles/)
    expect(SHARED_SRC).toMatch(/uploadMediaFiles,/)
  })

  test('a concurrent call while one is in flight is a no-op, and the flag always clears', () => {
    const start = SHARED_SRC.indexOf('async function uploadMediaFiles')
    const fn = SHARED_SRC.slice(start, SHARED_SRC.indexOf('\n  }', start) + 4)
    expect(fn).toMatch(/if \(_hsMediaUploading\) return \[\]/)
    expect(fn).toMatch(/finally \{\s*_hsMediaUploading = false/)
  })

  test('size caps exist exactly once, in shared-utils.js — not duplicated per surface', () => {
    for (const src of [AC_SRC, CONTENT_SRC, KICK_SRC, YT_SRC]) {
      expect(src).not.toMatch(/1024 \* 1024/)
    }
    expect(SHARED_SRC).toMatch(/HS_UPLOAD_MAX_IMG = 5 \* 1024 \* 1024/)
    expect(SHARED_SRC).toMatch(/HS_UPLOAD_MAX_VID = 45 \* 1024 \* 1024/)
  })

  test('the video cap leaves margin under sendMessage’s ~64MiB structured-clone limit', () => {
    // The file rides to the background as base64 (~4/3 the raw size) inside a
    // chrome.runtime.sendMessage payload — there is no ArrayBuffer/Blob path
    // across that bridge, so this cap IS the size guard. 50MB would overflow
    // it; 45MB must not.
    const CHROME_MESSAGE_CAP = 64 * 1024 * 1024
    const HS_UPLOAD_MAX_VID = 45 * 1024 * 1024
    const base64Size = Math.ceil(HS_UPLOAD_MAX_VID / 3) * 4
    expect(base64Size).toBeLessThan(CHROME_MESSAGE_CAP)
    // ...with real margin left for the JSON envelope, not just barely under.
    expect(CHROME_MESSAGE_CAP - base64Size).toBeGreaterThan(2 * 1024 * 1024)
  })

  test('shows a persistent "uploading..." status, since a video can take 10-60s', () => {
    const start = SHARED_SRC.indexOf('async function uploadMediaFiles')
    const fn = SHARED_SRC.slice(start, SHARED_SRC.indexOf('\n  }', start) + 4)
    // durationMs: 0 means "don't auto-dismiss" — see showToast's own contract.
    expect(fn).toMatch(/showToast\('uploading\.\.\.', 'info', 0\)/)
  })

  test('the uploading status only self-clears when every file succeeded', () => {
    // Clearing unconditionally would cut off a just-shown error toast — the
    // failure message needs its own time on screen, not the success path's.
    const start = SHARED_SRC.indexOf('async function uploadMediaFiles')
    const fn = SHARED_SRC.slice(start, SHARED_SRC.indexOf('\n  }', start) + 4)
    expect(fn).toMatch(/if \(urls\.length === files\.length\) showToast\(null\)/)
  })

  test('showToast(null) hides immediately, and a fresh call cancels any pending auto-dismiss', () => {
    const fn = SHARED_SRC.slice(SHARED_SRC.indexOf('function showToast'), SHARED_SRC.indexOf('function apiFetch'))
    expect(fn).toMatch(/if \(!message\) \{\s*document\.getElementById\('heatsync-toast'\)\?\.remove\(\)/)
    expect(fn).toMatch(/if \(_toastTimer\) \{\s*clearTimeout\(_toastTimer\)/)
    expect(fn).toMatch(/if \(durationMs === 0\) return/)
  })

  test('kick and youtube call the shared helper instead of their own upload/toast', () => {
    for (const src of [KICK_SRC, YT_SRC]) {
      expect(src).toMatch(/window\.HS\.uploadMediaFiles/)
      expect(src).not.toMatch(/api_upload/)
      expect(src).not.toMatch(/FileReader/)
    }
  })
})

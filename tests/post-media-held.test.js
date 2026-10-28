/**
 * feed-embed.js — a post's own media (a thread, a feed row) is held behind the
 * viewer's toggles when the scanner flagged it. An opted-in or clean post
 * renders as before; the real markup stays inert in a <template> until "show".
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'feed-embed.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

let on = new Set()
const getSetting = (k) => on.has(k)
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const REAL = '<div class="hs-feed-media"><img src="https://x.test/a.webp" class="hs-feed-media-img"></div>'

const held = sliceBetween('const HS_MEDIA_SETTING', '\nfunction _buildFeedResolvedHtml')
const wrap = sliceBetween('function buildFeedMediaHtml', '// Handles direct uploads')
const { buildFeedMediaHtml } = new Function(
  'getSetting',
  'attr',
  '_feedMediaHtml',
  `${held}\n${wrap}\nreturn { buildFeedMediaHtml }`,
)(getSetting, attr, (m) => (m?.has_media ? REAL : ''))

const post = (cats) => ({ has_media: true, moderation_result: { flaggedCategories: cats } })

beforeEach(() => {
  on = new Set()
})

describe('buildFeedMediaHtml held gate', () => {
  test('a flagged post is held: box, show button, markup only inside a template', () => {
    const html = buildFeedMediaHtml(post(['nsfw']))
    expect(html).toContain('[media hidden — nsfw]')
    expect(html).toContain('hs-mc-held-post-show')
    const outside = html.replace(/<template>[\s\S]*<\/template>/, '')
    expect(outside).not.toContain('<img')
    expect(html).toContain(`<template>${REAL}</template>`)
  })

  test('opting in to the category shows the media as before', () => {
    on.add('viewer_show_sexual')
    expect(buildFeedMediaHtml(post(['nsfw']))).toBe(REAL)
  })

  test('opting in to a different category does not release it', () => {
    on.add('viewer_show_gore')
    expect(buildFeedMediaHtml(post(['nsfw']))).toContain('hs-mc-held-post')
  })

  test('a clean, unflagged or media-less post is untouched', () => {
    expect(buildFeedMediaHtml(post([]))).toBe(REAL)
    expect(buildFeedMediaHtml({ has_media: true })).toBe(REAL)
    expect(buildFeedMediaHtml({ moderation_result: { flaggedCategories: ['nsfw'] } })).toBe('')
  })

  test('csam is held with no button and no markup, whatever is on', () => {
    for (const k of ['viewer_show_sexual', 'viewer_show_gore']) on.add(k)
    const html = buildFeedMediaHtml(post(['csam']))
    expect(html).toContain('[media hidden — csam]')
    expect(html).not.toContain('show')
    expect(html).not.toContain('<img')
  })
})

describe('show / hide wiring', () => {
  test('the click handler offers hide after show and removes the real markup again', () => {
    expect(SRC).toContain("'.hs-mc-held-post-show, .hs-mc-held-post-hide'")
    expect(SRC).toContain("box.querySelector('.hs-mc-held-real')?.remove()")
    expect(SRC).toContain("hide.textContent = 'hide'")
  })
})

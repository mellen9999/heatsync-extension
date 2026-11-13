import { PLATFORMS, errors, fail, ok, retryUntil } from './lib'

export async function youtubeDeleteCheck(ctx: any) {
  // ── a youtube deletion actually reaches the overlay ──────────────────────
  // Everything below the socket, for real: the extension's own page sends the
  // exact message background.js broadcasts on `youtube:delete`, it crosses into
  // the content script through the listener listenForSocialEvents registers,
  // and applyYtDeletion patches the live DOM. That listener is gated on a
  // subsystem switch, so this also fails if the gate ever narrows again.
  //
  // The rows carry data-msg-platform="youtube", as buildMessageDiv draws a
  // youtube row: a row with no platform is a twitch row, which a youtube
  // deletion must never touch.
  {
    const yp = await ctx.newPage()
    yp.on('pageerror', (e: unknown) => errors.push(`yt-delete: ${String(e).slice(0, 300)}`))
    await yp.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await yp.waitForSelector('#hs-mc-messages', { timeout: 25_000 })

    // The overlay re-renders its message list as emote sets and history land after boot, which
    // removes rows placed by hand; a deletion cannot clear a row that is no longer there. So the
    // rows are (re)placed whenever they are missing, on every delivery attempt below.
    const placeRows = () =>
      yp.evaluate(() => {
        const msgs = document.getElementById('hs-mc-messages')
        if (!msgs) return
        for (const [id, user] of [['YT_DOOMED', 'someone'], ['YT_SAFE', 'other']]) {
          if (msgs.querySelector(`.hs-mc-msg[data-msg-id="${id}"]`)) continue
          const d = document.createElement('div')
          d.className = 'hs-mc-msg'
          d.dataset.msgId = id
          d.dataset.msgUser = user
          d.dataset.msgPlatform = 'youtube'
          d.innerHTML = '<span class="hs-mc-text">a youtube message</span>'
          msgs.appendChild(d)
        }
      })
    await placeRows()

    const worker2 = ctx.serviceWorkers()[0]
    const id2 = worker2?.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id2) fail('could not resolve the extension id to drive a deletion')
    const ep2 = await ctx.newPage()
    await ep2.goto(`chrome-extension://${id2}/popup.html`, { waitUntil: 'load' })
    const deliver = () =>
      ep2.evaluate(
      () =>
        new Promise((res) => {
          try {
            // @ts-ignore — extension page
            // Every twitch tab, not the first: a page an earlier check closed can still be listed
            // while it goes, and a find() that picks it sends the deletion nowhere (CI, 11-08).
            chrome.tabs.query({}, (tabs: any[]) => {
              const targets = tabs.filter((x) => (x.url || '').includes('twitch.tv'))
              if (!targets.length) return res('no twitch tab found')
              for (const t of targets) {
                // @ts-ignore
                chrome.tabs.sendMessage(t.id, { type: 'youtube_delete', data: { messageIds: ['YT_DOOMED'] } }, () => {
                  // @ts-ignore — read it so a tab with no listener does not log an unchecked error
                  void chrome.runtime.lastError
                })
              }
              res('sent')
            })
          } catch (e) {
            res(`threw: ${String(e)}`)
          }
        }),
    )
    // The content script registers its listener a beat after the overlay mounts, and a broadcast that
    // arrives first is dropped without a word. A deletion is harmless to repeat, so deliver it again
    // until the row clears instead of guessing how long registration takes.
    let delivered = 'never sent'
    const cleared = await retryUntil(
      yp,
      async () => {
        await placeRows()
        delivered = (await deliver()) as string
      },
      () =>
        yp.evaluate(() =>
          !!document.querySelector('.hs-mc-msg[data-msg-id="YT_DOOMED"]')?.classList.contains('hs-mc-msg-cleared'),
        ),
      { every: 1500, ms: 12_000 },
    )
    await ep2.close()
    if (delivered !== 'sent') fail(`could not deliver the deletion: ${delivered}`)

    const untouched = await yp.evaluate(
      () => !document.querySelector('.hs-mc-msg[data-msg-id="YT_SAFE"]')?.classList.contains('hs-mc-msg-cleared'),
    )
    await yp.close()

    if (!cleared) {
      fail(
        'a youtube:delete broadcast never reached the overlay — the message stayed live. ' +
          'the wire is background -> chrome.tabs -> listenForSocialEvents -> applyYtDeletion; ' +
          'a narrowed subsystem gate breaks it silently.',
      )
    }
    if (!untouched) fail('the deletion cleared a message it was not told to clear')
    ok('a youtube deletion crosses from the extension page into the overlay and clears only its target')
  }
}

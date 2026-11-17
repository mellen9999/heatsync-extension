/**
 * s12 — the chat pop-outs, the url each platform's own pop-out button (and ours) opens, in a
 * pop-out sized window: twitch /popout/<ch>/chat, kick /popout/<ch>/chat, youtube
 * /live_chat?is_popout=1. A pop-out is all chat, renders even when its visibility flag lies,
 * and on kick arrives server-rendered for React to hydrate: a panel or button placed inside the
 * page before that broke kick's hydration (React #418) on every pop-out (11-16).
 *
 * Invariants on each:
 *   - the panel fills the window, chat flows, the input bar shows, the native chat does not
 *   - the page throws nothing it does not throw without the extension
 *   - the overlay's watchdogs stay quiet
 */
import {
  bad,
  info,
  launch,
  liveChannels,
  liveYtVideo,
  ok,
  panel,
  ringSince,
  rowsFlow,
  scenario,
  shot,
  sleep,
  waitPanel,
  watchErrors,
} from './lib'

const W = 400
const H = 600

export async function s12Popout() {
  scenario('s12 chat pop-outs')
  const [tw] = await liveChannels('twitch', 1)
  const [kk] = await liveChannels('kick', 1)
  const yt = await liveYtVideo()
  const env = await launch({ width: W, height: H })
  try {
    const outs = [
      ['twitch', `https://www.twitch.tv/popout/${tw}/chat?popout=`],
      ['kick', `https://kick.com/popout/${kk}/chat`],
      ...(yt ? [['youtube', `https://www.youtube.com/live_chat?v=${yt.id}&is_popout=1`]] : []),
    ]
    for (const [name, url] of outs) {
      const errs: string[] = []
      const t0 = Date.now()
      const p = await env.ctx.newPage()
      watchErrors(p, name, errs)
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      if (!(await waitPanel(p))) {
        bad(`${name} pop-out: panel never mounted`)
        await p.close()
        continue
      }
      const flowing = await rowsFlow(p, 45_000)
      // kick's hydration finishes after the first rows: give a late #418 time to land
      await sleep(10_000)
      const st: any = await panel(p)
      const look = await p.evaluate(() => {
        const input = document.getElementById('hs-mc-inputbar')?.getBoundingClientRect()
        const native = [
          ...document.querySelectorAll(
            '.chat-scrollable-area__message-container, #chatroom-messages, yt-live-chat-item-list-renderer',
          ),
        ].some((e) => (e as HTMLElement).getClientRects().length && e.getBoundingClientRect().width > 50)
        return { input: input ? Math.round(input.bottom) : -1, inputH: input ? Math.round(input.height) : 0, native }
      })
      const ring = await ringSince(p, t0)
      info(`${name}: ${JSON.stringify({ box: st.box, rows: st.rows, ...look, ring: ring.counts })}`)
      const [x, y, w, h] = st.box || [0, 0, 0, 0]
      if (x > 1 || y > 1 || w < W - 2 || h < H - 2) bad(`${name} pop-out: the panel does not fill the window`, st.box)
      else if (!flowing) bad(`${name} pop-out: chat did not flow within 45s`, st)
      else if (look.inputH < 20 || look.input > H + 1) bad(`${name} pop-out: the input bar is not on screen`, look)
      else if (look.native) bad(`${name} pop-out: the native chat shows beside the panel`)
      else ok(`${name} pop-out: fills the window, chat flows, input on screen`)
      if (errs.length) {
        bad(`${name} pop-out: page errors`, errs.slice(0, 4))
        await shot(p, `s12-${name}`)
      }
      if (ring.bad.length) bad(`${name} pop-out: overlay watchdogs fired`, ring.bad.slice(0, 6))
      await p.close()
    }
  } finally {
    await env.close()
  }
}

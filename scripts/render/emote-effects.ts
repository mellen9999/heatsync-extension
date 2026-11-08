import { PLATFORMS, errors, fail, ok } from './lib'

export async function emoteEffectsCheck(ctx: any) {
  // ── emote effects must survive reduced-motion ────────────────────────────
  // These effects follow the animateEmotes SETTING and deliberately not
  // prefers-reduced-motion — mellen's chromium runs with reduced-motion forced,
  // so any rule keyed on that media query is permanently on for him and would
  // freeze every paint and effect at frame 0.
  //
  // Read duration and iteration-count, NOT animationName: a blanket
  // reduced-motion rule does not null the name, it collapses duration to
  // 0.01ms and iterations to 1. Checking the name reports green on a frozen
  // animation. (Learned the hard way twice today — once by the site session,
  // and once here, where `--force-prefers-reduced-motion` silently did not
  // apply at all and the probe had to assert the condition was active before
  // trusting the result.)
  {
    const rp = await ctx.newPage()
    rp.on('pageerror', (e: unknown) => errors.push(`reduced-motion: ${String(e).slice(0, 300)}`))
    await rp.emulateMedia({ reducedMotion: 'reduce' })
    await rp.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const fx = await rp.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
        '<span class="hs-mc-emoji" id="plain">\u{1F525}</span>'
      msgs.appendChild(d)
      const read = (el: Element) => {
        const cs = getComputedStyle(el)
        return { dur: cs.animationDuration, iter: cs.animationIterationCount, name: cs.animationName }
      }
      const out = {
        active: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        emoji: read(d.querySelector('.hs-mc-emoji.hs-fx-party')),
        emote: read(d.querySelector('img')),
        plain: read(d.querySelector('#plain')),
      }
      d.remove()
      return out
    })
    await rp.close()

    if (!fx) fail('could not reach #hs-mc-messages to test reduced-motion')
    // Assert the CONDITION before trusting the result — a probe that silently
    // ran without reduced-motion would pass while proving nothing.
    if (!fx.active) fail('reduced-motion emulation did not apply — this check would prove nothing')
    for (const [what, m] of [['emoji', fx.emoji], ['emote', fx.emote]] as const) {
      if (!/^\d/.test(m.dur) || Number.parseFloat(m.dur) < 1) {
        fail(`${what} effect collapsed under reduced-motion: duration ${m.dur} (expected the real 1.5s)`)
      }
      if (m.iter !== 'infinite') {
        fail(`${what} effect collapsed under reduced-motion: iterations ${m.iter} (expected infinite)`)
      }
    }
    if (fx.plain.name !== 'none') fail(`an unmodified emoji picked up an animation (${fx.plain.name})`)
    ok(`emote effects survive reduced-motion (${fx.emoji.dur} x ${fx.emoji.iter}, unmodified emoji clean)`)
  }

  // ── the OFF switch must reach everything the effect does ─────────────────
  // animateEmotes is the first-party control for this motion. Its rules were
  // img-scoped while the effects themselves reach emoji, so setting it to
  // "never" left emoji still moving — a control that does not cover what it
  // claims to is worse than no control at all.
  {
    const ap = await ctx.newPage()
    await ap.goto(PLATFORMS[0].url, { waitUntil: 'domcontentloaded' })
    await ap.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    const sw = await ap.evaluate(() => {
      const msgs = document.getElementById('hs-mc-messages')
      if (!msgs) return null
      const d = document.createElement('div')
      d.className = 'hs-mc-msg'
      d.innerHTML =
        '<span class="hs-mc-emoji hs-fx-party">\u{1F525}</span>' +
        '<img class="hs-mc-emote hs-fx-party" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
      msgs.appendChild(d)
      const read = () => ({
        emoji: getComputedStyle(d.querySelector('.hs-mc-emoji') as Element).animationName,
        emote: getComputedStyle(d.querySelector('img') as Element).animationName,
      })
      const prev = document.documentElement.dataset.hsEmoteAnim
      const on = read()
      document.documentElement.dataset.hsEmoteAnim = 'never'
      const off = read()
      if (prev) document.documentElement.dataset.hsEmoteAnim = prev
      else document.documentElement.removeAttribute('data-hs-emote-anim')
      d.remove()
      return { on, off }
    })
    await ap.close()
    if (!sw) fail('could not reach #hs-mc-messages to test the animation switch')
    if (sw.on.emoji === 'none' || sw.on.emote === 'none') {
      fail(`effects are not running by default (emoji ${sw.on.emoji}, emote ${sw.on.emote})`)
    }
    if (sw.off.emote !== 'none') fail(`animateEmotes:never did not stop an emote (${sw.off.emote})`)
    if (sw.off.emoji !== 'none') {
      fail(`animateEmotes:never did not stop an EMOJI (${sw.off.emoji}) — the control is img-scoped again`)
    }
    ok('animateEmotes:never stops both an emote and an emoji')
  }
}

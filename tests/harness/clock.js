// virtual clock for the service-worker harness: setTimeout/setInterval/Date/performance
// all read ONE clock that only moves when a test says so. alarms ride the same queue,
// so advancing 90s runs the 90s alarm and every timer in between, in due order.

const macrotask = () => new Promise((r) => setImmediate(r))

/**
 * @param {number} start epoch ms the clock starts at
 * @param {{ busy: () => boolean }} [probe] reports work still in flight (fetches); settle() waits it out
 */
export function createClock(start, probe = { busy: () => false }) {
  let now = start
  let seq = 0
  let activity = 0
  let disposed = false
  /** @type {Map<number, {id:number, due:number, seq:number, every:number|null, fn:Function}>} */
  const timers = new Map()

  const nextDue = () => {
    let best = null
    for (const t of timers.values()) {
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t
    }
    return best
  }

  const clock = {
    now: () => now,
    /** bump when fake chrome/net does something, so settle() knows the world is still moving */
    touch() {
      activity++
    },
    /** timers still waiting (alarms excluded — they register under their own id space) */
    pending: () => [...timers.values()].map((t) => ({ id: t.id, due: t.due, every: t.every })),
    schedule(fn, ms, every = null) {
      const delay = Math.max(0, Number(ms) || 0)
      const id = ++seq
      if (disposed) return id
      timers.set(id, { id, due: now + delay, seq: id, every: every == null ? null : Math.max(1, every), fn })
      activity++
      return id
    },
    clear(id) {
      timers.delete(id)
    },
    /** let every promise continuation (and in-flight fake fetch) run until nothing new is happening */
    async settle(maxTurns = 200) {
      for (let i = 0; i < maxTurns; i++) {
        const before = activity
        await macrotask()
        if (activity === before && !probe.busy()) return
      }
      throw new Error(
        'harness: settle() never went quiet — something is spinning (a promise loop or a fetch that never resolves)',
      )
    },
    /** move time forward, firing timers/alarms in due order and draining promises after each */
    async advance(ms) {
      const target = now + ms
      await clock.settle()
      for (;;) {
        const t = nextDue()
        if (!t || t.due > target) break
        now = Math.max(now, t.due)
        if (t.every == null) timers.delete(t.id)
        else {
          t.due = now + t.every
          t.seq = ++seq
        }
        try {
          t.fn()
        } catch (e) {
          // a throwing timer callback must not stop the clock (the browser logs it and moves on)
          clock.thrown.push(e)
        }
        await clock.settle()
      }
      now = target
      await clock.settle()
    },
    /** the worker is gone: drop every timer and refuse new ones, so no callback can ever run again */
    dispose() {
      timers.clear()
      disposed = true
    },
    /** errors thrown synchronously from timer callbacks (test can assert it stays empty) */
    thrown: [],
  }
  return clock
}

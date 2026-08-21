// Globals that exist at runtime but that tsc cannot see from a single file.
// Declared so `bun run typecheck:signal` reports only names that are genuinely
// missing — a signal buried in known-good noise is a signal nobody reads.

// Build-time defines. esbuild substitutes them when packaging; an unminified
// dev build leaves them free, which is why every use site is typeof-guarded.
declare const __HS_DEV_BUILD__: boolean
declare const __HS_HOST__: 'twitch' | 'kick' | 'youtube'

// chrome/shared-utils.js assigns window.HS and the manifest loads it before
// every consumer in the same isolated world, so the bare name resolves.
declare const HS: any

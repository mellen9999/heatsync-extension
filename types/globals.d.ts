// Ambient declarations for the cross-module globals heatsync attaches to `window`.

// Firefox WebExtensions API — present in Firefox content scripts, absent in Chrome.
// Declared as optional so `typeof browser !== 'undefined'` guards work correctly.
declare var browser: typeof chrome | undefined
// The build concatenates src/lib/*.js into each content-script IIFE; these files
// publish their public surface on `window.*` so multichat/chrome layers can reach
// them without ESM imports. Typed loosely on purpose — tightening to the real
// shapes is phase-2 work once more lib files opt into `// @ts-check`.

interface Window {
  heatsyncApi?: unknown
  heatsyncCleanup?: unknown
  heatsyncConfig?: unknown
  heatsyncSettingsSchema?: unknown
  heatsyncUtils?: unknown
  /** runtime perf trace flag — set to true at devtools to enable */
  __hsPerfTrace?: boolean
  /** ring-buffer of slow callback records (capped at 200) */
  __hsPerfLog?: Array<{ kind: string; ms: number; dur: number; at: number; src: string }>
  /** error reporter singleton guard */
  __hsErrorReporter?: {
    capture?: (rec: Record<string, unknown>) => void
    flush?: () => void
    ver?: string
    plat?: string
  }
  /** runtime diagnostics console handle (src/lib/diag.js) */
  __hsDiag?: {
    snapshot: () => { selectors: Record<string, unknown>; swallowed: Record<string, number> }
    verbose: (on: boolean) => boolean
  }
  /** when true, swallow() writes named catch-sites into the error ring buffer */
  __hsDiagVerbose?: boolean
  /** install guard for the host-page securitypolicyviolation listener */
  __hsCspWatch?: boolean
  /** dedup flag for ctx-death page reload */
  __heatsyncReloadScheduled?: boolean
  /** debug flag (set via localStorage heatsync_debug=true) */
  HEATSYNC_DEBUG?: boolean
}

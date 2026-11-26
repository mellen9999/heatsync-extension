// The synced-settings catalog as data: what every other app must know about which settings follow the
// account. Built from the registry (src/lib/settings-schema.js) and the key lists (src/lib/utils.js), so it
// can never be a second opinion: shared/settings-sync.vectors.json is this, written to a file, and
// tests/settings-sync-vectors.test.js fails when the two differ. Regenerate with
//   bun scripts/dump-settings-sync-vectors.js shared/settings-sync.vectors.json
// then copy the file over the site's shared/ copy and append its sha256 to the site's .history ledger.
import { SETTINGS } from '../../src/lib/settings-schema.js'
import { DEVICE_LOCAL_KEYS, LARGE_KEY_SYNC_MAX, RETIRED_UI_KEYS, UI_SYNC_BLOCKLIST } from '../../src/lib/utils.js'

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function entry(d) {
  const e = { type: d.type, scope: d.scope, default: d.default }
  if (d.type === 'enum' || d.type === 'multiselect' || d.type === 'boolmap') e.options = d.options.map((o) => o.value)
  if (d.type === 'range') {
    e.min = d.options.min
    e.max = d.options.max
  }
  if (d.maxLen !== undefined) e.maxLen = d.maxLen
  return e
}

export function syncCatalog() {
  const synced = {}
  for (const d of [...SETTINGS].filter((d) => d.scope !== 'local').sort((a, b) => byKey(a.key, b.key))) {
    synced[d.key] = entry(d)
  }
  return {
    synced,
    local: SETTINGS.filter((d) => d.scope === 'local').map((d) => d.key).sort(byKey),
    retired: [...RETIRED_UI_KEYS].sort(byKey),
    deviceLocal: [...DEVICE_LOCAL_KEYS].sort(byKey),
    largeKeys: [...UI_SYNC_BLOCKLIST].filter((k) => !DEVICE_LOCAL_KEYS.has(k)).sort(byKey),
    largeKeyMax: LARGE_KEY_SYNC_MAX,
  }
}

const ABOUT = [
  'which settings follow the heatsync account, and the shape each one takes. one file for every app.',
  'synced: every setting that rides the account, by its storage key. type, scope (sync, or local-mirror = too big for the browser sync store, still sent to the account), default, and options (enum, multiselect, boolmap: the allowed values or sub-keys), min and max (range), maxLen (text, json).',
  'local: settings that stay on one device and never ride the account (a per-device switch such as the install check-in). an app must not send or adopt one.',
  'retired: keys the ext cut. old builds and old account blobs still carry them; an app must never adopt one from the account and must not write one.',
  'deviceLocal: keys the account refuses outright (the server rejects a patch that holds one). largeKeys: keys over the browser sync quota that ride the account alone, each capped at largeKeyMax characters; a bigger value stays on the device.',
  'an app carries a subset: each key it syncs must be in synced with the type and shape it writes, with the default it assumes, and never in local, retired or deviceLocal. a runner that meets a type it does not know must fail, never skip.',
]

export function catalogText() {
  const c = syncCatalog()
  const line = (v) => JSON.stringify(v)
  const rows = Object.entries(c.synced).map(([k, v]) => `    ${line(k)}: ${line(v)}`)
  return [
    '{',
    `  "about": [\n${ABOUT.map((a) => `    ${line(a)}`).join(',\n')}\n  ],`,
    `  "synced": {\n${rows.join(',\n')}\n  },`,
    `  "local": ${line(c.local)},`,
    `  "retired": ${line(c.retired)},`,
    `  "deviceLocal": ${line(c.deviceLocal)},`,
    `  "largeKeys": ${line(c.largeKeys)},`,
    `  "largeKeyMax": ${c.largeKeyMax}`,
    '}',
    '',
  ].join('\n')
}

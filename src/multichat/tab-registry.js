/**
 * The one list of tabs the strip owns.
 *
 * Seven copies of "which ids are reserved" used to live in channel-mgmt, main
 * and input, and drifted whenever a tab was added. Each entry is one cell:
 * `bar` says where the button renders ('scroll' = the tab strip, 'util' = the
 * right-hand cluster, absent = no button of its own), `hiddenByDefault` seeds
 * fresh installs, `restorable` = survives a reload, `util` = a button that
 * shares the tab class but is no page. Surfaces live here as cells, not as
 * hand-mounted overlays: a slash command, hotkey or right-click is a shortcut
 * TO a cell (switchTab(tab, sub)), never the only door.
 */
// Cells of a channel tab (and live): the first is home. summary / logs /
// status are full surfaces that used to be a links item, a message right-click
// and a slash overlay; each is now a cell, the old entries are shortcuts to it.
const MC_CHANNEL_SUB = [
  { id: 'chat', label: 'chat' },
  { id: 'summary', label: 'summary' },
  { id: 'logs', label: 'logs' },
  { id: 'status', label: 'status' },
]

const MC_TABS = [
  {
    id: 'feed',
    labelKey: 'mc_tab_feed',
    bar: 'scroll',
    restorable: true,
    sub: [
      { id: 'feed', label: 'feed' },
      { id: 'discover', label: 'discover' },
    ],
  },
  { id: 'whispers', labelKey: 'mc_tab_whispers', bar: 'scroll', hiddenByDefault: true, restorable: true },
  { id: 'mentions', labelKey: 'mc_tab_mentions', bar: 'scroll', hiddenByDefault: true, restorable: true },
  { id: 'pinned', labelKey: 'mc_tab_pinned', bar: 'scroll', hiddenByDefault: true, restorable: true },
  { id: 'modlog', labelKey: 'mc_tab_modlog', bar: 'scroll', hiddenByDefault: true, restorable: true },
  { id: 'live', labelKey: 'mc_tab_live', bar: 'scroll', restorable: true, sub: MC_CHANNEL_SUB },
  { id: 'add', label: '+', bar: 'scroll', restorable: true },
  // a cell of feed that keeps its own internal id (renderers key on it)
  { id: 'discover', cellOf: 'feed', restorable: true },
  { id: 'settings', bar: 'util' },
  { id: 'popout', util: true },
  { id: 'collapse', util: true },
  { id: 'native', util: true },
  { id: 'actions', util: true },
  { id: 'subscribe', util: true },
]

/** ids a channel may never take (every page tab, not the utility buttons) */
function mcReservedTabIds() {
  return MC_TABS.filter((tab) => !tab.util).map((tab) => tab.id)
}

function mcIsReservedTab(id) {
  return mcReservedTabIds().includes(id)
}

/** every id that is chrome, page or button — anything else is a channel tab */
function mcChromeTabIds() {
  return MC_TABS.map((tab) => tab.id)
}

function mcDefaultHiddenTabs() {
  return MC_TABS.filter((tab) => tab.hiddenByDefault).map((tab) => tab.id)
}

function mcRestorableTabs() {
  return MC_TABS.filter((tab) => tab.restorable).map((tab) => tab.id)
}

/** the 2nd-row cells of a tab: its own `sub`, or a channel tab's shared set */
function mcSubCells(tabId) {
  const tab = MC_TABS.find((t) => t.id === tabId)
  if (tab?.cellOf) return mcSubCells(tab.cellOf)
  if (tab) return tab.sub || []
  return tabId ? MC_CHANNEL_SUB : []
}

/**
 * Which cell opens: the one asked for, else the one last used on this tab,
 * else the first. null when the tab has no 2nd row.
 */
function mcResolveSub(tabId, sub, lastByTab) {
  if (MC_TABS.find((t) => t.id === tabId)?.cellOf) return tabId
  const cells = mcSubCells(tabId)
  if (!cells.length) return null
  if (sub && cells.some((c) => c.id === sub)) return sub
  const last = lastByTab?.[tabId]
  if (last && cells.some((c) => c.id === last)) return last
  return cells[0].id
}

/** the tab whose button/row owns this id (discover lives under feed) */
function mcRowOwner(tabId) {
  return MC_TABS.find((t) => t.id === tabId)?.cellOf || tabId
}

/**
 * A cell that has its own internal tab id is addressed two ways: feed › discover
 * and the id 'discover'. Fold both to the internal one, so every opener can
 * say switchTab(tab, sub) and land on the same place.
 */
function mcCanonTab(id, sub) {
  const own = MC_TABS.find((t) => t.id === id)
  if (sub && MC_TABS.some((t) => t.cellOf === id && t.id === sub)) return { id: sub, sub: undefined }
  if (own?.cellOf && sub === own.cellOf) return { id: own.cellOf, sub: undefined }
  return { id, sub }
}

/** the (tab, cell) address of an id — what a shortcut passes to switchTab */
function mcCellAddress(id) {
  const own = MC_TABS.find((t) => t.id === id)
  return own?.cellOf ? { tab: own.cellOf, sub: id } : { tab: id, sub: undefined }
}

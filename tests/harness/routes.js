// the answers a healthy heatsync.org (and the few third-party apis the worker polls at boot) gives:
// empty but well-formed. with these the worker boots down its happy path, so a test that is about
// the websocket does not also have to be about a failed inventory fetch. every one is the LOWEST
// priority route: a test's own sw.net.on(...) beats it. bootSw({ healthy: false }) leaves them out.

import { json } from './fake-net.js'

const HS = 'https://heatsync.org'

export const healthyRoutes = [
  [new RegExp(`^${HS}/api/emotes(\\?|$)`), { emotes: [] }],
  [new RegExp(`^${HS}/api/user/emotes(\\?|$)`), { emotes: [] }],
  [`${HS}/api/user/emotes/blocked`, { blocked_emotes: [] }],
  [`${HS}/api/emotes/twitch/global`, { emotes: [] }],
  ['https://7tv.io/v3/emote-sets/global', { emotes: [] }],
  [`${HS}/api/user/following`, { following: [] }],
  [`${HS}/api/live/following`, { streams: [] }],
  [`${HS}/api/user/blocks`, { blocked_users: [] }],
  [`${HS}/api/mutes`, { mutes: [] }],
  [`${HS}/api/notifications`, { count: 0 }],
  [`${HS}/api/user/settings`, {}],
  [`${HS}/api/chatterino-badges`, []],
  [`${HS}/api/auth/me`, { id: 1, username: 'harness', display_name: 'harness', twitch_username: 'harness' }],
  [
    new RegExp(`^${HS}/api/extension/health`),
    { v: 1, ext_min: '0.0.0', ext_hard_min: null, kill: false, disabled: [], msg: null },
  ],
  ['https://api.betterttv.net/3/cached/badges', []],
  ['https://api.frankerfacez.com/v1/badges/ids', () => json({ badges: [], users: {} })],
]

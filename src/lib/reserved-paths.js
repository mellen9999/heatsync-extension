// Single source of truth for "this URL path segment is never a channel."
//
// Before this file, the same idea existed as a dozen divergent, hand-drifted
// copies: src/multichat/main.js (NON_CHANNEL_PATHS, KICK_RESERVED_PATHS, and
// a third kick nav-capture `reserved` set), chrome/content.js
// (TWITCH_EXCLUDED_PATHS plus four more inline excluded/kickExcluded
// literals), chrome/heatsync-button.js (twitch+kick literals),
// chrome/early-layout.js (twitch+kick literals), chrome/background.js
// (BG_NON_CHANNEL_PATHS plus a `skip` set in get_watching_channels), and
// chrome/popup.js (twitch+kick literals). Divergence let real garbage slugs
// (kick.com/video/<id>, 'moderator', 'videos') get treated as channel names —
// persisted into joined_extra_channels, IRC-joined, given ghost tabs. This is
// the union of every one of those copies plus the platform-reserved paths
// none of them had (video, following, u, moderator, videos, login, p, search
// were each missing from at least one copy).
//
// One list for every platform on purpose: a kick-only reserved word being
// also rejected on twitch (or vice versa) costs nothing — none of these are
// real channel names on either platform — and a single shared Set is the only
// way nine copies don't drift back apart. Callers lowercase before `.has()`.
export const RESERVED_PATHS = new Set([
  'about',
  'accessibility',
  'activate',
  'admin',
  'agency',
  'agent',
  'api',
  'auth',
  'authorize',
  'bits',
  'blog',
  'broadcast',
  'browse',
  'bug',
  'careers',
  'categories',
  'category',
  'checkout',
  'clip',
  'clips',
  'collections',
  'community',
  'company',
  'contact',
  'dashboard',
  'directory',
  'dmca',
  'downloads',
  'drops',
  'embed',
  'feedback',
  'following',
  'friends',
  'games',
  'help',
  'inventory',
  'jobs',
  'kickbot',
  'leaderboards',
  'login',
  'logout',
  'messages',
  'moderation',
  'moderator',
  'notifications',
  'oauth',
  'oauth2',
  'p',
  'partner',
  'partners',
  'password',
  'popout',
  'press',
  'prime',
  'privacy',
  'products',
  'profile',
  'redeem',
  'referrals',
  'responsible-disclosure',
  'rules',
  'schedule',
  'search',
  'settings',
  'signup',
  'store',
  'subs',
  'subscriptions',
  'support',
  'team',
  'teams',
  'terms',
  'turbo',
  'turbo-faq',
  'u',
  'vault',
  'verify',
  'video',
  'videos',
  'vip',
  'vods',
  'wallet',
])

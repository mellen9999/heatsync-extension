// @ts-check
// Relative import, same pattern as paint-spec.js: the build's stripExports
// removes this line and relies on font-grid.js being concatenated before this
// file (see readLib in build.js), while `bun test` imports it for real.
import { ALL_SIZES, sizesFor } from './font-grid.js'

// settings registry — every multichat setting as one declarative entry.
// pure data + pure validators only: no DOM, no chrome.*, no i18n calls.
// bundled at IIFE scope (build.js lib list) so main.js, every multichat
// module, and content.js read the same catalog; bun tests import it.
//
// entry fields:
//   key        EXACT storage key — never rename, existing users' synced
//              data lives under these names
//   type       'bool' | 'enum' | 'range' | 'text' | 'multiselect' | 'boolmap' | 'json'
//              boolmap = one storage key holding {subkey: bool} (the
//              inlineNotifs / hermesEvents nested savers); options list the
//              subkeys, each with {value, default, color, tag?, label(/Key)?,
//              tip(/Key)?}; coercion merges partial stored maps over default
//              json = structured array/object stored raw (state blobs like
//              customPresets); validated as JSON-serializable, size-capped
//              via maxLen (stringified length)
//   default    value assumed when storage is empty; written by reset
//   scope      'sync'         → ui_settings.<key> in chrome.storage.sync
//              'local'        → chrome.storage.local.<key> (per-device)
//              'local-mirror' → saveUiSetting() splits to local via
//                               UI_SYNC_BLOCKLIST; mirrorKey names the
//                               actual local storage key
//   category   settings subtab id (display|chat|notifs|mod|filters|tweaks|system)
//   section    group title within the subtab (sectionKey when i18n'd)
//   label/tip  literal lowercase strings — or labelKey/tipKey when the
//              string is i18n'd (renderer resolves via t(); not available here)
//   control    'pill' | 'select' | 'sizebtns' | 'range' | 'text' | 'textarea' | 'custom'
//   options    [{value,label|labelKey}] for enum/multiselect;
//              {min,max,step} for range
//   basic      true → row shows in the default "basic" settings view. Absent =
//              only under "all". Search always covers every row regardless.
//   alias      extra search keywords (originally the legacy data-setting
//              attribute names) — fed into the settings search haystack
//   dependsOn  {key, equals?} — row hidden unless the named setting matches
//              (equals omitted = truthy)
//   runtimeVar legacy module-level var name bridged by main.js _RUNTIME_BRIDGE
//   apply      id into main.js _APPLIERS — side-effect run on set
//   applyOnLoad  also run the applier once during loadAllSettings hydration
//   syncSilent   skip the applier on REMOTE (cross-tab/device) changes —
//              for set-time-only effects like the volume preview ping
//   rerender   true → re-render chat messages after a change
//   rerenderSettings  true → re-render the settings panel after a change
//   migrate    one-shot guard key in ui_settings (default-flip migrations)
//   legacy     (ui, local) → value | undefined — pull from a retired key
//              when this entry's own storage is empty
//   legacySyncFallback  local-mirror only: hydrate from the old sync copy
//              (and persist to local) when the local key is empty
//   firstRunPersist  local only: persist the default on first load so
//              other surfaces (options page) render the real state
//   invertDisplay    multiselect of hidden ids rendered as "visible" pills
//   maxLen     string cap for text/textarea
//   placeholder/placeholderKey  textarea placeholder
//   displayScale  range only: UI shows value × scale (storage stays raw)
//   tweak      true → twitch-ui-noise CSS-hide flag; content.js
//              applyUiSettings() owns the actual hide rules
//   noReset    excluded from resetSettingsToDefaults (server-coupled prefs)
//   reloadApply  value fully applies only after a page reload — renderer
//              shows a [reload] chip when current differs from boot
//   cw         {stateKey, serverBody, noun} — per-viewer content-warning
//              filter: local bool + server PATCH /api/user/settings with
//              rollback; main.js derives CW_CATS from these

/**
 * @typedef {{ value: *, label?: string, labelKey?: string, tip?: string, tipKey?: string, default?: boolean, tag?: string, color?: string, borderColor?: string, applies?: 'live'|'reload' }} SettingOption
 */

/**
 * @typedef {Object} SettingDef
 * @property {string} key EXACT storage key — never rename
 * @property {'bool'|'enum'|'range'|'text'|'multiselect'|'boolmap'|'json'} type
 * @property {*} default
 * @property {'sync'|'local'|'local-mirror'} scope
 * @property {string} category settings subtab id
 * @property {string} [section] group title ([sectionKey] when i18n'd)
 * @property {string} [sectionKey] i18n key for section title
 * @property {string} [label] lowercase literal
 * @property {string} [labelKey] i18n key for label
 * @property {string} [tip] hover tooltip
 * @property {string} [tipKey] i18n key for tip
 * @property {'pill'|'select'|'sizebtns'|'range'|'text'|'textarea'|'custom'} [control]
 * @property {SettingOption[]|{min:number,max:number,step:number}} [options]
 * @property {(get: (key: string) => any) => SettingOption[]} [optionsFor]
 *   Render-time narrowing of `options` for the CURRENT settings state — used by
 *   fontSize so a bitmap family only offers the sizes it has. `options` stays
 *   the static union because validate/coerce/lint read it with no state in hand.
 * @property {boolean} [basic] show in the default (basic) settings view
 * @property {string} [alias] extra search keywords
 * @property {{key:string,equals?:*}} [dependsOn]
 * @property {string} [runtimeVar] legacy module var bridged in main.js
 * @property {string} [apply] id into main.js _APPLIERS
 * @property {boolean} [applyOnLoad]
 * @property {boolean} [syncSilent] skip applier on remote cross-tab changes
 * @property {boolean} [rerender]
 * @property {boolean} [rerenderSettings]
 * @property {string} [migrate] one-shot default-flip guard key
 * @property {function(Object,Object):*} [legacy] retired-key migration
 * @property {function(*):*} [coerce] same-key type migration, runs pre-coercion
 * @property {boolean} [legacySyncFallback]
 * @property {boolean} [firstRunPersist]
 * @property {boolean} [invertDisplay]
 * @property {number} [maxLen]
 * @property {string} [placeholder]
 * @property {string} [placeholderKey]
 * @property {string} [mirrorKey] local-mirror storage key
 * @property {boolean} [tweak]
 * @property {boolean} [noReset]
 * @property {boolean} [reloadApply]
 * @property {number} [displayScale]
 * @property {{stateKey:string,serverBody:string,noun:string}} [cw]
 */

/** @type {SettingDef[]} */
const SETTINGS = [
  // ── display — the headline toggle first ──────────────────────────────

  // ── display / font ────────────────────────────────────────────────────
  {
    key: 'fontFamily',
    type: 'enum',
    default: 'CozetteVector',
    scope: 'sync',
    category: 'display',
    section: 'font',
    labelKey: 'mc_settings_font_family',
    tipKey: 'mc_settings_font_family_desc',
    control: 'select',
    alias: 'fontfamily',
    apply: 'fonts',
    applyOnLoad: true,
    rerenderSettings: true,
    options: [
      { value: 'CozetteVector', label: 'CozetteVector (13px)' },
      { value: 'monospace', label: 'system monospace' },
      { value: 'twitch', label: 'platform default (Inter — twitch + kick)' },
      { value: 'custom', label: 'custom...' },
    ],
  },
  {
    key: 'customFontName',
    type: 'text',
    default: '',
    scope: 'sync',
    category: 'display',
    section: 'font',
    labelKey: 'mc_settings_custom_font_name',
    control: 'text',
    alias: 'customfontname',
    apply: 'fonts',
    applyOnLoad: true,
    maxLen: 64,
    dependsOn: { key: 'fontFamily', equals: 'custom' },
  },
  {
    key: 'fontSize',
    basic: true, // day-one row — shows in the default (basic) settings view
    // enum, not range: a bitmap face has SIZES, not a continuum. The old
    // continuous 10-26 slider offered CozetteVector one legal size and fifteen
    // smears. `options` is the static UNION of every size any family may hold —
    // validateSettingValue/coerceSettingValue/lint read it directly and have no
    // access to the current family — and `optionsFor` narrows it to the
    // selected family at render time. See src/lib/font-grid.js.
    type: 'enum',
    default: 13,
    scope: 'sync',
    category: 'display',
    section: 'font',
    labelKey: 'mc_settings_font_size',
    tipKey: 'mc_settings_font_size_desc',
    alias: 'fontsize',
    apply: 'fonts',
    applyOnLoad: true,
    control: 'sizebtns',
    options: ALL_SIZES.map((px) => ({ value: px, label: `${px}px` })),
    optionsFor: (get) => sizesFor(get('fontFamily')).map((px) => ({ value: px, label: `${px}px` })),
  },

  // ── display / display ─────────────────────────────────────────────────
  {
    key: 'hs_emote_size',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'enum',
    default: 1,
    scope: 'local',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_emote_size',
    tipKey: 'mc_settings_emote_size_desc',
    control: 'sizebtns',
    runtimeVar: 'emoteSize',
    apply: 'emoteSize',
    applyOnLoad: true,
    alias: 'native chat emote scale',
    options: [
      { value: 1, label: '1x' },
      { value: 2, label: '2x' },
      { value: 4, label: '4x' },
    ],
  },
  {
    key: 'hs_emoji_size',
    type: 'enum',
    default: 2,
    scope: 'local',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_emoji_size',
    tipKey: 'mc_settings_emoji_size_desc',
    control: 'sizebtns',
    runtimeVar: 'emojiSize',
    apply: 'emojiSize',
    applyOnLoad: true,
    legacy: (ui) => (ui.bigEmoji === false ? 1 : undefined),
    options: [
      { value: 1, label: '1x' },
      { value: 2, label: '2x' },
      { value: 4, label: '4x' },
    ],
  },
  {
    key: 'timestamps',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_timestamps',
    tipKey: 'mc_settings_timestamps_desc',
    control: 'pill',
    alias: 'timestamps',
    runtimeVar: 'timestampsEnabled',
    rerender: true,
  },
  {
    key: 'timestampFormat',
    type: 'enum',
    default: '24h',
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_timestamp_format',
    tipKey: 'mc_settings_timestamp_format_desc',
    control: 'sizebtns',
    rerender: true,
    dependsOn: { key: 'timestamps' },
    options: [
      { value: '24h', label: '24h' },
      { value: '12h', label: '12h' },
    ],
  },
  {
    key: 'avatars',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_show_avatars',
    tipKey: 'mc_settings_avatars_desc',
    control: 'pill',
    alias: 'avatars',
    runtimeVar: 'avatarsEnabled',
    rerender: true,
  },
  {
    key: 'zebra',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_zebra',
    tipKey: 'mc_settings_zebra_desc',
    control: 'pill',
    alias: 'zebra',
    runtimeVar: 'zebraEnabled',
    rerender: true,
  },
  {
    key: 'hs_readable_names',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_readable_names',
    tipKey: 'mc_settings_readable_names_desc',
    control: 'pill',
    alias: 'readablenames',
    runtimeVar: 'readableNamesEnabled',
    rerender: true,
  },
  {
    key: 'firstChatterGlow',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_first_chatter',
    tipKey: 'mc_settings_first_chatter_desc',
    control: 'pill',
    alias: 'firstchatter',
    runtimeVar: 'firstChatterGlow',
    rerender: true,
  },
  {
    key: 'autoHideEmpty',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_auto_hide',
    tipKey: 'mc_settings_auto_hide_desc',
    control: 'pill',
    alias: 'autohide',
    runtimeVar: 'autoHideInput',
    apply: 'autoHide',
  },
  {
    key: 'showPlatformBadges',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_platform_badges',
    tipKey: 'mc_settings_platform_badges_desc',
    control: 'pill',
    alias: 'showplatformbadges',
    runtimeVar: 'platformBadgesEnabled',
    rerender: true,
  },
  {
    key: 'textBadges',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'display',
    section: 'chat messages',
    labelKey: 'mc_settings_text_badges',
    tipKey: 'mc_settings_text_badges_desc',
    control: 'pill',
    alias: 'textbadges',
    runtimeVar: 'textBadgesEnabled',
    rerender: true,
  },

  // ── display / layout ──────────────────────────────────────────────────
  // Written by the rotate buttons too — registry + buttons share one
  // setSetting write path. chatPosition includes 'hidden' (the \\ toggle
  // stores it) so hydration never un-hides a deliberately hidden chat.
  {
    key: 'tabPosition',
    type: 'enum',
    default: 'top',
    scope: 'sync',
    category: 'display',
    section: 'layout',
    labelKey: 'mc_settings_tab_position',
    tipKey: 'mc_settings_tab_position_desc',
    control: 'sizebtns',
    runtimeVar: 'tabPosition',
    apply: 'tabPosition',
    rerender: true,
    options: [
      { value: 'top', label: 'top' },
      { value: 'right', label: 'right' },
      { value: 'bottom', label: 'bottom' },
      { value: 'left', label: 'left' },
    ],
  },
  {
    key: 'chatPosition',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'enum',
    default: 'right',
    scope: 'sync',
    category: 'display',
    section: 'layout',
    labelKey: 'mc_settings_chat_position',
    tipKey: 'mc_settings_chat_position_desc',
    control: 'sizebtns',
    runtimeVar: 'chatPosition',
    apply: 'chatPosition',
    options: [
      { value: 'right', label: 'right' },
      { value: 'bottom', label: 'bottom' },
      { value: 'left', label: 'left' },
      { value: 'top', label: 'top' },
      { value: 'hidden', label: 'hidden' },
    ],
  },
  {
    key: 'ytShowSuggestions',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'display',
    section: 'layout',
    labelKey: 'mc_settings_yt_suggestions',
    tipKey: 'mc_settings_yt_suggestions_desc',
    control: 'pill',
    apply: 'ytSuggestions',
    applyOnLoad: true,
  },
  {
    key: 'ytChatOnNonLive',
    type: 'bool',
    default: true,
    // default flipped false→true (chat on all YT pages); one-shot migration
    // so installs with a materialized `false` in the sync blob adopt the new
    // default once — opting out afterwards sticks (guard key stamped)
    migrate: 'ytChatOnNonLiveOn_v1',
    scope: 'sync',
    category: 'display',
    section: 'layout',
    labelKey: 'mc_settings_yt_chat_non_live',
    tipKey: 'mc_settings_yt_chat_non_live_desc',
    control: 'pill',
    apply: 'ytNonLiveChat',
    applyOnLoad: true,
  },

  // ── display / density ─────────────────────────────────────────────────
  {
    key: 'messageDensity',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'enum',
    default: 'compact',
    scope: 'sync',
    category: 'display',
    section: 'density',
    labelKey: 'mc_settings_message_density',
    tipKey: 'mc_settings_message_density_desc',
    control: 'sizebtns',
    apply: 'density',
    applyOnLoad: true,
    options: [
      { value: 'compact', label: 'compact' },
      { value: 'cozy', label: 'cozy' },
    ],
  },
  {
    key: 'lineHeight',
    type: 'enum',
    default: '18',
    scope: 'sync',
    category: 'display',
    section: 'density',
    labelKey: 'mc_settings_line_height',
    tipKey: 'mc_settings_line_height_desc',
    control: 'sizebtns',
    apply: 'density',
    applyOnLoad: true,
    options: [
      { value: '18', label: '18' },
      { value: '22', label: '22' },
      { value: '26', label: '26' },
    ],
  },
  {
    key: 'hs_dom_render_cap',
    type: 'range',
    default: 500,
    scope: 'local',
    category: 'display',
    section: 'density',
    labelKey: 'mc_settings_max_visible_messages',
    tipKey: 'mc_settings_max_visible_messages_desc',
    control: 'range',
    runtimeVar: 'domRenderCap',
    apply: 'renderCap',
    options: { min: 100, max: 1500, step: 100 },
  },

  // ── display / cosmetics (per-provider) ────────────────────────────────
  {
    key: 'showNamePaints',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_name_paints',
    tipKey: 'mc_settings_name_paints_desc',
    control: 'pill',
    rerender: true,
    apply: 'namePaints',
  },
  {
    key: 'sevenTvPaints',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_seventv_paints',
    tipKey: 'mc_settings_seventv_paints_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'bttvBadges',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_bttv_badges',
    tipKey: 'mc_settings_bttv_badges_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'ffzBadges',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_ffz_badges',
    tipKey: 'mc_settings_ffz_badges_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'animateEmotes',
    type: 'enum',
    default: 'always',
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_animate_emotes',
    tipKey: 'mc_settings_animate_emotes_desc',
    control: 'sizebtns',
    runtimeVar: 'emoteAnimationMode',
    apply: 'emoteAnimation',
    // Needed for the boot pass: the applier stamps data-hs-emote-anim on <html>,
    // which is what gates the hs-fx-* modifier animations in CSS. Without it the
    // attribute only appeared after the user touched the setting, so 'hover' and
    // 'never' silently behaved like 'always' on every fresh load. The applier
    // early-returns on the load pass, so no rerender is triggered here.
    applyOnLoad: true,
    // pre-1.7.16 installs stored a bool under this key — map, never drop
    coerce: (v) => (typeof v === 'boolean' ? (v ? 'always' : 'never') : v),
    options: [
      { value: 'always', label: 'always' },
      { value: 'hover', label: 'hover' },
      { value: 'never', label: 'never' },
    ],
  },
  {
    // Paint motion. Deliberately NOT gated on prefers-reduced-motion — that is
    // a browser flag rather than a per-site preference, and a chromium run with
    // --force-prefers-reduced-motion froze every paint on every page at frame 0
    // with nothing that could turn them back on. Same call already made for
    // emote modifiers above; this is the control that replaces the media query.
    // Two states, not the emote trio: 'hover' is already taken for paints and
    // means the opposite — hovering a painted name FREEZES it and flattens it
    // to a readable white chip (see ensureHsPaintSheet).
    key: 'animatePaints',
    type: 'enum',
    default: 'always',
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_animate_paints',
    tipKey: 'mc_settings_animate_paints_desc',
    control: 'sizebtns',
    apply: 'paintAnimation',
    // The applier stamps data-hs-paint-anim on <html>, which is what the paint
    // sheet gates on. Without the boot pass the attribute would only appear
    // after the user touched the setting, so 'never' would silently behave like
    // 'always' on every fresh load — the same trap animateEmotes hit.
    applyOnLoad: true,
    options: [
      { value: 'always', label: 'always' },
      { value: 'never', label: 'never' },
    ],
  },
  {
    key: 'chatterinoBadges',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_chatterino_badges',
    tipKey: 'mc_settings_chatterino_badges_desc',
    control: 'pill',
    rerender: true,
  },
  {
    // Which third-party provider wins when the same emote NAME exists in
    // more than one (7TV/BTTV/FFZ) within a channel's or the global pool.
    // Default '7tv' matches the pre-existing hardcoded winner (BTTV < FFZ <
    // 7TV last-write-wins in the merge) — picking it changes nothing.
    key: 'emoteProviderPriority',
    type: 'enum',
    default: '7tv',
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_emote_provider_priority',
    tipKey: 'mc_settings_emote_provider_priority_desc',
    control: 'select',
    runtimeVar: 'emoteProviderPriority',
    apply: 'emoteProviderPriority',
    // loadAllSettings() hydrates this var concurrently with the init-time
    // loadEmotes() call (Promise.allSettled race) — a non-default choice
    // could lose that race on cold boot. applyOnLoad forces one more
    // loadEmotes() pass strictly after hydration so the picked provider is
    // never momentarily wrong.
    applyOnLoad: true,
    options: [
      { value: '7tv', label: '7tv' },
      { value: 'bttv', label: 'bttv' },
      { value: 'ffz', label: 'ffz' },
    ],
  },
  {
    // Inventory emotes (yours and every other sender's) render as images.
    // Off = the plain word, exactly as it went over the wire. Channel/global
    // pools are unaffected — those render for the whole platform anyway.
    key: 'renderInventoryEmotes',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_render_inventory_emotes',
    tipKey: 'mc_settings_render_inventory_emotes_desc',
    control: 'pill',
    alias: 'personal inventory emotes render',
    rerender: true,
  },
  {
    key: 'hs_show_pronouns',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'display',
    section: 'cosmetics',
    labelKey: 'mc_settings_show_pronouns',
    tipKey: 'mc_settings_show_pronouns_desc',
    control: 'pill',
    runtimeVar: 'pronounsEnabled',
  },

  // ── chat / input ──────────────────────────────────────────────────────
  {
    // Whether your inventory feeds tab-complete / inline suggestions. Off, a
    // name that lives only in your inventory stops being offered; names the
    // channel or globals also define still complete.
    key: 'suggestInventoryEmotes',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'input',
    labelKey: 'mc_settings_suggest_inventory_emotes',
    tipKey: 'mc_settings_suggest_inventory_emotes_desc',
    control: 'pill',
    alias: 'personal inventory emotes tab complete autocomplete',
  },
  {
    key: 'wysiwygEnabled',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'input',
    labelKey: 'mc_settings_input_preview',
    tipKey: 'mc_settings_input_preview_desc',
    control: 'pill',
    alias: 'wysiwyg',
    runtimeVar: 'wysiwygEnabled',
    apply: 'rebuildInput',
    migrate: 'wysiwygDefaultOn_v1',
  },
  {
    key: 'viMode',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'chat',
    section: 'input',
    labelKey: 'mc_settings_vi_mode',
    tipKey: 'mc_settings_vi_mode_desc',
    control: 'pill',
    alias: 'vi',
    runtimeVar: 'viModeEnabled',
    apply: 'viMode',
  },

  // ── chat / messages ───────────────────────────────────────────────────
  {
    key: 'linksEnabled',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_clickable_links',
    tipKey: 'mc_settings_clickable_links_desc',
    control: 'pill',
    alias: 'links',
    runtimeVar: 'linksEnabled',
    rerender: true,
  },
  {
    key: 'partialLinksEnabled',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_partial_links',
    tipKey: 'mc_settings_partial_links_desc',
    control: 'pill',
    alias: 'partiallinks',
    runtimeVar: 'partialLinksEnabled',
    rerender: true,
  },
  {
    key: 'linkPreviewsEnabled',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_link_previews',
    tipKey: 'mc_settings_link_previews_desc',
    control: 'pill',
    alias: 'linkpreviews',
    runtimeVar: 'linkPreviewsEnabled',
  },
  {
    key: 'mediaEmbedsEnabled',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_media_embeds',
    tipKey: 'mc_settings_media_embeds_desc',
    control: 'pill',
    alias: 'mediaembeds',
    runtimeVar: 'mediaEmbedsEnabled',
    rerender: true,
  },
  {
    key: 'hs_auto_claim_points',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_auto_claim',
    tipKey: 'mc_settings_auto_claim_desc',
    control: 'pill',
    alias: 'autoclaim',
    runtimeVar: 'autoClaimPoints',
    apply: 'autoClaim',
    applyOnLoad: true,
    firstRunPersist: true,
  },
  {
    key: 'hs_dim_timeouts',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_dim_timeouts',
    tipKey: 'mc_settings_dim_timeouts_desc',
    control: 'pill',
    alias: 'dimtimeouts',
    runtimeVar: 'dimTimeouts',
  },
  {
    key: 'keywordHighlights',
    type: 'text',
    default: '',
    scope: 'local-mirror',
    mirrorKey: 'keyword_highlights',
    legacySyncFallback: true,
    category: 'chat',
    section: 'messages',
    labelKey: 'mc_settings_keyword_highlights',
    tipKey: 'mc_settings_keyword_highlights_desc',
    placeholderKey: 'mc_settings_keyword_highlights_placeholder',
    control: 'textarea',
    alias: 'keywordhighlights',
    runtimeVar: 'keywordHighlights',
    apply: 'keywordRegex',
    applyOnLoad: true,
    rerender: true,
    maxLen: 65536,
  },

  // ── chat / privacy ────────────────────────────────────────────────────
  {
    key: 'anonChat',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'chat',
    section: 'privacy',
    labelKey: 'mc_settings_anon_chat',
    tipKey: 'mc_settings_anon_chat_desc',
    control: 'pill',
  },

  // ── chat / native chat — the platform's own chat input + messages ─────
  // Consumed by heatsync-button.js + autocomplete-hook.js (via the
  // localStorage mirror) — same ui_settings keys the picker popup writes.

  // ── notifs / inline notifications ─────────────────────────────────────
  {
    key: 'whisperToast',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'notifs',
    section: 'whispers',
    labelKey: 'mc_settings_whisper_toast',
    tipKey: 'mc_settings_whisper_toast_desc',
    control: 'pill',
    runtimeVar: 'whisperToastEnabled',
  },
  {
    key: 'inlineNotifs',
    type: 'boolmap',
    scope: 'sync',
    category: 'notifs',
    sectionKey: 'mc_settings_inline_notifs',
    labelKey: 'mc_settings_inline_notifs',
    control: 'pill',
    runtimeVar: 'inlineNotifs',
    default: { op: true, mop: true, re: true, dm: false, moment: true },
    options: [
      {
        value: 'op',
        default: true,
        tag: '[OP]',
        color: '#ff0000',
        borderColor: '#ff0000',
        labelKey: 'mc_settings_notif_op',
        tipKey: 'mc_settings_notif_op_desc',
      },
      {
        value: 'mop',
        default: true,
        tag: '[OP]',
        color: '#ff00ff',
        borderColor: '#ff00ff',
        labelKey: 'mc_settings_notif_op_reply',
        tipKey: 'mc_settings_notif_op_reply_desc',
      },
      {
        value: 're',
        default: true,
        tag: '[RE]',
        color: '#00ffff',
        borderColor: '#00ffff',
        labelKey: 'mc_settings_notif_re',
        tipKey: 'mc_settings_notif_re_desc',
      },
      {
        value: 'dm',
        default: false,
        tag: '[DM]',
        color: '#ffff00',
        borderColor: '#ffff00',
        labelKey: 'mc_settings_notif_dm',
        tipKey: 'mc_settings_notif_dm_desc',
      },
      {
        value: 'moment',
        default: true,
        tag: '[🔥]',
        color: '#fff',
        borderColor: '#fff',
        labelKey: 'mc_settings_notif_moment',
        tipKey: 'mc_settings_notif_moment_desc',
      },
    ],
  },

  // ── notifs / stream events (twitch + youtube) ─────────────────────────
  {
    key: 'hermesEvents',
    type: 'boolmap',
    scope: 'sync',
    category: 'notifs',
    sectionKey: 'mc_settings_twitch_events',
    labelKey: 'mc_settings_twitch_events',
    control: 'pill',
    runtimeVar: 'hermesToggles',
    default: {
      online: true,
      offline: false,
      gameSwitch: true,
      raid: true,
      hype: false,
      sub: true,
      redeem: true,
      pred: true,
      poll: true,
      ytSuperchat: true,
      ytSupersticker: true,
      ytMembership: true,
      ytMilestone: true,
      ytGiftMemberships: true,
    },
    options: [
      {
        value: 'online',
        default: true,
        color: '#00ff7f',
        labelKey: 'mc_settings_evt_online',
        tipKey: 'mc_settings_evt_online_desc',
      },
      {
        value: 'offline',
        default: false,
        color: '#808080',
        labelKey: 'mc_settings_evt_offline',
        tipKey: 'mc_settings_evt_offline_desc',
      },
      {
        value: 'gameSwitch',
        default: true,
        color: '#ff00ff',
        labelKey: 'mc_settings_evt_game_switch',
        tipKey: 'mc_settings_evt_game_switch_desc',
      },
      {
        value: 'raid',
        default: true,
        color: '#9146ff',
        labelKey: 'mc_settings_raids',
        tipKey: 'mc_settings_raids_desc',
      },
      {
        value: 'hype',
        default: false,
        color: '#fff',
        labelKey: 'mc_settings_hype_trains',
        tipKey: 'mc_settings_hype_trains_desc',
      },
      {
        value: 'sub',
        default: true,
        color: '#00ff7f',
        labelKey: 'mc_settings_gift_subs',
        tipKey: 'mc_settings_gift_subs_desc',
      },
      {
        value: 'redeem',
        default: true,
        color: '#00bfff',
        labelKey: 'mc_settings_redeems',
        tipKey: 'mc_settings_redeems_desc',
      },
      {
        value: 'pred',
        default: true,
        color: '#387aff',
        labelKey: 'mc_settings_prediction_banner',
        tipKey: 'mc_settings_prediction_banner_desc',
      },
      {
        value: 'poll',
        default: true,
        color: '#00c853',
        labelKey: 'mc_settings_poll_banner',
        tipKey: 'mc_settings_poll_banner_desc',
      },
      {
        value: 'ytSuperchat',
        default: true,
        color: '#ffca28',
        labelKey: 'mc_settings_yt_superchat',
        tipKey: 'mc_settings_yt_superchat_desc',
      },
      {
        value: 'ytSupersticker',
        default: true,
        color: '#ff8a65',
        labelKey: 'mc_settings_yt_supersticker',
        tipKey: 'mc_settings_yt_supersticker_desc',
      },
      {
        value: 'ytMembership',
        default: true,
        color: '#2ba640',
        labelKey: 'mc_settings_yt_membership',
        tipKey: 'mc_settings_yt_membership_desc',
      },
      {
        value: 'ytMilestone',
        default: true,
        color: '#00e5ff',
        labelKey: 'mc_settings_yt_milestone',
        tipKey: 'mc_settings_yt_milestone_desc',
      },
      {
        value: 'ytGiftMemberships',
        default: true,
        color: '#ff4081',
        labelKey: 'mc_settings_yt_gift_memberships',
        tipKey: 'mc_settings_yt_gift_memberships_desc',
      },
    ],
  },

  // ── notifs / on @mention ──────────────────────────────────────────────
  {
    key: 'hs_notifications',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: false,
    scope: 'local',
    category: 'notifs',
    section: 'when you get @mentioned',
    labelKey: 'mc_settings_browser_notification',
    tipKey: 'mc_settings_browser_notification_desc',
    control: 'pill',
    apply: 'notifPermission',
  },
  {
    key: 'mentionTitleFlash',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'notifs',
    section: 'when you get @mentioned',
    labelKey: 'mc_settings_tab_title_flash',
    tipKey: 'mc_settings_tab_title_flash_desc',
    control: 'pill',
  },
  {
    key: 'mentionSoundVolume',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'range',
    default: 0.3,
    scope: 'sync',
    category: 'notifs',
    section: 'when you get @mentioned',
    labelKey: 'mc_settings_mention_volume',
    tipKey: 'mc_settings_mention_volume_desc',
    control: 'range',
    alias: 'mentionsoundvolume',
    apply: 'mentionPing',
    displayScale: 100,
    syncSilent: true,
    options: { min: 0, max: 1, step: 0.05 },
  },

  // ── notifs / cross-platform follow ────────────────────────────────────
  {
    key: 'crossFollowKick',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'notifs',
    section: 'cross-platform follow',
    labelKey: 'mc_settings_cross_follow_kick',
    tipKey: 'mc_settings_cross_follow_kick_desc',
    control: 'pill',
  },
  {
    key: 'crossFollowTwitch',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'notifs',
    section: 'cross-platform follow',
    labelKey: 'mc_settings_cross_follow_twitch',
    tipKey: 'mc_settings_cross_follow_twitch_desc',
    control: 'pill',
  },
  {
    key: 'crossFollowTwitchNotify',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'notifs',
    section: 'cross-platform follow',
    labelKey: 'mc_settings_cross_follow_twitch_notify',
    tipKey: 'mc_settings_cross_follow_twitch_notify_desc',
    control: 'pill',
  },

  // ── mod / mod toolbar ─────────────────────────────────────────────────
  // Hover actions on chat rows when you mod the channel. Option tags are
  // the button glyphs (rendered orange, matching the toolbar itself);
  // MOD_BUTTON_CATALOG in main.js keeps the action wiring — ids are the
  // contract between the two.
  {
    key: 'hs_mod_toolbar_buttons',
    type: 'multiselect',
    default: [],
    scope: 'local',
    category: 'mod',
    section: 'mod toolbar',
    labelKey: 'mc_settings_mod_toolbar_buttons',
    tipKey: 'mc_settings_mod_toolbar_buttons_desc',
    control: 'pill',
    runtimeVar: 'modToolbarButtons',
    apply: 'modToolbar',
    applyOnLoad: true,
    options: [
      { value: 'delete_message', tag: 'x', labelKey: 'mc_settings_mod_btn_delete' },
      { value: 'timeout_1m', tag: '1m', labelKey: 'mc_settings_mod_btn_timeout_1m' },
      { value: 'timeout_10m', tag: '10m', labelKey: 'mc_settings_mod_btn_timeout_10m' },
      { value: 'timeout_1h', tag: '1h', labelKey: 'mc_settings_mod_btn_timeout_1h' },
      { value: 'timeout_24h', tag: '24h', labelKey: 'mc_settings_mod_btn_timeout_24h' },
      { value: 'timeout_7d', tag: '7d', labelKey: 'mc_settings_mod_btn_timeout_7d' },
      { value: 'purge', tag: 'purge', labelKey: 'mc_settings_mod_btn_purge' },
      { value: 'ban', tag: '⛔', labelKey: 'mc_settings_mod_btn_ban' },
      { value: 'unban', tag: '✓', labelKey: 'mc_settings_mod_btn_unban' },
    ],
  },

  {
    key: 'modConfirmBan',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'mod',
    section: 'mod toolbar',
    labelKey: 'mc_settings_confirm_ban',
    tipKey: 'mc_settings_confirm_ban_desc',
    control: 'pill',
    runtimeVar: 'modConfirmBan',
    applyOnLoad: true,
  },
  {
    key: 'modBanReasons',
    type: 'text',
    default: '',
    scope: 'sync',
    category: 'mod',
    section: 'mod toolbar',
    labelKey: 'mc_settings_ban_reasons',
    tipKey: 'mc_settings_ban_reasons_desc',
    control: 'textarea',
    runtimeVar: 'modBanReasons',
    applyOnLoad: true,
  },

  // ── mod / automod ─────────────────────────────────────────────────────
  {
    key: 'automodAllCaps',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'mod',
    section: 'automod',
    labelKey: 'mc_settings_automod_caps',
    tipKey: 'mc_settings_automod_caps_desc',
    control: 'pill',
    apply: 'automod',
    applyOnLoad: true,
  },
  {
    key: 'automodRegex',
    type: 'text',
    default: '',
    scope: 'sync',
    category: 'mod',
    section: 'automod',
    labelKey: 'mc_settings_automod_regex',
    tipKey: 'mc_settings_automod_regex_desc',
    placeholderKey: 'mc_settings_automod_regex_placeholder',
    control: 'textarea',
    alias: 'automodregex',
    apply: 'automod',
    applyOnLoad: true,
    maxLen: 4096,
  },

  // ── filters / content — per-viewer content-warning emote filters ──────
  // local bool + server PATCH with rollback; sexual + gore hidden by
  // default server-side, weapons/drugs/hate shown by default
  {
    key: 'viewer_show_sexual',
    type: 'bool',
    default: false,
    scope: 'local',
    category: 'filters',
    section: 'content',
    labelKey: 'mc_settings_show_sexual',
    tipKey: 'mc_settings_show_sexual_desc',
    control: 'pill',
    apply: 'cwServerPatch',
    syncSilent: true,
    noReset: true,
    cw: { stateKey: 'sexual', serverBody: 'show_sexual_emotes', noun: 'sexual emotes setting' },
  },
  {
    key: 'viewer_show_gore',
    type: 'bool',
    default: false,
    scope: 'local',
    category: 'filters',
    section: 'content',
    labelKey: 'mc_settings_show_gore',
    tipKey: 'mc_settings_show_gore_desc',
    control: 'pill',
    apply: 'cwServerPatch',
    syncSilent: true,
    noReset: true,
    cw: { stateKey: 'gore', serverBody: 'show_gore_emotes', noun: 'gore emotes setting' },
  },
  {
    key: 'viewer_show_weapon',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'filters',
    section: 'content',
    labelKey: 'mc_settings_show_weapon',
    tipKey: 'mc_settings_show_weapon_desc',
    control: 'pill',
    apply: 'cwServerPatch',
    syncSilent: true,
    noReset: true,
    cw: { stateKey: 'weapon', serverBody: 'show_weapon_emotes', noun: 'weapons setting' },
  },
  {
    key: 'viewer_show_drug',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'filters',
    section: 'content',
    labelKey: 'mc_settings_show_drug',
    tipKey: 'mc_settings_show_drug_desc',
    control: 'pill',
    apply: 'cwServerPatch',
    syncSilent: true,
    noReset: true,
    cw: { stateKey: 'drug', serverBody: 'show_drug_emotes', noun: 'drugs setting' },
  },
  {
    key: 'viewer_show_hate',
    type: 'bool',
    default: true,
    scope: 'local',
    category: 'filters',
    section: 'content',
    labelKey: 'mc_settings_show_hate',
    tipKey: 'mc_settings_show_hate_desc',
    control: 'pill',
    apply: 'cwServerPatch',
    syncSilent: true,
    noReset: true,
    cw: { stateKey: 'hate', serverBody: 'show_hate_emotes', noun: 'hate setting' },
  },

  // ── filters / messages — render-time content filters ──────────────────
  // Hidden at render, not dropped from buffers — toggling off un-hides
  // retroactively. Mentions/unread state still counts hidden messages.
  {
    key: 'hideBots',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'filters',
    section: 'messages',
    labelKey: 'mc_settings_hide_bots',
    tipKey: 'mc_settings_hide_bots_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'hideCommands',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'filters',
    section: 'messages',
    labelKey: 'mc_settings_hide_commands',
    tipKey: 'mc_settings_hide_commands_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'hideDuplicates',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'filters',
    section: 'messages',
    labelKey: 'mc_settings_hide_duplicates',
    tipKey: 'mc_settings_hide_duplicates_desc',
    control: 'pill',
    rerender: true,
  },
  {
    key: 'hs_mute_keywords',
    type: 'text',
    default: '',
    scope: 'local',
    category: 'filters',
    section: 'messages',
    labelKey: 'mc_settings_mute_keywords',
    tipKey: 'mc_settings_mute_keywords_desc',
    placeholderKey: 'mc_settings_mute_keywords_placeholder',
    control: 'textarea',
    apply: 'muteKeywords',
    applyOnLoad: true,
    rerender: true,
    maxLen: 65536,
  },

  // ── filters / rules — per-rule highlight/hide engine ─────────────────
  // Stored as a JSON string in chrome.storage.local (array can be large).
  // Rendered as a custom UI; control:'custom' suppresses the auto row.
  {
    key: 'chatFilterRules',
    type: 'text',
    default: '[]',
    scope: 'local-mirror',
    mirrorKey: 'chat_filter_rules',
    category: 'filters',
    section: 'rules',
    labelKey: 'mc_settings_filter_rules',
    tipKey: 'mc_settings_filter_rules_desc',
    control: 'custom',
    alias: 'filterrules highlight hide rules',
    apply: 'filterRules',
    applyOnLoad: true,
    maxLen: 524288,
  },

  // ── tweaks — twitch ui noise toggles (content.js CSS-hide flags) ──────
  // order defines section ordering in the tweaks subtab
  {
    key: 'hideRecommendedChannels',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_recommended',
    tipKey: 'mc_settings_hide_recommended_desc',
  },
  {
    key: 'hideStories',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_stories',
    tipKey: 'mc_settings_hide_stories_desc',
  },
  {
    key: 'hidePrimeLoot',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_prime_loot',
    tipKey: 'mc_settings_hide_prime_loot_desc',
  },
  {
    key: 'hideTwitchTurbo',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_turbo',
    tipKey: 'mc_settings_hide_turbo_desc',
  },
  {
    key: 'hideSubtember',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_subtember',
    tipKey: 'mc_settings_hide_subtember_desc',
  },
  {
    key: 'hideLiveNotifBtn',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_live_notif_btn',
    tipKey: 'mc_settings_hide_live_notif_btn_desc',
  },
  {
    key: 'hideUnfollowBtn',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_unfollow_btn',
    tipKey: 'mc_settings_hide_unfollow_btn_desc',
  },
  {
    key: 'hideSubscribeBtn',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_subscribe_btn',
    tipKey: 'mc_settings_hide_subscribe_btn_desc',
  },
  {
    key: 'hideOnscreenCelebrations',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'player overlay',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_celebrations',
    tipKey: 'mc_settings_hide_celebrations_desc',
  },
  {
    key: 'hidePlayerExtensions',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'player overlay',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_player_ext',
    tipKey: 'mc_settings_hide_player_ext_desc',
  },
  {
    // BTTV-style scroll-wheel volume — not a CSS-hide flag (no `tweak: true`),
    // gated live by the wheel listener reading scrollWheelVolumeEnabled.
    key: 'scrollWheelVolume',
    type: 'bool',
    default: true,
    scope: 'sync',
    category: 'tweaks',
    section: 'player overlay',
    control: 'pill',
    runtimeVar: 'scrollWheelVolumeEnabled',
    labelKey: 'mc_settings_scroll_wheel_volume',
    tipKey: 'mc_settings_scroll_wheel_volume_desc',
  },

  // ── mod / native chat ─────────────────────────────────────────────────

  // ── tweaks / native chat chrome ───────────────────────────────────────
  {
    key: 'hideStreamTitle',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_stream_title',
    tipKey: 'mc_settings_hide_stream_title_desc',
  },
  {
    key: 'hideViewerCount',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'tweaks',
    section: 'sidebar / chrome',
    tweak: true,
    control: 'pill',
    labelKey: 'mc_settings_hide_viewer_count',
    tipKey: 'mc_settings_hide_viewer_count_desc',
  },

  // ── system / tabs ─────────────────────────────────────────────────────
  {
    key: 'hiddenTabs',
    type: 'multiselect',
    default: ['pinned'],
    scope: 'sync',
    category: 'system',
    section: 'tabs',
    labelKey: 'mc_settings_visible_tabs',
    control: 'pill',
    runtimeVar: 'hiddenTabs',
    apply: 'hiddenTabs',
    invertDisplay: true,
    options: [
      { value: 'feed', labelKey: 'mc_tab_feed' },
      { value: 'whispers', labelKey: 'mc_tab_whispers' },
      { value: 'mentions', labelKey: 'mc_tab_mentions' },
      { value: 'pinned', labelKey: 'mc_tab_pinned' },
      { value: 'modlog', labelKey: 'mc_tab_modlog' },
    ],
  },

  // ── system / language ─────────────────────────────────────────────────
  // Option labels hydrate at runtime from I18N_LOCALE_NAMES (browser-api.js
  // stays the single source of locale display names). The locale applier
  // re-inits i18n live; full UI re-labels on reload (reloadApply chip).
  {
    key: 'hs_ui_locale',
    basic: true, // day-one row — shows in the default (basic) settings view
    type: 'enum',
    default: '',
    scope: 'local',
    category: 'system',
    section: 'language',
    labelKey: 'mc_settings_ui_locale',
    tipKey: 'mc_settings_ui_locale_desc',
    control: 'select',
    apply: 'locale',
    reloadApply: true,
    options: [
      { value: '' },
      { value: 'ar' },
      { value: 'bg' },
      { value: 'cs' },
      { value: 'da' },
      { value: 'de' },
      { value: 'el' },
      { value: 'en' },
      { value: 'es' },
      { value: 'fi' },
      { value: 'fr' },
      { value: 'he' },
      { value: 'hi' },
      { value: 'hu' },
      { value: 'id' },
      { value: 'it' },
      { value: 'ja' },
      { value: 'ko' },
      { value: 'ms' },
      { value: 'nl' },
      { value: 'no' },
      { value: 'pl' },
      { value: 'pt_BR' },
      { value: 'pt_PT' },
      { value: 'ro' },
      { value: 'ru' },
      { value: 'sk' },
      { value: 'sv' },
      { value: 'th' },
      { value: 'tl' },
      { value: 'tr' },
      { value: 'uk' },
      { value: 'vi' },
      { value: 'zh_CN' },
      { value: 'zh_TW' },
    ],
  },

  // ── system / subsystems — compose your own chat ───────────────────────
  // Whole features OFF for real: gated at init so a disabled subsystem
  // never creates its sockets/listeners/DOM (RAM + CPU reclaim). Most
  // need a reload to apply (applies:'reload'); live ones tear down in
  // place. Server health kill-switch (__hsHealth.disabled) overrides.
  {
    key: 'subsystems',
    type: 'boolmap',
    scope: 'sync',
    category: 'system',
    section: 'subsystems',
    labelKey: 'mc_settings_subsystems',
    apply: 'subsystemToggle',
    control: 'pill',
    default: {
      'irc-twitch': true,
      'chat-kick': true,
      'chat-youtube': true,
      cosmetics: true,
      feed: true,
      whispers: true,
      mentions: true,
      'stream-stats': true,
      'profile-cards': true,
      'emote-render': true,
      'tab-complete': true,
      'picker-button': true,
      'native-takeover': true,
      'kick-native-tap': true,
      'yt-innertube-tap': true,
      'automod-queue': true,
    },
    options: [
      {
        value: 'irc-twitch',
        default: true,
        color: '#9146ff',
        applies: 'reload',
        labelKey: 'mc_settings_sub_irc_twitch',
        tipKey: 'mc_settings_sub_irc_twitch_desc',
      },
      {
        value: 'chat-kick',
        default: true,
        color: '#53fc18',
        applies: 'reload',
        labelKey: 'mc_settings_sub_chat_kick',
        tipKey: 'mc_settings_sub_chat_kick_desc',
      },
      {
        value: 'chat-youtube',
        default: true,
        color: '#ff0000',
        applies: 'reload',
        labelKey: 'mc_settings_sub_chat_youtube',
        tipKey: 'mc_settings_sub_chat_youtube_desc',
      },
      {
        value: 'cosmetics',
        default: true,
        color: '#00ffff',
        applies: 'reload',
        labelKey: 'mc_settings_sub_cosmetics',
        tipKey: 'mc_settings_sub_cosmetics_desc',
      },
      {
        value: 'feed',
        default: true,
        color: '#00ff7f',
        applies: 'reload',
        labelKey: 'mc_settings_sub_feed',
        tipKey: 'mc_settings_sub_feed_desc',
      },
      {
        value: 'whispers',
        default: true,
        color: '#ffff00',
        applies: 'reload',
        labelKey: 'mc_settings_sub_whispers',
        tipKey: 'mc_settings_sub_whispers_desc',
      },
      {
        value: 'mentions',
        default: true,
        color: '#ff00ff',
        applies: 'live',
        labelKey: 'mc_settings_sub_mentions',
        tipKey: 'mc_settings_sub_mentions_desc',
      },
      {
        value: 'stream-stats',
        default: true,
        color: '#387aff',
        applies: 'live',
        labelKey: 'mc_settings_sub_stream_stats',
        tipKey: 'mc_settings_sub_stream_stats_desc',
      },
      {
        value: 'profile-cards',
        default: true,
        color: '#00c853',
        applies: 'reload',
        labelKey: 'mc_settings_sub_profile_cards',
        tipKey: 'mc_settings_sub_profile_cards_desc',
      },
      {
        value: 'emote-render',
        default: true,
        color: '#fff',
        applies: 'reload',
        labelKey: 'mc_settings_sub_emote_render',
        tipKey: 'mc_settings_sub_emote_render_desc',
      },
      {
        value: 'tab-complete',
        default: true,
        color: '#fff',
        applies: 'reload',
        labelKey: 'mc_settings_sub_tab_complete',
        tipKey: 'mc_settings_sub_tab_complete_desc',
      },
      {
        value: 'picker-button',
        default: true,
        color: '#fff',
        applies: 'reload',
        labelKey: 'mc_settings_sub_picker_button',
        tipKey: 'mc_settings_sub_picker_button_desc',
      },
      {
        value: 'native-takeover',
        default: true,
        color: '#9146ff',
        applies: 'live',
        labelKey: 'mc_settings_sub_native_takeover',
        tipKey: 'mc_settings_sub_native_takeover_desc',
      },
      {
        value: 'kick-native-tap',
        default: true,
        color: '#53fc18',
        applies: 'live',
        labelKey: 'mc_settings_sub_kick_native_tap',
        tipKey: 'mc_settings_sub_kick_native_tap_desc',
      },
      {
        value: 'yt-innertube-tap',
        default: true,
        color: '#ff0000',
        applies: 'live',
        labelKey: 'mc_settings_sub_yt_innertube_tap',
        tipKey: 'mc_settings_sub_yt_innertube_tap_desc',
      },
      {
        value: 'automod-queue',
        default: true,
        color: '#ffd700',
        applies: 'live',
        labelKey: 'mc_settings_sub_automod_queue',
        tipKey: 'mc_settings_sub_automod_queue_desc',
      },
    ],
  },

  // ── system / advanced ─────────────────────────────────────────────────
  {
    key: 'crashTelemetry',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'system',
    section: 'advanced',
    labelKey: 'mc_settings_diag_errors',
    tipKey: 'mc_settings_diag_errors_desc',
    control: 'pill',
    rerenderSettings: true,
  },
  {
    key: 'debugLogging',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'system',
    section: 'advanced',
    labelKey: 'mc_settings_debug_logging',
    tipKey: 'mc_settings_debug_logging_desc',
    control: 'pill',
    reloadApply: true,
  },

  // ── system / state — ui state persisted via saveUiSetting, no settings
  // row (control:'custom' suppresses auto-row + search; 'state' section is
  // not in the system subtab's rendered-sections list). declared so the
  // registry stays the single source of truth for every ui_settings key.
  // noReset: these are session state / user data, not preferences — "reset
  // to defaults" must not close the user's tab or wipe their presets.
  {
    key: 'activeTab',
    type: 'text',
    default: 'live',
    scope: 'sync',
    category: 'system',
    section: 'state',
    label: 'active tab',
    tip: 'last active multichat tab — restored on load (built-in tab id or channel tab id)',
    control: 'custom',
    maxLen: 128,
    noReset: true,
  },
  {
    key: 'liveChannel',
    type: 'text',
    default: '',
    scope: 'sync',
    category: 'system',
    section: 'state',
    label: 'live tab channel',
    tip: 'live-tab channel override — popout-scoped; empty/null means use the url channel',
    control: 'custom',
    maxLen: 128,
    noReset: true,
  },
  {
    key: 'nativeVisible',
    type: 'bool',
    default: false,
    scope: 'sync',
    category: 'system',
    section: 'state',
    label: 'native chat visible',
    tip: 'user chose to keep the platform-native chat column visible alongside the overlay',
    control: 'custom',
    noReset: true,
  },
  {
    key: 'chatPositionPrevious',
    type: 'enum',
    default: 'right',
    scope: 'sync',
    category: 'system',
    section: 'state',
    label: 'previous chat dock side',
    tip: 'last non-hidden dock side — the \\ hide toggle restores to it',
    control: 'custom',
    options: [{ value: 'right' }, { value: 'bottom' }, { value: 'left' }, { value: 'top' }],
    noReset: true,
  },
  {
    key: 'customPresets',
    type: 'json',
    default: [],
    scope: 'sync',
    category: 'system',
    section: 'state',
    label: 'custom presets',
    tip: 'user-saved settings presets — diff-vs-defaults snapshots, managed from the presets bar',
    control: 'custom',
    maxLen: 6000,
    noReset: true,
  },
]

// ── presets ("builds") — sparse diffs over registry defaults ──────────────
// Composite keys (boolmap/multiselect) carry whole values. Anything not in
// a diff stays untouched, so presets compose with user tweaks and survive
// new settings. A preset reads "active" only when ALL its diff keys match.
const SETTINGS_PRESETS = [
  {
    id: 'minimal',
    label: 'minimal',
    labelKey: 'mc_settings_preset_minimal',
    tip: 'just chat — no cosmetics, feed, stats or extra chrome',
    diff: {
      avatars: false,
      zebra: false,
      firstChatterGlow: false,
      showPlatformBadges: false,
      linkPreviewsEnabled: false,
      hiddenTabs: ['feed', 'whispers', 'mentions', 'pinned'],
      subsystems: {
        'irc-twitch': true,
        'chat-kick': true,
        'chat-youtube': true,
        cosmetics: false,
        feed: false,
        whispers: false,
        mentions: false,
        'stream-stats': false,
        'profile-cards': true,
        'emote-render': true,
        'tab-complete': true,
        'picker-button': true,
        'native-takeover': true,
        'kick-native-tap': true,
        'yt-innertube-tap': true,
        'automod-queue': true,
      },
    },
  },
  {
    id: 'power-user',
    label: 'power user',
    labelKey: 'mc_settings_preset_power_user',
    tip: 'every tab on, timestamps, vi keys',
    diff: {
      viMode: true,
      timestamps: true,
      hiddenTabs: [],
    },
  },
  {
    id: 'moderator',
    label: 'moderator',
    labelKey: 'mc_settings_preset_moderator',
    tip: 'timestamps + readable names + all-caps automod',
    diff: {
      timestamps: true,
      automodAllCaps: true,
      hs_readable_names: true,
    },
  },
  {
    id: 'low-ram',
    label: 'low ram',
    labelKey: 'mc_settings_preset_low_ram',
    tip: 'cosmetics, feed, whispers, stats and previews off; 1x emotes',
    diff: {
      hs_emote_size: 1,
      hs_emoji_size: 1,
      avatars: false,
      linkPreviewsEnabled: false,
      subsystems: {
        'irc-twitch': true,
        'chat-kick': true,
        'chat-youtube': true,
        cosmetics: false,
        feed: false,
        whispers: false,
        mentions: true,
        'stream-stats': false,
        'profile-cards': false,
        'emote-render': true,
        'tab-complete': true,
        'picker-button': true,
        'native-takeover': true,
        'kick-native-tap': true,
        'yt-innertube-tap': true,
        'automod-queue': true,
      },
    },
  },
]

// ── pure validators / helpers ─────────────────────────────────────────────

/**
 * @param {SettingDef} def
 * @param {*} v
 * @returns {boolean}
 */
/**
 * The option list to RENDER for a def, given the current settings.
 *
 * `def.options` is the static union — validateSettingValue/coerceSettingValue/
 * lintSettings read it directly and have no other settings in hand, so it must
 * stay the full set of legally storable values. `def.optionsFor` narrows that
 * to the current state for display: fontSize uses it so a bitmap family only
 * ever offers the sizes it has.
 *
 * Lives here rather than inline in the renderer so it is testable without a
 * browser — the extension's settings UI only exists inside the multichat
 * overlay on twitch/kick/youtube, which is not something a test should need.
 *
 * @param {SettingDef} def
 * @param {(key: string) => any} get
 * @returns {SettingOption[]}
 */
export function resolveOptions(def, get) {
  if (def && typeof def.optionsFor === 'function') {
    try {
      const narrowed = def.optionsFor(get)
      if (Array.isArray(narrowed) && narrowed.length) return narrowed
    } catch (_) {
      // A throwing narrower must not blank the control — fall back to the union.
    }
  }
  return /** @type {SettingOption[]} */ (def && def.options) || []
}

function validateSettingValue(def, v) {
  if (!def) return false
  switch (def.type) {
    case 'bool':
      return typeof v === 'boolean'
    case 'enum': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      return !!opts && opts.some((o) => o.value === v)
    }
    case 'range': {
      const range = /** @type {{min:number,max:number,step:number}} */ (def.options)
      return typeof v === 'number' && Number.isFinite(v) && !!range && v >= range.min && v <= range.max
    }
    case 'text':
      return typeof v === 'string' && v.length <= (def.maxLen || 4096)
    case 'multiselect': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      return !!opts && Array.isArray(v) && v.every((x) => opts.some((o) => o.value === x))
    }
    case 'boolmap': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      return (
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        !!opts &&
        Object.keys(v).every((k) => typeof v[k] === 'boolean' && opts.some((o) => o.value === k))
      )
    }
    case 'json': {
      // structured state blob — any JSON-serializable array/object under the
      // size cap. shape-specific filtering stays at the consumer (it owns the
      // semantics); this guards type + serializability + size only.
      if (v === null || typeof v !== 'object') return false
      try {
        return JSON.stringify(v).length <= (def.maxLen || 524288)
      } catch {
        return false
      }
    }
    default:
      return false
  }
}

// normalize a raw value toward validity; returns undefined when unsalvageable
/**
 * @param {SettingDef} def
 * @param {*} v
 * @returns {*} normalized value, or undefined
 */
function coerceSettingValue(def, v) {
  if (!def || v === undefined || v === null) return undefined
  // per-def pre-coercion — type migrations (e.g. a retired bool living under
  // the same key as its enum successor) run before generic type handling so
  // every ingest path (hydrate, setSetting, storage-change, ws sync) maps
  // legacy values instead of dropping them to the default
  if (def.coerce) {
    try {
      const cv = def.coerce(v)
      if (cv !== undefined) v = cv
    } catch (_) {}
  }
  switch (def.type) {
    case 'bool':
      return !!v
    case 'enum': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      if (opts?.some((o) => o.value === v)) return v
      // tolerate string/number mismatch ('2' vs 2) from DOM datasets
      var loose = opts?.find((o) => String(o.value) === String(v))
      return loose ? loose.value : undefined
    }
    case 'range': {
      const range = /** @type {{min:number,max:number,step:number}} */ (def.options)
      var n = typeof v === 'number' ? v : parseFloat(v)
      if (!Number.isFinite(n) || !range) return undefined
      return Math.min(range.max, Math.max(range.min, n))
    }
    case 'text': {
      if (typeof v !== 'string') return undefined
      return v.length > (def.maxLen || 4096) ? v.slice(0, def.maxLen || 4096) : v
    }
    case 'multiselect': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      if (!Array.isArray(v) || !opts) return undefined
      return v.filter((x) => opts.some((o) => o.value === x))
    }
    case 'boolmap': {
      const opts = /** @type {SettingOption[]} */ (def.options)
      if (!v || typeof v !== 'object' || Array.isArray(v) || !opts) return undefined
      // merge known stored subkeys over the full default map — legacy
      // installs persisted partial maps and expect default-fill semantics
      var merged = {}
      for (var dk in def.default) merged[dk] = def.default[dk]
      for (var sk in v) {
        if (opts.some((o) => o.value === sk)) merged[sk] = !!v[sk]
      }
      return merged
    }
    case 'json':
      // no partial salvage for structured blobs — either the value is a
      // valid serializable object/array or the consumer's default stands
      return validateSettingValue(def, v) ? v : undefined
    default:
      return undefined
  }
}

// build/test-time lint — returns an array of problem strings (empty = clean).
// syncBlocklist is utils.js UI_SYNC_BLOCKLIST (passed in to keep this pure).
function lintSettings(syncBlocklist) {
  var problems = []
  var seen = new Set()
  var aliases = new Set()
  var syncDefaults = {}
  for (var i = 0; i < SETTINGS.length; i++) {
    var def = SETTINGS[i]
    if (seen.has(def.key)) problems.push(`duplicate key: ${def.key}`)
    seen.add(def.key)
    if (def.alias) {
      if (aliases.has(def.alias)) problems.push(`duplicate alias: ${def.alias}`)
      aliases.add(def.alias)
    }
    if (!validateSettingValue(def, def.default)) problems.push(`default fails validate: ${def.key}`)
    if (!['sync', 'local', 'local-mirror'].includes(def.scope)) problems.push(`bad scope: ${def.key}`)
    if (def.scope === 'sync' && syncBlocklist && syncBlocklist.has(def.key)) {
      problems.push(`sync-scoped key is in UI_SYNC_BLOCKLIST: ${def.key}`)
    }
    if (def.scope === 'local-mirror') {
      if (!def.mirrorKey) problems.push(`local-mirror without mirrorKey: ${def.key}`)
      if (syncBlocklist && !syncBlocklist.has(def.key)) {
        problems.push(`local-mirror key missing from UI_SYNC_BLOCKLIST: ${def.key}`)
      }
    }
    if (def.scope === 'local' && !/^(hs|viewer)_/.test(def.key)) {
      problems.push(`local key outside hs_/viewer_ namespace (breaks export/import): ${def.key}`)
    }
    if (!def.label && !def.labelKey) problems.push(`no label: ${def.key}`)
    if (def.type === 'boolmap') {
      var boolmapOpts = /** @type {SettingOption[]} */ (def.options)
      var optVals = boolmapOpts ? boolmapOpts.map((o) => o.value) : []
      var defKeys = Object.keys(def.default)
      if (optVals.length !== defKeys.length || !optVals.every((k) => defKeys.indexOf(k) !== -1)) {
        problems.push(`boolmap default/options key mismatch: ${def.key}`)
      }
      if (boolmapOpts)
        boolmapOpts.forEach((o) => {
          if (def.default[o.value] !== o.default)
            problems.push(`boolmap per-option default disagrees with default map: ${def.key}.${o.value}`)
        })
    }
    if (def.cw && (!def.cw.stateKey || !def.cw.serverBody || !def.cw.noun)) {
      problems.push(`cw sub-shape incomplete: ${def.key}`)
    }
    if (def.dependsOn) {
      const depKey = def.dependsOn.key
      if (!SETTINGS.some((d) => d.key === depKey)) problems.push(`dependsOn unknown key: ${def.key}`)
    }
    if (def.scope === 'sync') syncDefaults[def.key] = def.default
  }
  // 8 KB sync quota headroom — defaults must leave room for user values
  var size = JSON.stringify(syncDefaults).length
  if (size > 7000) problems.push(`sync defaults too large: ${size} bytes`)
  // preset diffs must reference real keys with valid values
  var presetIds = new Set()
  for (var p = 0; p < SETTINGS_PRESETS.length; p++) {
    var preset = SETTINGS_PRESETS[p]
    if (presetIds.has(preset.id)) problems.push(`duplicate preset id: ${preset.id}`)
    presetIds.add(preset.id)
    for (var dk in preset.diff) {
      var target = SETTINGS.find((d) => d.key === dk)
      if (!target) {
        problems.push(`preset ${preset.id} references unknown key: ${dk}`)
        continue
      }
      if (!validateSettingValue(target, preset.diff[dk])) {
        problems.push(`preset ${preset.id} has invalid value for: ${dk}`)
      }
      // boolmap diffs must carry every option key — coerce merges partial
      // maps over defaults, silently reverting user-toggled missing keys
      if (target.type === 'boolmap') {
        for (var bk in target.default) {
          if (!(bk in preset.diff[dk])) {
            problems.push(`preset ${preset.id} boolmap diff missing key: ${dk}.${bk}`)
          }
        }
      }
    }
  }
  return problems
}

// Global export (IIFE bundle path — mirrors utils.js)
if (typeof window !== 'undefined') {
  window.heatsyncSettingsSchema = { SETTINGS, SETTINGS_PRESETS, validateSettingValue, coerceSettingValue, lintSettings }
}

export { coerceSettingValue, lintSettings, SETTINGS, SETTINGS_PRESETS, validateSettingValue }

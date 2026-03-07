(function() {
  'use strict'

  const DEFAULTS = {
    hs_emote_size: 'medium',
    hs_heat_badges: true,
    hs_cross_platform: true,
    hs_notifications: false,
    hs_multichat_layout: 'tabs',
    hs_auto_connect: true
  }

  const toast = document.getElementById('toast')
  let toastTimer

  function flashSaved() {
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1200)
  }

  function save(key, value) {
    chrome.storage.local.set({ [key]: value })
    flashSaved()
  }

  function bindRadio(groupId, storageKey, value) {
    const radio = document.querySelector(
      `#${groupId} input[value="${value}"]`
    )
    if (radio) radio.checked = true

    document.getElementById(groupId).addEventListener('change', (e) => {
      if (e.target.type === 'radio') save(storageKey, e.target.value)
    })
  }

  function bindToggle(elementId, storageKey, value) {
    const el = document.getElementById(elementId)
    el.checked = value
    el.addEventListener('change', () => save(storageKey, el.checked))
  }

  async function init() {
    const data = await chrome.storage.local.get(Object.keys(DEFAULTS))
    const s = { ...DEFAULTS, ...data }

    bindRadio('emote-size', 'hs_emote_size', s.hs_emote_size)
    bindRadio('multichat-layout', 'hs_multichat_layout', s.hs_multichat_layout)
    bindToggle('heat-badges', 'hs_heat_badges', s.hs_heat_badges)
    bindToggle('cross-platform', 'hs_cross_platform', s.hs_cross_platform)
    bindToggle('notifications', 'hs_notifications', s.hs_notifications)
    bindToggle('auto-connect', 'hs_auto_connect', s.hs_auto_connect)
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch(e => console.error('options init failed:', e))
  })
})()

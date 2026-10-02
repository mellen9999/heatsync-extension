// x-glyph.js — THE close glyph. Every dismiss × in the overlay is this one thick
// svg cross (white on black, reverse on hover/active — the .hs-x rule in
// styles/21-x-glyph.css), the same shape the site draws. Nothing else hand-writes
// a × / ✕ character for a close: tests/x-glyph-gate.test.js fails the build if it does.

const HS_X_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="2.25" fill="none"/></svg>'

// Markup form, for template strings. `cls` adds the spot-specific class(es).
function hsXButtonHtml(cls = '', label = 'close', attrs = '') {
  return `<button type="button" class="hs-x${cls ? ` ${cls}` : ''}" aria-label="${label}"${attrs ? ` ${attrs}` : ''}>${HS_X_SVG}</button>`
}

// Element form. `onClick` is optional (a delegated handler may own the click).
function hsXButton(cls = '', label = 'close', onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `hs-x${cls ? ` ${cls}` : ''}`
  b.setAttribute('aria-label', label)
  b.innerHTML = HS_X_SVG
  if (onClick) b.addEventListener('click', onClick)
  return b
}

// Turn an existing node (one a mirrored/shared renderer produced) into the glyph.
function hsXify(el, label = 'close') {
  if (!el) return el
  el.classList.add('hs-x')
  el.setAttribute('aria-label', label)
  el.innerHTML = HS_X_SVG
  return el
}

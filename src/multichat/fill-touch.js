// fill-touch.js — the 1px gap between two touching filled rows, said by a class on the row.
//
// The site writes it `.hs-filled + .hs-filled`. Here a sibling selector that reaches a chat row
// marks the list as "my children depend on their neighbours", and what that then costs is set by
// the host page's own css: kick's sheet has `> svg ~ *`, and with both in play every row taken
// off the top or put in mid-list re-styled every element of the list (30ms a time with 500 rows,
// a third of the main thread on a slow cpu, 11-18). So the row after a filled row carries
// hs-fill-touch (styles/21-fill-touch.css), and no selector of ours puts + or ~ on a row of the
// list (tests/list-rows-carry-no-sibling-rule.test.js).

/** a row is told whether the row before it is filled too */
function syncFillTouch(row) {
  const on = row.classList.contains('hs-filled') && !!row.previousElementSibling?.classList.contains('hs-filled')
  if (on !== row.classList.contains('hs-fill-touch')) row.classList.toggle('hs-fill-touch', on)
}

/** keeps hs-fill-touch right on the rows of `list` through every way a row arrives or leaves */
function watchFillTouch(list) {
  const mine = (n) => n?.nodeType === 1 && n.parentNode === list
  const obs = cleanup.trackObserver(
    new MutationObserver((records) => {
      for (const r of records) {
        // a row that arrived, and the row under it: each has a new neighbour above
        for (const n of r.addedNodes) {
          if (!mine(n)) continue
          syncFillTouch(n)
          if (n.nextElementSibling) syncFillTouch(n.nextElementSibling)
        }
        // the row under one that left
        let next = r.removedNodes.length ? r.nextSibling : null
        while (next && next.nodeType !== 1) next = next.nextSibling
        if (mine(next)) syncFillTouch(next)
      }
    }),
  )
  obs.observe(list, { childList: true })
  for (let row = list.firstElementChild; row; row = row.nextElementSibling) syncFillTouch(row)
}

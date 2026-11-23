// The login is held under either of two keys (the sealed token, or the clear-text one an older
// build left, which the background seals and then removes). A storage change names only the keys
// that changed, so each key's state is kept: reading "logged out" off the removal of the
// clear-text copy, a moment after the sealed one was written, showed a signed-in person as
// anonymous until the page was reloaded.
const _hsAuthKeys = { auth_token_encrypted: false, auth_token: false }
/** @param {Record<string, {newValue?: unknown}>} changes storage changes (or a full read, as newValue) */
function hsAuthAfter(changes) {
  for (const k in _hsAuthKeys) if (changes?.[k]) _hsAuthKeys[k] = !!changes[k].newValue
  return _hsAuthKeys.auth_token_encrypted || _hsAuthKeys.auth_token
}

/** a full read of both keys (startup) */
function hsAuthRead(data) {
  return hsAuthAfter({
    auth_token_encrypted: { newValue: data?.auth_token_encrypted },
    auth_token: { newValue: data?.auth_token },
  })
}

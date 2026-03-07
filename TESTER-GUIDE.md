# heatsync extension beta test guide

thanks for helping test! here's what to do.

## install

### chrome
1. download and unzip `heatsync-chrome-1.2.1.zip`
2. go to `chrome://extensions`
3. enable "Developer mode" (toggle top right)
4. click "Load unpacked"
5. select the unzipped folder
6. you should see heatsync icon in toolbar

### firefox
1. download `heatsync-firefox-1.2.1.zip`
2. go to `about:debugging#/runtime/this-firefox`
3. click "Load Temporary Add-on"
4. select the zip file
5. you should see heatsync icon in toolbar

### edge
same as chrome, use the chrome zip

---

## setup

1. go to https://heatsync.org
2. login with twitch or kick
3. add some emotes to your set (or use the defaults)

---

## test checklist

open twitch.tv or kick.com and try these:

### basic functionality
- [ ] emotes from your set appear in chat when you type them
- [ ] other heatsync users' emotes appear in chat
- [ ] emotes render as images (not just text)

### autocomplete
- [ ] start typing an emote name and press TAB
- [ ] dropdown should show matching emotes
- [ ] selecting one inserts it into chat

### blocking
- [ ] right-click any emote in chat
- [ ] click "block emote"
- [ ] that emote should disappear/stop rendering
- [ ] refresh page - emote should still be blocked

### cross-platform
- [ ] test on twitch.tv
- [ ] test on kick.com
- [ ] emotes work on both

### performance
- [ ] open browser devtools (F12)
- [ ] go to Memory tab
- [ ] extension should use <50MB
- [ ] no lag when scrolling chat

---

## report issues

if something breaks:

1. open devtools (F12)
2. go to Console tab
3. screenshot any red errors
4. note what you were doing when it broke
5. send to mellen

format:
```
browser: chrome/firefox/edge
platform: twitch/kick
what happened: [describe]
expected: [what should happen]
screenshot: [attach if possible]
```

---

## known issues

- firefox: extension unloads on browser restart (temporary install limitation)
- kick: some chat layouts may not be detected yet

---

## uninstall

### chrome
1. go to `chrome://extensions`
2. find heatsync
3. click Remove

### firefox
1. go to `about:addons`
2. find heatsync
3. click Remove

---

thanks again for testing!

# YT Preview Handoff

A userscript for YouTube in Firefox. When you click a video while its hover preview is playing, the preview keeps playing over the watch page until the real player is ready, then hands off at the same timestamp.

Desktop YouTube only for now.

## Install (each device, once)

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. Open <https://raw.githubusercontent.com/n-ubo/yt_buffer_skip/master/yt-preview-handoff.user.js> and click **Install**.

## Updating

1. Edit `yt-preview-handoff.user.js`.
2. Raise `@version` in the header (e.g. `1.0.0` → `1.0.1`). Violentmonkey only updates when the version goes up.
3. Push to `master`.

Violentmonkey checks for updates about once a day. To update right away: dashboard → **Check for updates**.

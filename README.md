# YT Preview Handoff

A userscript for YouTube in Firefox. When you click a video while its hover preview is playing, the preview keeps playing over the watch page until the real player is ready, then hands off at the same timestamp.

Desktop YouTube only for now.

## Install

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. In the Violentmonkey dashboard, click **+** → **New**.
3. Delete the template, paste the entire contents of `main.js`, and save (Ctrl+S).
4. Reload YouTube.

## Updating

Edit `main.js`, raise `@version` in the header, then paste the file over the old script in Violentmonkey and save.

## Other devices

Violentmonkey → **Settings** → **Sync** syncs your scripts through Dropbox, OneDrive, Google Drive or WebDAV. Turn it on on each device.

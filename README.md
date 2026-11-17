# YT Preview Handoff

A Firefox extension for YouTube. When you click a video while its hover preview is playing, the preview keeps playing over the watch page until the real player is ready, then hands off at the same timestamp.

> Desktop only for now. The script targets desktop YouTube's page structure (`ytd-*` elements); on the mobile site (`m.youtube.com`) it loads but doesn't do anything yet.

## Requirements

- [Node.js](https://nodejs.org/) (includes npm)
- Firefox 128 or newer

## Setup

```sh
npm install
```

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Opens a temporary Firefox profile with the extension loaded, at youtube.com. Reloads when you edit files. |
| `npm run lint` | Checks the extension for problems with Mozilla's linter. |
| `npm run build` | Lints, then packages the extension into `dist/yt-preview-handoff-<version>.xpi`. |
| `npm run sign` | Gets the extension signed by Mozilla as an unlisted add-on (needs API keys, see below). |

## Installing in Firefox

Regular Firefox only installs **signed** add-ons permanently.

### Try it without signing (until Firefox restarts)

1. Run `npm run build`.
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Select `dist/yt-preview-handoff-<version>.xpi` (or `manifest.json`).

### Permanent install (signed)

1. Create API keys at <https://addons.mozilla.org/developers/addon/api/key/> (requires a free Firefox account).
2. Set them as environment variables and sign:

   PowerShell:
   ```powershell
   $env:WEB_EXT_API_KEY = "user:12345:67"
   $env:WEB_EXT_API_SECRET = "your-secret"
   npm run sign
   ```

   Bash:
   ```sh
   export WEB_EXT_API_KEY="user:12345:67"
   export WEB_EXT_API_SECRET="your-secret"
   npm run sign
   ```

3. The signed `.xpi` is saved in `dist/`. Drag it into a Firefox window to install it.

Mozilla rejects a version number it has already signed. Bump `version` in `manifest.json` before signing again.

### Firefox for Android

Firefox Sync does **not** copy add-ons to Android, so install it on the phone directly:

1. Sign the extension (see above) and copy the signed `.xpi` to your phone.
2. In Firefox for Android, open **Settings → About Firefox** and tap the Firefox logo 5 times to unlock the debug options.
3. Go back to **Settings → Install extension from file** and pick the `.xpi`.

## Releasing a new version

### Automatically (GitHub Actions)

Every push to `master` runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It lints the extension, signs it with Mozilla, and publishes a GitHub Release with the signed `.xpi` attached. Open the repo's **Releases** page, download the `.xpi`, and drag it into Firefox.

One-time setup:

1. Create API keys at <https://addons.mozilla.org/developers/addon/api/key/>.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add two repository secrets:
   - `WEB_EXT_API_KEY`: the "JWT issuer" value
   - `WEB_EXT_API_SECRET`: the "JWT secret" value

The version is set automatically to `<major>.<minor>.<run number>`, with major and minor taken from `manifest.json`. You never need to bump the patch number yourself. Change major or minor in `manifest.json` only for bigger releases.

If the secrets are missing, the workflow still runs. It publishes an **unsigned** `.xpi`, which you can only load temporarily through `about:debugging`.

You can also start a run by hand from the **Actions** tab (**Build and release → Run workflow**).

### Manually

1. Bump `version` in `manifest.json`.
2. `npm run build` to check that it packages cleanly.
3. `npm run sign` to get the signed `.xpi`.

## Project files

- `main.js`: the content script that runs on YouTube.
- `manifest.json`: the extension manifest.
- `web-ext-config.mjs`: build settings (output folder, files left out of the package).

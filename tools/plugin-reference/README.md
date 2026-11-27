# Plugin reference: infinite and wallpaper

These two GUI plugins were removed from the active plugin directory
(C:\Users\Swuarez\.config\opencode\plugins) on 2026-11-25 so their composer
pills would stop appearing. The code is preserved here for the planned rework.

The app auto-discovers every file and directory under the config's "plugin" and
"plugins" folders (see packages/core/src/plugin/source-directory.ts), so removing
the entries from opencode.json alone did not disable them. The folders had to
leave that directory.

## infinite

Files:
- infinite/dist/gui-experimental.cjs - GUI bundle
- infinite/tui.js - TUI part

What it did:
- Added the "Reset limit" composer pill: ComposerPill, id "infinite", order 0,
  icon "globe".
- Clicking the pill called rotate(), which rotates the WARP exit to reset the
  free-tier limit.
- Registered commands: free-limit, rotate, local-model, local-status.
- Contains free-pool probing, WARP rotation, local model setup/status, and the
  TUI integration.

Key places in the bundle:
- pillLabel() around line 1533 returns "Reset limit" for every pool state.
- ctx.add(gui.ComposerPill, ...) around line 1734.
- rotate() / rotateEgress logic in the same bundle.

Related project code:
- tools/egress-rotator - the standalone WARP egress rotator.
- packages/desktop/src/main/infinite - built-in Infinite runtime (auto-rotate,
  reset limit, proxy handling).
- packages/app/src/shell/infinite-bar.tsx - the built-in bottom bar. Its
  "Reset limit" button is separate from this plugin.

## wallpaper

Files:
- wallpaper/dist/gui-experimental.cjs - GUI bundle

What it did:
- Added the "Wallpaper" composer pill: ComposerPill, id "wallpaper", order 1,
  icon "photo".
- Clicking it opened a file picker, stored the selected image, and applied it as
  the app background.
- Registered commands wallpaper.pick and wallpaper.reset.
- Stored the image under the plugin storage key "image".

Key place in the bundle:
- A.add(B.ComposerPill, ...) in the setup function (the bundle is minified).

## Restoring or reusing

Option A - restore as plugins:
1. Copy infinite/ and wallpaper/ back to
   %USERPROFILE%\.config\opencode\plugins\.
2. Open Settings -> Extensions -> Plugins and click Reload, or restart the app.

Option B - rework inside the app:
- The bundles are minified CommonJS. They default-export Plugin.define(...) and
  register UI with ComposerPill and Command.
- The SDK is @opencode/plugin (GUI host).
- The app renders composer pills in
  packages/app/src/session/composer/plugin-pills.tsx.
- For a permanent built-in, port the logic into packages/gui-plugins/src rather
  than shipping a local plugin.

## Config note

opencode.json now uses C:\Users\Swuarez paths. The browse MCP still points at
C:\Users\Swuarez\.local\bin\browse.exe, which is not present on this machine;
that entry was left untouched.

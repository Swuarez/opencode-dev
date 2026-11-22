# Releasing OpenCode Dev

The desktop app updates from this repository's GitHub Releases. electron-updater reads:

```
https://github.com/Swuarez/secretpony/releases/latest/download/latest.yml
```

Every release must attach these three files:

- `latest.yml`
- `opencode-desktop-win-x64.exe`
- `opencode-desktop-win-x64.exe.blockmap`

The version in `latest.yml` and the app's `version` must match the tag (for example tag `v2.2.22` and version `2.2.22`). The app refuses downgrades, so always publish a version higher than the current release.

## Build

From `opencode-app/packages/desktop` in PowerShell:

```powershell
$env:OPENCODE_CHANNEL = 'dev'
$env:OPENCODE_VERSION = '2.2.22'
bun run build
bun run pack
```

`bun run pack` writes the unpacked app to `dist/win-unpacked` and writes its `resources/app-update.yml`. Copy that folder out before the next electron-builder run, because electron-builder clears `dist/`:

```powershell
$src = "dist\win-unpacked"
$tmp = Join-Path $env:TEMP "opencode-dev-$env:OPENCODE_VERSION"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
robocopy $src $tmp /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) { throw "robocopy failed: $LASTEXITCODE" }
```

Build the NSIS installer around that copy:

```powershell
bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts --prepackaged $tmp
```

This produces `dist/latest.yml`, `dist/opencode-desktop-win-x64.exe` and `dist/opencode-desktop-win-x64.exe.blockmap`.

For a local build, `electron-builder.store.config.ts` skips the CPU-heavy 7z compression. The installer is larger, but packaging finishes in seconds and the updater still works:

```powershell
bunx electron-builder --win --x64 --publish never --config electron-builder.store.config.ts --prepackaged $tmp
```

## Publish

```powershell
gh release create "v$env:OPENCODE_VERSION" `
  "dist/opencode-desktop-win-x64.exe" `
  "dist/opencode-desktop-win-x64.exe.blockmap" `
  "dist/latest.yml" `
  --title "OpenCode Dev $env:OPENCODE_VERSION" `
  --notes "What changed in this release."
```

## Verify

```powershell
curl.exe -sSL https://github.com/Swuarez/secretpony/releases/latest/download/latest.yml
```

The installer is unsigned, so Windows SmartScreen warns on first run.

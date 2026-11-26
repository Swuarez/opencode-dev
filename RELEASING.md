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

### Build the CLI first

The desktop bundles the CLI from `opencode-app/packages/cli/dist`. A dev build without it downloads the published upstream dev CLI, which probes every MCP server on connect and ignores this fork's legacy-by-default MCP client. Production builds fail instead of downloading. Build the Windows x64 baseline package the desktop expects:

From `opencode-app/packages/cli` in PowerShell:

```powershell
$env:OPENCODE_CHANNEL = 'dev'
$env:OPENCODE_VERSION = '2.2.22'
$env:OPENCODE_TARGET = 'windows-x64-baseline'
bun run build
```

Use the same `OPENCODE_VERSION` as the desktop build. The CLI writes it into `dist/cli-windows-x64-baseline/package.json`, and the desktop copies that version next to the bundled executable. Confirm the package is there:

```powershell
Test-Path dist/cli-windows-x64-baseline/bin/opencode.exe
Get-Content dist/cli-windows-x64-baseline/package.json | Select-String '"version"'
```

The target is the baseline build because `packages/desktop/script/utils.ts` maps Windows x64 to `@opencode/cli-windows-x64-baseline` on every x64 machine. `OPENCODE_TARGET` builds only that one; `--single --baseline` builds the current platform and architecture's baseline variant.

Then, from `opencode-app/packages/desktop` in PowerShell:

```powershell
$env:OPENCODE_CHANNEL = 'dev'
$env:OPENCODE_VERSION = '2.2.22'
bun run build
bun run pack
```

`bun run build` copies the CLI from `packages/cli/dist` and writes its version next to the executable. Confirm the app bundled the CLI you just built, not a download:

```powershell
Get-Content resources/opencode-cli.version
& resources/opencode-cli.exe --version
```

Both must print the release version.

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

For a local build, `electron-builder.store.config.ts` skips the CPU-heavy 7z compression. The installer is larger, but packaging finishes in seconds and the updater still works. Keep `OPENCODE_VERSION` set for this command too: electron-builder writes it into `latest.yml`, and the config refuses to run without it.

```powershell
$env:OPENCODE_VERSION = '2.2.22'
bunx electron-builder --win --x64 --publish never --config electron-builder.store.config.ts --prepackaged $tmp
```

Check the feed carries the release version before publishing:

```powershell
Select-String -Path dist/latest.yml -Pattern "^version: $env:OPENCODE_VERSION"
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

# OpenCode Infinite (desktop app): build it yourself

This folder is the whole source of the desktop app. Clone the repository and build; nothing else has to be downloaded by hand except the Tor bundle (step 3).

You need Windows 10 / 11 (x64), [Git](https://git-scm.com) and [Bun](https://bun.sh) (the version in `packageManager` of `package.json`, or a compatible one).

## 1. Install

```powershell
git clone https://gitlab.com/jekooo/opencode-infinite.git
cd opencode-infinite\opencode-app
bun install
```

## 2. Build the CLI

The app bundles its own CLI. It must be built from this source: the published or "dev" CLI does not have the Infinite changes (for example the DeepAI provider).

```powershell
cd packages\cli
$env:OPENCODE_CHANNEL = "infinite-desktop-2.2.8"
bun run build --single --baseline
```

The result is `packages\cli\dist\cli-windows-x64-baseline\`. Keep the channel name: the desktop app finds the background service by it (`service-infinite-desktop-2.2.8.json`) and the CLI version becomes `0.0.0-infinite-desktop-2.2.8-<timestamp>`.

## 3. Add the Tor bundle

The installer carries a portable Tor. Download the Tor Expert Bundle for Windows (x86_64) from <https://www.torproject.org/download/tor/> and copy it into `packages\desktop\resources\tor\`:

```
packages\desktop\resources\tor\
  Tor\tor.exe
  Tor\pluggable_transports\lyrebird.exe
  Tor\pluggable_transports\conjure-client.exe
  data\geoip
  data\geoip6
```

This folder is ignored by git. To build without Tor, remove the `resources/tor` lines from `packages/desktop/electron-builder.config.ts` and from `electron-builder.config.test.ts`.

## 4. Build and pack the app

```powershell
cd ..\desktop
$env:OPENCODE_CHANNEL = "prod"
bun run build
bun run pack
```

`prod` takes the CLI from step 2. Without `OPENCODE_CHANNEL=prod` the build downloads the dev CLI instead, and the Infinite providers are missing.

The packed app is in `dist\desktop\app\` (run `OpenCode.exe` there to try it).

## 5. Build the installer

`pack` empties `dist\desktop`, so copy the app out first:

```powershell
Copy-Item ..\..\dist\desktop\app $env:TEMP\opencode-app -Recurse
$env:OPENCODE_DESKTOP_APP = "$env:TEMP\opencode-app"
bun run pack
```

The installer is `dist\desktop\opencode-desktop-win-x64.exe`. Release it as `OpenCode-Infinite-Desktop.exe`.

## Notes

- WARP mode needs [Cloudflare WARP](https://one.one.one.one) installed; Tor, Proxy and None need nothing else.
- Close OpenCode before you install over it.
- `bun run typecheck` and `bun test` run from `packages/desktop` and `packages/app`, never from the repository root.

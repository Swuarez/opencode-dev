# OpenCode Infinite (desktop app)

`dist/opencode-desktop-win-x64.exe` is the ready installer. Run it with OpenCode closed; it installs over the normal OpenCode.

## Build it yourself

These are only the files that differ from upstream (`anomalyco/opencode`, branch `dev`, commit `caf8d6a`), at their repository paths.

1. Clone upstream and check out `caf8d6a`.
2. Apply the changes: either `git apply opencode-infinite.patch`, or copy `packages/` over the clone.
3. Put the portable Tor bundle in `packages/desktop/resources/tor/` (`Tor/tor.exe`, `data/geoip`, `data/geoip6`), or remove the `resources/tor` lines from `packages/desktop/electron-builder.config.ts` (and its test).
4. In `packages/desktop`, with `OPENCODE_CHANNEL=prod` and the CLI staged in `packages/cli/dist/cli-windows-x64-baseline/` (`bin/opencode.exe` and a `package.json` with its version): `bun run build`, then `bun run pack`.
   Without that CLI, leave `OPENCODE_CHANNEL` unset to build the dev channel, which downloads the dev CLI by itself.
5. The installer around the packed app: `OPENCODE_DESKTOP_APP=<path to the packed app> bun run pack`.

WARP mode needs Cloudflare WARP installed; Tor, Proxy and None need nothing else.

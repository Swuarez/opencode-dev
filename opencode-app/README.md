<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset=".github/assets/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset=".github/assets/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src=".github/assets/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/release.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/v2/install | bash

# Package managers
npm i -g @opencode/cli@latest      # or bun/pnpm/yarn
brew install anomalyco/tap/opencode-v2 # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-beta              # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run github:anomalyco/opencode  # Nix
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download it from [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-win-x64.exe`     |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
```

#### Installation Directory

The install script installs OpenCode to `$HOME/.opencode/bin`.

### OpenCode Infinite

OpenCode Infinite is this fork's desktop build: it keeps free-model sessions alive. Free model access on the OpenCode
gateway is counted **per IP address**, so when a session meets the free usage limit, Infinite changes the exit IP and
sends `continue` to that same chat. Nothing else about the session changes.

Everything lives in the bottom bar. The bar shows the current mode, the exit IP and the last result, and offers one
button per action; **Advanced mode** in Settings shows every connection choice, until then only **Auto** and **None**
are listed.

#### Modes

| Mode           | Needs                                                      | Rotation                               |
| -------------- | ---------------------------------------------------------- | -------------------------------------- |
| **Auto**       | nothing (WARP if it is there)                              | –                                      |
| **None**       | nothing                                                    | –                                      |
| **WARP**       | Cloudflare WARP; the app offers to install it              | New WARP registration, so a new exit   |
| **Tor**        | nothing; Tor ships with the app                            | New circuit (`SIGNAL NEWNYM`)          |
| **Proxy**      | your HTTP proxy list, or the built-in free list            | Next working proxy of the list         |
| **SOCKS5**     | your SOCKS5 server list                                    | Next server that answers               |
| **Route64**    | a route64 `.conf` and WireGuard, both confirmed by you     | Fixed IP; rotate with another mode     |
| **Mullvad**    | Mullvad installed and logged in                            | Next country of your location list     |
| **Windscribe** | Windscribe installed and logged in                         | Next location of your location list    |

Only the OpenCode background service is routed, never the whole machine; Route64 is the exception, whose tunnel
takes over the system route by nature.

#### Free proxies

**Proxy** with an empty list picks from published free lists (proxyscrape, TheSpeedX, monosans) and tests entries in
parallel until one reaches opencode.ai. They are free and therefore slow and short-lived: put your own list in
Settings → Advanced → Proxies when it has to be reliable. One entry per line, `host:port` or
`http://user:password@host:port`; a URL that ends in a port is added as a proxy, any other URL is downloaded as a list.
Files with one entry per line can be loaded too.

Entries that answer are kept warm in the background, so a rotation is instant instead of a fresh scan; the pool keeps
one entry per address and refills itself after every use. A rotation never hands out an IP that was already used in
this run. That memory holds the last 200 addresses of the current list and is forgotten after 24 hours; a list that
is used up also starts over by itself, and Settings → Advanced → Failover chain has a button to forget it at once.

#### SOCKS5

SOCKS5 servers are converted to the HTTP proxy OpenCode speaks by a bridge on `127.0.0.1`; a server with a username and
password is supported (`socks5://user:password@host:port`). Add them in Settings → Advanced → SOCKS5 servers, one per
line.

#### Auto-rotate

While auto-rotate is on, a free-limit event (and only that: rate limits, budgets and account quotas do not change with
the IP) changes the network and resumes every chat that was waiting. The guard rails are deliberate:

- one rotation at a time; chats that arrive during one are kept and resumed after it,
- at most one rotation per 3 seconds, ten in a row then a pause of three minutes,
- a connection check every 15 seconds; two failures in a row count as a lost connection and rotate,
- the IP is proved first on a throwaway session (`run --standalone`), so the chat only meets a working IP. **Fast
  mode** skips that proof and uses the new IP immediately, which is quicker but may need another rotation,
- with Proxy mode a dead proxy is expected and retried up to 10 times; elsewhere two failed probes in a row stop the
  hunt,
- **Failover chain** (`TOR,PROXY`) moves to the next mode when the current one cannot produce a fresh IP instead of
  giving up. Empty keeps the hunt on the chosen mode.

**Reset limit** moves `auth.json` to a private folder (five newest kept) so the next start is a fresh session;
**Restore session** puts the newest one back. The backup holds API keys in plain text and lives under
`%LOCALAPPDATA%\opencode-infinite\backup\auth`.

#### DeepAI models

Sign in with a DeepAI account under Settings → Providers to use its models here. Sign-in runs over a loopback
callback: OpenCode opens `api.deepai.org`, DeepAI returns to `127.0.0.1` with a code, and the exchanged key is stored as
a credential. Requests carry DeepAI's own attribution headers, including a digest of this machine (the daily allowance
is granted once per machine); `OPENCODE_DEEPAI_MACHINE` replaces it when you want a different one. A spent DeepAI
allowance is reported as a free limit, so auto-rotate treats it like the OpenCode one.

Models whose per-request cost is 0 are free; the others spend Theos from the account. Reasoning models expose the
thinking levels DeepAI itself names.

#### Route64

Import the `.conf` from `manager.route64.org` under Settings → Advanced. The file contains your private key, so it is
saved with permissions for your user only. Bringing the tunnel up, and taking it down when you leave the mode, needs
WireGuard installed and a UAC confirmation.

#### Troubleshooting

| Symptom                             | Cause                                                       |
| ----------------------------------- | ----------------------------------------------------------- |
| "WARP does not answer"              | WARP installed but not connected, or blocked by a firewall  |
| "tor.exe not found"                 | The bundled Tor is missing from a dev run                   |
| "no free IP after 10 tries"         | Free proxies are exhausted; use your own list               |
| Mullvad/Windscribe "not installed"  | The clients are never installed by the app                  |


### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)

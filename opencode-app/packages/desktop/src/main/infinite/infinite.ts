import { app } from "electron"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { connect as tcp, createServer, type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { bringDownRoute64, bringUpRoute64, route64Status } from "./route64"
import { connectClient, disconnectClient, pickLocation, type Client } from "./vpn-clients"

// Port of the useful core of "OpenCode Infinite.bat": WARP / TOR / PROXY rotation and session renewal.
// shortcut: VPNGATE from the .bat is not ported (it needs an admin OpenVPN helper). route64 (WireGuard) lives in route64.ts.

export type Mode = "WARP" | "TOR" | "PROXY" | "SOCKS" | "ROUTE64" | "MULLVAD" | "WINDSCRIBE" | "NONE"
export type Result = { ok: boolean; message: string; ip?: string }

const WARP_PORT = 40000
const WARP_PROXY = `http://127.0.0.1:${WARP_PORT}`
const TOR_SOCKS = 19050
const TOR_CONTROL = 19051
const TOR_HTTP = 18118
const SOCKS_HTTP = 18119
type SocksTarget = { host: string; port: number; user?: string; pass?: string }
const KEEP_BACKUPS = 5
// Exit IPs remembered as already used; a proxy list shorter than this simply starts over once it is exhausted.
const BURNED_MAX = 200
// The used-IP memory expires on its own, so a proxy list gets a fresh round every day.
const BURNED_FORGET_MS = 24 * 60 * 60 * 1000
const TRACE = "https://www.cloudflare.com/cdn-cgi/trace"
const LISTS = [
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
]

/** The first free list that answers with something usable; one dead source must not take the mode down. */
async function anyList() {
  for (const url of LISTS) {
    const text = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      .then((res) => (res.ok ? res.text() : ""))
      .catch(() => "")
    if (/\d{1,3}(\.\d{1,3}){3}:\d{2,5}/.test(text)) return text
  }
  return ""
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settings = () => path.join(app.getPath("userData"), "infinite.json")

// --- saved mode ---------------------------------------------------------------------------------------------------

type Saved = {
  mode: Mode
  proxy?: string
  socksCurrent?: string
  custom?: string
  auto: boolean
  country: string
  fast: boolean
  rotateUrl: string
  vpnLocations: string
  socks: string
  /** Exit IPs already used; a rotation does not hand out one of these again. */
  burned: string[]
  /** When the used-IP window started; after a day the whole list is forgotten. */
  burnedAt: number
  /** Modes used as a fallback, in order, when the current one cannot produce a fresh IP. */
  chain: string
}
let saved: Saved | undefined
const MODES: Mode[] = ["WARP", "TOR", "PROXY", "SOCKS", "ROUTE64", "MULLVAD", "WINDSCRIBE"]

function load(): Saved {
  if (saved) return saved
  try {
    // Sync on purpose: the first background-service spawn needs the mode before any IPC call arrives.
    const raw = JSON.parse(readFileSync(settings(), "utf8"))
    saved = {
      mode: MODES.includes(raw.mode) ? raw.mode : "NONE",
      proxy: raw.proxy,
      socksCurrent: typeof raw.socksCurrent === "string" ? raw.socksCurrent : undefined,
      custom: typeof raw.custom === "string" ? raw.custom : undefined,
      auto: raw.auto === true,
      country: typeof raw.country === "string" && /^[A-Za-z]{2}$/.test(raw.country) ? raw.country.toUpperCase() : "",
      fast: raw.fast === true,
      rotateUrl: typeof raw.rotateUrl === "string" ? raw.rotateUrl : "",
      vpnLocations: typeof raw.vpnLocations === "string" ? raw.vpnLocations : "",
      socks: typeof raw.socks === "string" ? raw.socks : "",
      burned: Array.isArray(raw.burned) ? raw.burned.filter((ip: unknown) => typeof ip === "string").slice(-BURNED_MAX) : [],
      burnedAt: typeof raw.burnedAt === "number" ? raw.burnedAt : 0,
      chain: typeof raw.chain === "string" ? raw.chain : "",
    }
  } catch {
    saved = {
      mode: "NONE",
      auto: false,
      country: "",
      fast: false,
      rotateUrl: "",
      vpnLocations: "",
      socks: "",
      burned: [],
      burnedAt: 0,
      chain: "",
    }
  }
  // Old entries would keep a list blocked forever; a window older than a day starts empty again.
  if (burnedExpired(saved.burnedAt)) {
    saved.burned = []
    saved.burnedAt = 0
  }
  return saved
}

export type Options = {
  auto: boolean
  country: string
  custom: string
  fast: boolean
  /** Optional URL that changes the IP when opened; called before each rotation in Proxy mode. */
  rotateUrl: string
  /** Mullvad country codes or Windscribe location names, separated by commas or spaces. Empty means the default. */
  vpnLocations: string
  /** SOCKS5 servers as host:port, socks5://host:port or socks5://user:password@host:port. Empty means none. */
  socks: string
  /** Modes to fall back to, in order, when the current one cannot get a fresh IP (for example "TOR,PROXY"). */
  chain: string
  /** Read only: how many exit IPs are currently remembered as used. */
  burned: number
}
export const getOptions = (): Options => ({
  auto: load().auto,
  country: load().country,
  custom: load().custom ?? "",
  fast: load().fast,
  rotateUrl: load().rotateUrl,
  vpnLocations: load().vpnLocations,
  socks: load().socks,
  chain: load().chain,
  burned: burnedList().length,
})

/** Modes the auto-rotate may switch to, in order; the current mode is never repeated. */
/** Keeps only real modes, in upper case, without duplicates or the mode already in use. */
const normalizeChain = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((entry) => entry.toUpperCase() as Mode)
    .filter((mode, index, all) => MODES.includes(mode) && mode !== getMode() && all.indexOf(mode) === index)
    .join(",")

const failover = () => normalizeChain(load().chain).split(",").filter((entry): entry is Mode => entry !== "")

const LABELS: Partial<Record<Mode, string>> = {
  WARP: "WARP",
  TOR: "Tor",
  PROXY: "Proxy",
  SOCKS: "SOCKS5",
  MULLVAD: "Mullvad",
  WINDSCRIBE: "Windscribe",
}

// --- used IPs -----------------------------------------------------------------------------------------------------

/** True once the used-IP window is a day old; an empty window never expires. */
export const burnedExpired = (burnedAt: number, now = Date.now()) => burnedAt > 0 && now - burnedAt > BURNED_FORGET_MS

const burnedList = () => load().burned ?? []
const isBurned = (ip: string | undefined) => !!ip && burnedList().includes(ip)
const proxyIp = (proxy: string) => proxy.slice(proxy.indexOf("://") + 3).replace(/^.*@/, "").split(":")[0]!

/** Remembers an IP as used, so the next rotation does not land on it again. */
function burn(ip: string | undefined) {
  if (!ip) return
  // The window starts with the first IP of the day and carries every later one.
  if (!load().burnedAt) load().burnedAt = Date.now()
  load().burned = [...burnedList().filter((entry) => entry !== ip), ip].slice(-BURNED_MAX)
}

/** A list this short uses every entry up: forget the burned IPs of that list instead of failing on them. */
function unburnList(list: string[]) {
  load().burned = burnedList().filter((ip) => !list.some((entry) => proxyIp(entry) === ip))
  if (!load().burned.length) load().burnedAt = 0
}

export const clearBurned = async (): Promise<Result> => {
  load().burned = []
  load().burnedAt = 0
  await save()
  return { ok: true, message: "Used IPs forgotten; they can be handed out again." }
}

const vpnLocations = () => load().vpnLocations.split(/[\s,;]+/).filter(Boolean)

const normalizeRotateUrl = (value: string) => {
  const text = value.trim()
  return /^https?:\/\//i.test(text) && URL.canParse(text) ? text : ""
}

/** "host:port" or a full http(s) URL (credentials allowed); anything else counts as no custom proxy. */
const normalizeProxy = (value: string) => {
  const text = value.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return undefined
  if (!/:\d{1,5}\/?$/.test(text)) return undefined // a proxy always names its port
  const url = /^https?:\/\//i.test(text) ? text : `http://${text}`
  return text && URL.canParse(url) && new URL(url).hostname ? url : undefined
}

/** Any pasted list or file content: separated by lines, spaces, commas or semicolons. Invalid entries are dropped. */
// shortcut: HTTP(S) proxies only (no socks://), at most 500 entries; fine for what OpenCode can use.
const normalizeProxies = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).flatMap((token) => normalizeProxy(token) ?? []))].slice(0, 500)

/** "host:port", "socks5://host:port" or "socks5://user:password@host:port"; anything else is dropped. */
export function parseSocks(token: string): SocksTarget | undefined {
  const text = token.trim()
  if (!text) return undefined
  const bare = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`
  if (!/^socks5h?:\/\//i.test(bare)) return undefined
  if (!URL.canParse(bare)) return undefined
  const url = new URL(bare)
  if (!url.hostname || !/^\d{1,5}$/.test(url.port)) return undefined
  const port = Number(url.port)
  if (port < 1 || port > 65_535) return undefined
  return {
    host: url.hostname,
    port,
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { pass: decodeURIComponent(url.password) } : {}),
  }
}

/** Same list rules as the HTTP proxies; a SOCKS5 server always needs its port. */
const normalizeSocks = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).flatMap((token) => (parseSocks(token) ? [parseSocks(token)!] : [])))]
    .slice(0, 500)
    .map(formatSocks)

const formatSocks = (target: SocksTarget) =>
  `socks5://${target.user ? `${encodeURIComponent(target.user)}${target.pass ? `:${encodeURIComponent(target.pass)}` : ""}@` : ""}${target.host}:${target.port}`

const socksList = () => (load().socks ?? "").split(/[,\s;]+/).flatMap((line) => parseSocks(line) ?? [])

/** Downloads a proxy list from a URL the user typed (the renderer cannot: CORS). Text only, 2 MB at most. */
export async function fetchList(url: string): Promise<{ ok: boolean; text: string }> {
  if (!/^https?:\/\//i.test(url.trim()) || !URL.canParse(url.trim())) return { ok: false, text: "" }
  const text = await fetch(url.trim(), { signal: AbortSignal.timeout(10_000) })
    .then((res) => (res.ok ? res.text() : ""))
    .catch(() => "")
  return text && text.length <= 2_000_000 ? { ok: true, text } : { ok: false, text: "" }
}

const customList = () => (load().custom ?? "").split("\n").filter(Boolean)

export async function setOptions(next: Options) {
  load().auto = next.auto
  load().fast = next.fast === true
  load().custom = normalizeProxies(next.custom).join("\n") || undefined
  load().country = /^[A-Za-z]{2}$/.test(next.country) ? next.country.toUpperCase() : ""
  load().rotateUrl = normalizeRotateUrl(next.rotateUrl ?? "")
  load().vpnLocations = (next.vpnLocations ?? "").split(/[\s,;]+/).filter(Boolean).join(", ")
  load().socks = normalizeSocks(next.socks ?? "").join("\n")
  load().chain = normalizeChain(next.chain ?? "")
  await save()
}

const save = () => writeFile(settings(), JSON.stringify(load()))

export const getMode = () => load().mode

export async function setMode(next: Mode) {
  load().mode = next
  await save()
}

function upstream() {
  const { mode, proxy } = load()
  if (mode === "WARP") return WARP_PROXY
  if (mode === "TOR") return `http://127.0.0.1:${TOR_HTTP}`
  if (mode === "PROXY") return proxy
  if (mode === "SOCKS") return `http://127.0.0.1:${SOCKS_HTTP}`
}

/** Environment handed to the background service so only OpenCode goes through the proxy. */
export function proxyEnv(): Record<string, string> {
  const url = upstream()
  if (!url) return {}
  const skip = "127.0.0.1,localhost,::1"
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: skip, no_proxy: skip }
}

// Context windows measured against the free models (largest prompt that passed, 2026-11). Only the ones whose
// declared window was wrong are listed; the rest (glm-5.3, iceman, flint at 262144, mimo-v2.6 at 327680, the 1M
// models) already declare what they take.
// shortcut: a fixed table, a model that changes upstream keeps this value; measure again if a model starts failing.
const MODEL_LIMITS: Record<string, { context: number; input?: number }> = {
  "deepseek-v4.1-flash-free": { context: 262_144 },
  "nemotron-3.5-lightning-free": { context: 490_000 },
  "big-pickle": { context: 305_000, input: 305_000 },
}

/** Everything the background service gets from Infinite: the proxy, and the context limits as inline config. */
export function serviceEnv(): Record<string, string> {
  // A config the user passed in the environment themselves wins.
  if (process.env.OPENCODE_CONFIG_CONTENT) return proxyEnv()
  const models = Object.fromEntries(Object.entries(MODEL_LIMITS).map(([id, limit]) => [id, { limit }]))
  return { ...proxyEnv(), OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { opencode: { models } } }) }
}

function run(file: string, args: string[], timeout = 20_000) {
  return new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}` }),
    )
  })
}

// --- WARP ---------------------------------------------------------------------------------------------------------

const warpExe = () =>
  process.platform === "win32" ? "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe" : "warp-cli"
const warp = (...args: string[]) => run(warpExe(), ["--accept-tos", ...args])

/** The exit IP seen through the WARP proxy, or undefined while WARP is not on. */
async function trace() {
  const res = await run("curl", ["-s", "-m", "4", "-x", WARP_PROXY, TRACE], 6000)
  if (!res.ok || !/^warp=on$/m.test(res.out)) return undefined
  return { ip: /^ip=(.+)$/m.exec(res.out)?.[1], loc: /^loc=(.+)$/m.exec(res.out)?.[1] }
}

/** Polls every 400 ms for up to 30 s, so the answer lands as soon as WARP is up. */
async function waitProxy() {
  for (let i = 0; i < 75; i++) {
    const found = await trace()
    if (found?.ip) return found
    await sleep(400)
  }
  return undefined
}

type Connected = Result & { loc?: string }

async function connect(): Promise<Connected> {
  if (!(await warp("status")).ok) return { ok: false, message: "warp-cli not found (is Cloudflare WARP installed?)." }
  await warp("mode", "proxy")
  await warp("proxy", "port", String(WARP_PORT))
  if (!(await warp("connect")).ok) return { ok: false, message: "warp-cli connect failed." }
  const found = await waitProxy()
  return found
    ? { ok: true, ip: found.ip, loc: found.loc, message: "WARP active" }
    : { ok: false, message: "WARP does not answer on 127.0.0.1:40000." }
}

/** A new registration gives a new exit IP; with a target country it re-registers until the exit lands there. */
async function rotateWarp(): Promise<Result> {
  const want = load().country
  const tries = want ? 8 : 1
  let last: Connected = { ok: false, message: "" }
  for (let attempt = 1; attempt <= tries; attempt++) {
    last = await newWarpRegistration()
    if (!last.ok) return last
    if (!want || last.loc?.toUpperCase() === want) return want ? { ...last, message: `${last.message} (${want}, try ${attempt})` } : last
  }
  return { ...last, ok: false, message: `No ${want} exit after ${tries} tries (last: ${last.loc ?? "?"}, IP ${last.ip}).` }
}

/** Same steps and waits as :reg_drop / :reg_new in the .bat. */
async function newWarpRegistration(): Promise<Connected> {
  await warp("disconnect")
  await warp("registration", "delete")
  // The delete returns before the daemon lets go; wait until `registration show` stops answering.
  for (let i = 0; i < 15 && (await warp("registration", "show")).ok; i++) await sleep(300)
  // Cloudflare refuses new registrations for a while after many in a row (seen in a live run); back off, then give up.
  let created = await warp("registration", "new")
  for (const wait of [2_000, 5_000, 10_000]) {
    if (created.ok) break
    await sleep(wait)
    created = await warp("registration", "new")
  }
  if (!created.ok)
    return {
      ok: false,
      message: "Could not create a WARP registration. Try warp-cli registration delete / new as administrator.",
    }
  return connect()
}

// --- session ------------------------------------------------------------------------------------------------------

const dataDir = () => path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode")
const backupDir = () =>
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "state"), "opencode-infinite", "backup", "auth")

/** Copy auth.json to the private backup folder, verify it, then remove it. Returns false when there was none. */
export async function archiveAuth() {
  const file = path.join(dataDir(), "auth.json")
  if (!(await stat(file).catch(() => undefined))) return false
  const dir = path.join(backupDir(), new Date().toISOString().replace(/[:.]/g, "-"))
  await mkdir(dir, { recursive: true })
  const copy = path.join(dir, "auth.json")
  await copyFile(file, copy)
  const [a, b] = await Promise.all([readFile(file), readFile(copy)])
  if (!a.equals(b)) throw new Error("The auth.json backup does not match; it was not removed.")
  await unlink(file)
  // The copies hold API keys in plain text: keep only the newest few.
  const old = (await readdir(backupDir())).sort().slice(0, -KEEP_BACKUPS)
  await Promise.all(old.map((name) => rm(path.join(backupDir(), name), { recursive: true, force: true })))
  return true
}

/** Put back the newest auth.json backup made by "Reset limit"; never overwrites a live session. */
export async function restoreSession(): Promise<Result> {
  const target = path.join(dataDir(), "auth.json")
  if (await stat(target).catch(() => undefined)) return { ok: false, message: "A session already exists; nothing restored." }
  const newest = (await readdir(backupDir()).catch(() => [] as string[])).sort().at(-1)
  if (!newest) return { ok: false, message: "No session backup found." }
  await mkdir(dataDir(), { recursive: true })
  await copyFile(path.join(backupDir(), newest, "auth.json"), target)
  return { ok: true, message: `Session restored from ${newest}.` }
}

// --- Tor ----------------------------------------------------------------------------------------------------------

const tor = { child: undefined as ChildProcess | undefined }
// The Tor bundled with the app wins; the one the .bat installed under LOCALAPPDATA is the fallback (dev runs).
const bundledTor = path.join(process.resourcesPath ?? "", "tor", "Tor", "tor.exe")
const torExe = () =>
  existsSync(bundledTor) ? bundledTor : path.join(process.env.LOCALAPPDATA ?? "", "opencode-infinite", "tor", "Tor", "tor.exe")

/** The exit IP through Tor's SOCKS port, or undefined while no circuit works (forced exits can be slow to build). */
async function torIp() {
  const res = await run("curl", ["-s", "-m", "6", "--socks5-hostname", `127.0.0.1:${TOR_SOCKS}`, TRACE], 8000)
  return res.ok ? /^ip=(.+)$/m.exec(res.out)?.[1] : undefined
}

/** One short conversation with Tor's control port; resolves with everything Tor answered. */
function control(commands: string[]) {
  return new Promise<string>((resolve) => {
    let out = ""
    const socket = tcp(TOR_CONTROL, "127.0.0.1")
    socket.setTimeout(8000, () => socket.destroy())
    socket.on("data", (chunk) => (out += chunk))
    socket.on("error", () => undefined)
    socket.on("close", () => resolve(out))
    socket.write(["AUTHENTICATE", ...commands, "QUIT", ""].join("\r\n"))
  })
}

// --- CONNECT -> SOCKS5 bridge -------------------------------------------------------------------------------------
// OpenCode (Bun) only speaks HTTP proxies, so every SOCKS route is served to it as a local HTTP proxy. One bridge
// per route: Tor's own port, and the SOCKS5 port for the list the user supplied.

type Bridge = { tunnels: Set<Socket> }
const bridges = new Map<number, Bridge>()

/** Forgets open tunnels so the client reconnects: a new circuit or server is only used by a new connection. */
function dropTunnels(port: number) {
  bridges.get(port)?.tunnels.forEach((socket) => socket.destroy())
}

/** Minimal HTTP CONNECT -> SOCKS5 bridge. `target` is read per connection, so a rotation needs no restart. */
// shortcut: CONNECT (https) only, no plain-HTTP forwarding; fine for the API calls OpenCode makes.
function startBridge(localPort: number, target: () => SocksTarget | undefined) {
  if (bridges.has(localPort)) return
  const state: Bridge = { tunnels: new Set() }
  bridges.set(localPort, state)
  createServer((client) => {
    state.tunnels.add(client)
    client.once("close", () => state.tunnels.delete(client))
    client.once("data", (head) => {
      const match = /^CONNECT (\S+):(\d+) HTTP/.exec(head.toString("latin1"))
      const socks = match && target()
      if (!match || !socks) return client.destroy()
      const upstream = tcp(socks.port, socks.host)
      const fail = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on("error", fail)
      upstream.on("error", fail)
      upstream.once("connect", () => {
        // Offer no-auth plus username/password only when the entry carries credentials.
        upstream.write(Buffer.from(socks.user ? [5, 2, 0, 2] : [5, 1, 0]))
      })
      upstream.once("data", (greeting) => {
        if (greeting[0] !== 5) return fail()
        if (greeting[1] === 2) {
          if (!socks.user) return fail()
          const user = Buffer.from(socks.user)
          const pass = Buffer.from(socks.pass ?? "")
          upstream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
          upstream.once("data", (auth) => auth[1] === 0 ? connect() : fail())
          return
        }
        if (greeting[1] !== 0) return fail()
        connect()
      })
      const connect = () => {
        const host = Buffer.from(match[1]!)
        const port = Number(match[2])
        upstream.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([port >> 8, port & 255])]))
        upstream.once("data", (reply) => {
          if (reply[1] !== 0) return fail()
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          client.pipe(upstream)
          upstream.pipe(client)
        })
      }
    })
  })
    .on("error", () => undefined) // port already taken: another bridge is serving it
    .listen(localPort, "127.0.0.1")
}

let starting: Promise<Result> | undefined
// Service start, mode change and IP check all call this; they share one start-up instead of racing to spawn two Tors.
const startTor = () => (starting ??= bootTor().finally(() => (starting = undefined)))

async function bootTor(): Promise<Result> {
  startBridge(TOR_HTTP, () => ({ host: "127.0.0.1", port: TOR_SOCKS }))
  if (!tor.child) {
    if (!(await stat(torExe()).catch(() => undefined))) return { ok: false, message: `tor.exe not found at ${torExe()}` }
    const dir = path.join(app.getPath("userData"), "tor")
    await mkdir(dir, { recursive: true })
    const rc = path.join(dir, "torrc")
    const data = path.join(dir, "data").replace(/\\/g, "/")
    // GeoIP files let Tor resolve ExitNodes={cc}; they ship next to the portable bundle.
    const geo = path.join(path.dirname(path.dirname(torExe())), "data").replace(/\\/g, "/")
    const hasGeo = await stat(`${geo}/geoip`).then(() => true, () => false)
    const country = load().country
    await writeFile(
      rc,
      [
        `SocksPort 127.0.0.1:${TOR_SOCKS}`,
        `ControlPort 127.0.0.1:${TOR_CONTROL}`,
        "CookieAuthentication 0",
        `DataDirectory ${data}`,
        ...(hasGeo ? [`GeoIPFile ${geo}/geoip`, `GeoIPv6File ${geo}/geoip6`] : []),
        ...(hasGeo && country ? [`ExitNodes {${country.toLowerCase()}}`, "StrictNodes 1"] : []),
        "",
      ].join("\n"),
    )
    tor.child = spawn(torExe(), ["-f", rc], { windowsHide: true, stdio: "ignore" })
    tor.child.once("exit", () => (tor.child = undefined))
    app.once("will-quit", () => tor.child?.kill())
  }
  for (let i = 0; i < 180; i++) {
    const ip = await torIp()
    if (ip) return { ok: true, ip, message: "Tor active" }
    await sleep(500)
  }
  return { ok: false, message: "Tor did not finish connecting in 90 s." }
}

async function rotateTor(): Promise<Result> {
  const up = await startTor()
  if (!up.ok) return up
  const country = load().country
  const exits = country ? `SETCONF ExitNodes={${country.toLowerCase()}} StrictNodes=1` : "SETCONF ExitNodes StrictNodes"
  const reply = await control([exits, "SIGNAL NEWNYM"])
  if ((reply.match(/^250 OK/gm) ?? []).length < 3) return { ok: false, message: "Tor refused the new circuit request." }
  // Open tunnels keep their old circuit alive; closing them makes the client reconnect through the new one.
  dropTunnels(TOR_HTTP)
  // The new circuit needs a moment to build; probe quickly instead of waiting a fixed time.
  let latest: string | undefined
  for (let i = 0; i < 40; i++) {
    latest = (await torIp()) ?? latest
    if (latest && latest !== known.TOR) break
    await sleep(400)
  }
  // The same exit can legitimately come back; that still counts as a working circuit.
  return latest
    ? { ok: true, ip: latest, message: "Tor new circuit" }
    : { ok: false, message: "Tor did not answer after the new circuit." }
}

// --- free proxies -------------------------------------------------------------------------------------------------

const proxyWorks = (p: string) =>
  run("curl", ["-s", "-m", "2", "-o", os.devNull, "-w", "%{http_code}", "-x", p, "https://opencode.ai"], 3000).then(
    (c) => c.ok && /^[23]\d\d$/.test(c.out.trim()),
  )

/** Resolves with the first proxy of the list that works, without waiting for the slow ones. */
const firstWorking = (list: string[]) =>
  new Promise<string | undefined>((resolve) => {
    let pending = list.length
    for (const p of list)
      void proxyWorks(p).then((ok) => {
        if (ok) resolve(p)
        else if (--pending === 0) resolve(undefined)
      })
  })

// Proxies that answered recently, so a rotation is instant instead of a fresh scan every time.
const POOL_TARGET = 30
const POOL_TTL = 10 * 60_000
// Free lists are mostly dead, so a refill tests a bounded slice against a deadline instead of the whole file.
const REFILL_MAX = 60
const REFILL_DEADLINE = 25_000
const pool = new Map<string, number>()
const poolLive = () => [...pool].filter(([, at]) => Date.now() - at < POOL_TTL).map(([proxy]) => proxy)
let filling: Promise<void> | undefined

const freeProxies = async () =>
  (await anyList())
    .split(/\s+/)
    .map((line) => line.replace(/^http:\/\//, ""))
    .filter((line) => /^[\d.]+:\d+$/.test(line))
    .map((line) => `http://${line}`)

/** Whatever the pool is filled from: your own list when there is one, the built-in free lists otherwise. */
const sources = async () => (load().custom ? customList() : await freeProxies())

/** Keeps a warm set of answering proxies; safe to call anywhere, it never runs twice at once. */
const refillPool = () =>
  (filling ??= (async () => {
    const deadline = Date.now() + REFILL_DEADLINE
    const list = (await sources())
      .filter((proxy) => !pool.has(proxy) && !isBurned(proxyIp(proxy)))
      .sort(() => Math.random() - 0.5)
      .slice(0, REFILL_MAX)
    for (let i = 0; i < list.length && poolLive().length < POOL_TARGET && Date.now() < deadline; i += 40)
      await Promise.all(
        list.slice(i, i + 40).map(async (proxy) => {
          const ip = proxyIp(proxy)
          if (await proxyWorks(proxy)) if (![...pool.keys()].some((entry) => proxyIp(entry) === ip)) pool.set(proxy, Date.now())
        }),
      )
  })().finally(() => (filling = undefined)))

const refillPoolIfProxy = () => {
  if (getMode() === "PROXY") void refillPool()
}

/** Hands out a proxy that was not used yet, preferring the validated pool over a fresh scan. */
async function pickProxy(): Promise<Result> {
  const own = customList()
  // A short list cannot avoid its own burned addresses forever; start its round again instead of giving up.
  if (own.length && own.every((proxy) => isBurned(proxyIp(proxy)))) unburnList(own)
  const usable = (proxy: string) =>
    proxy !== load().proxy && proxyIp(proxy) !== known[getMode()] && !isBurned(proxyIp(proxy))
  const hot = () =>
    poolLive()
      .sort(() => Math.random() - 0.5)
      .find(usable)
  let hit = hot()
  if (!hit) {
    // Take the first proxy that answers instead of waiting for the whole pool to fill.
    let finished = false
    const running = refillPool().finally(() => (finished = true))
    while (!hit && !finished) {
      await sleep(250)
      hit = hot()
    }
    await running
    hit = hit ?? hot()
  }
  // A free list is luck: give a failed round a second, different draw before reporting nothing.
  for (let round = 0; !hit && round < 2; round++)
    hit = await firstWorking(
      (await sources())
        .filter(usable)
        .sort(() => Math.random() - 0.5)
        .slice(0, 60),
    )
  if (!hit)
    return {
      ok: false,
      message: own.length
        ? `None of your ${own.length} proxies answers (check host, port and login).`
        : "No working free proxy found; try again.",
    }
  load().proxy = hit
  await save()
  // Restock in the background so the next rotation finds something without waiting.
  refillPoolIfProxy()
  return { ok: true, ip: proxyIp(hit), message: own.length ? `Your proxy (${own.length} in the list)` : `Proxy ${hit}` }
}

// --- public -------------------------------------------------------------------------------------------------------

/** Kicks the current mode into shape before the background service starts behind it. */
export async function prepareMode() {
  if (getMode() === "TOR") await startTor()
  // Warming the pool in the background makes the first rotation instant instead of a full scan.
  if (getMode() === "PROXY") void refillPool()
  // The SOCKS bridge serves a stored entry, so it has to be listening before the service starts.
  if (getMode() === "SOCKS") startBridge(SOCKS_HTTP, () => parseSocks(load().socksCurrent ?? ""))
  // The SOCKS bridge serves a stored entry, so it has to be listening before the service starts.
  if (getMode() === "SOCKS") startBridge(SOCKS_HTTP, () => parseSocks(load().socksCurrent ?? ""))
}

/** Proxy mode with a change-IP URL: open it first so the provider gives a new IP before the next proxy is picked. */
async function changeIpUrl(): Promise<Result | undefined> {
  const { rotateUrl } = load()
  if (!rotateUrl) return undefined
  const opened = await fetch(rotateUrl, { signal: AbortSignal.timeout(15_000) }).then(
    (res) => res.ok,
    () => false,
  )
  if (!opened) return { ok: false, message: "The change-IP URL did not answer." }
  await sleep(2_000) // give the provider a moment to apply the new IP before the probe
  return undefined
}

const socksTrace = (port: number) =>
  run("curl", ["-s", "-m", "8", "-x", `http://127.0.0.1:${port}`, TRACE], 10_000).then((res) =>
    res.ok ? /^ip=(.+)$/m.exec(res.out)?.[1] : undefined,
  )

/** SOCKS5: move to another server of the user's list and prove the bridge reaches the internet through it. */
async function rotateSocks(): Promise<Result> {
  const pool = socksList()
  if (!pool.length) return { ok: false, message: "Add SOCKS5 servers in Settings → Advanced first." }
  const current = load().socksCurrent
  const rest = pool.filter((entry) => formatSocks(entry) !== current)
  const order = (rest.length ? rest : pool).sort(() => Math.random() - 0.5)
  startBridge(SOCKS_HTTP, () => parseSocks(load().socksCurrent ?? ""))
  for (const entry of order.slice(0, 20)) {
    load().socksCurrent = formatSocks(entry)
    const ip = await socksTrace(SOCKS_HTTP)
    // A server that hands out an IP this run already used is no better than the one it replaces.
    if (!ip || isBurned(ip)) continue
    dropTunnels(SOCKS_HTTP)
    await save()
    return { ok: true, ip, message: `SOCKS5 ${entry.host}:${entry.port}` }
  }
  return { ok: false, message: `None of the last ${Math.min(order.length, 20)} SOCKS5 servers answered.` }
}

async function rotateProxy(): Promise<Result> {
  const failed = await changeIpUrl()
  return failed ?? pickProxy()
}

const lastVpn: Partial<Record<Client, string>> = {}

/** Mullvad or Windscribe: switch to another location of the user's list and reconnect. */
async function rotateVpn(client: Client): Promise<Result> {
  const location = pickLocation(client, vpnLocations(), lastVpn[client])
  const up = await connectClient(client, location)
  if (!up.ok) return { ok: false, message: up.message }
  lastVpn[client] = location
  const net = await checkIp()
  return { ok: true, ip: net.ip, message: up.message }
}

export const rotate = (m: Mode): Promise<Result> => {
  if (m === "WARP") return rotateWarp()
  if (m === "TOR") return rotateTor()
  if (m === "PROXY") return rotateProxy()
  if (m === "SOCKS") return rotateSocks()
  if (m === "MULLVAD" || m === "WINDSCRIBE") return rotateVpn(m)
  // route64 gives one fixed IP; failing here stops the hunt instead of looping on the same address.
  if (m === "ROUTE64") return Promise.resolve({ ok: false, message: "route64 has a fixed IP: pick another mode to get a new one." })
  return Promise.resolve({ ok: true, message: "No proxy (NONE)." })
}

/** WARP, Tor and None keep the same proxy URL across a rotation, so the service can start before the new IP is ready. */
export const upstreamKnown = () => getMode() !== "PROXY"

/** Apply a mode change before the service is restarted behind it. */
export async function applyMode(next: Mode): Promise<Result> {
  await setMode(next)
  if (next === "WARP") return remember(await connect())
  if (next === "TOR") return remember(await startTor())
  if (next === "SOCKS") {
    if (!socksList().length) return { ok: false, message: "Add SOCKS5 servers in Settings → Advanced first." }
    return remember(await rotateSocks())
  }
  if (next === "PROXY") {
    const kept = load().custom ? undefined : load().proxy
    const fresh = kept && !isBurned(proxyIp(kept)) && (await proxyWorks(kept))
    return remember(fresh ? { ok: true, ip: proxyIp(kept), message: `Proxy ${kept}` } : await pickProxy())
  }
  // The route64 tunnel carries all traffic itself, so the service needs no proxy; it only has to be up.
  if (next === "ROUTE64") {
    const status = await route64Status()
    if (!status.imported) return { ok: false, message: "Import a route64 .conf in Settings first." }
    if (!status.up) {
      const up = await bringUpRoute64()
      if (!up.ok) return up
    }
    return remember(await checkIp())
  }
  if (next === "MULLVAD" || next === "WINDSCRIBE") return remember(await rotateVpn(next))
  return { ok: true, message: "No proxy (NONE)." }
}

/** Undoes what the previous mode left running: the route64 tunnel and the VPN client connection. */
export async function leaveMode(previous: Mode, next: Mode) {
  if (previous === next) return
  if (previous === "ROUTE64") await bringDownRoute64()
  if (previous === "MULLVAD" || previous === "WINDSCRIBE") await disconnectClient(previous)
}

// The last IP each mode was seen with, shown when a check cannot reach the internet right now.
const known: Partial<Record<Mode, string>> = {}
/** Keeps the IP a mode is on and remembers the one it replaced as used. */
async function remember(result: Result) {
  const mode = getMode()
  // The IP being replaced must not come back from the next rotation, so it is remembered as used.
  if (result.ok && result.ip && result.ip !== known[mode]) {
    burn(known[mode])
    await save()
  }
  if (result.ok && result.ip) known[mode] = result.ip
  return result
}

/** The exit IP as the internet sees it through the current mode (direct for NONE). */
export async function checkIp(): Promise<Result> {
  const mode = getMode()
  // Right after launch Tor may still be bootstrapping; wait for it instead of reporting a failure.
  if (mode === "TOR") await startTor()
  // The SOCKS bridge is what the service talks to, so it must exist even before a rotation picked an entry.
  if (mode === "SOCKS") startBridge(SOCKS_HTTP, () => parseSocks(load().socksCurrent ?? ""))
  const url = upstream()
  // A proxy mode without a proxy would answer with the real IP; that is not what OpenCode uses.
  if (mode === "PROXY" && !url) return { ok: false, message: "connecting…" }
  const res = await run("curl", ["-s", "-m", "10", ...(url ? ["-x", url] : []), TRACE])
  const ip = /^ip=(.+)$/m.exec(res.out)?.[1]
  // Saved mode WARP but the daemon is not connected yet (fresh launch): bring it up instead of waiting for a click.
  // The reconnect takes the lock too, so it can never race a rotation that starts in the same moment.
  if (!ip && mode === "WARP") {
    const release = lock()
    const up = release ? await connect().finally(release) : undefined
    if (up?.ok && up.ip) {
      const done = await remember(up)
      return { ok: true, ip: done.ip, message: "" }
    }
  }
  // The IP is shown on its own by the bar, so the message only says what else is going on.
  if (res.ok && ip) {
    known[mode] = ip
    return { ok: true, ip, message: autoNote ?? "" }
  }
  // Not reachable right now (still connecting, or rotating): show the IP OpenCode was last using, not an error.
  const last = known[mode]
  return last ? { ok: false, ip: last, message: "not answering right now" } : { ok: false, message: "connecting…" }
}

// --- auto-rotate --------------------------------------------------------------------------------------------------

let locked = false
let autoNote = ""

/** One action at a time: a manual click and the watcher must never rotate the network at the same moment. */
export function lock() {
  if (locked) return undefined
  locked = true
  return () => void (locked = false)
}

/** Rotate the network only; unlike "Reset limit" the session (auth.json) stays untouched. */
export const rotateOnly = () => rotate(getMode()).then(remember)

const PROBE_MODEL = "opencode/deepseek-v4.1-flash-free"
// Only what a new IP can lift. A budget or credit message is not one: it ends the hunt as a failed probe instead.
const PROBE_LIMIT = /free usage limit|rate limit|too many requests/i
const HUNT_MAX = 10

/** One cheap message on a throwaway session (`run --standalone` has its own server) through the current proxy. */
export function probeIp(command: readonly string[]) {
  return new Promise<"ok" | "limit" | "failed">((resolve) => {
    // --archived keeps the probe sessions out of the session list.
    const args = ["run", "--standalone", "--archived", "-m", PROBE_MODEL, "Reply with exactly the word: pong"]
    const proc = spawn(command[0]!, [...command.slice(1), ...args], {
      env: { ...process.env, ...proxyEnv() },
      windowsHide: true,
      // stdin must be closed: `run` reads it when it is a pipe and would wait there until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    proc.stdout.on("data", (chunk) => (out += chunk))
    proc.stderr.on("data", (chunk) => (err += chunk))
    const timer = setTimeout(() => proc.kill(), 60_000)
    proc.once("error", () => resolve("failed"))
    proc.once("close", (code) => {
      clearTimeout(timer)
      // Only the answer that was asked for proves the IP works; only a limit text proves it is burned.
      if (code === 0 && /pong/i.test(out)) return resolve("ok")
      resolve(PROBE_LIMIT.test(err) || PROBE_LIMIT.test(out) ? "limit" : "failed")
    })
  })
}

/** Rotates until a probe on a throwaway session gets an answer, so the chat only ever meets a working IP. */
export async function huntIp(command: readonly string[]): Promise<Result> {
  const result = await hunt(command)
  // A failure ends here; after a success the caller still has to send "continue" and reports that itself.
  if (!result.ok) autoStatus(`auto-rotate failed: ${result.message}`, true)
  return result
}

/** What the bar shows about Auto-rotate: only what has really happened, with the time once it is over. */
export function autoStatus(text: string, done = false) {
  autoNote = done ? `${text} (${new Date().toLocaleTimeString()})` : text
}

async function hunt(command: readonly string[]): Promise<Result> {
  const chain = [getMode(), ...failover()]
  // None has no IP to change: probing it again would only spend free messages.
  if (chain.length === 1 && getMode() === "NONE")
    return { ok: false, message: "pick WARP, Tor or Proxy first (None cannot change the IP)" }
  // A dead free proxy fails the probe without being a limit, so Proxy keeps trying; elsewhere two in a row mean the probe is broken.
  const brokenMax = () => (getMode() === "PROXY" ? HUNT_MAX : 2)
  let broken = 0
  let rotateFails = 0
  let stage = 0
  for (let attempt = 1; attempt <= HUNT_MAX; attempt++) {
    const mode = chain[stage]!
    // The fallback chain only moves on when the current mode gives nothing; a switch is one attempt less.
    if (mode !== getMode()) {
      autoStatus(`switching to ${LABELS[mode]} (${stage + 1}/${chain.length})…`)
      const applied = await applyMode(mode)
      if (!applied.ok) {
        if (++stage >= chain.length) return applied
        continue
      }
      refillPoolIfProxy()
    }
    autoStatus(`changing the IP (${attempt}/${HUNT_MAX})…`)
    const net = await rotateOnly()
    // One failed rotation can be a slow WARP registration; two in a row mean the network itself is down.
    if (!net.ok) {
      if (++rotateFails < 2) continue
      if (++stage >= chain.length) return net
      rotateFails = 0
      continue
    }
    rotateFails = 0
    // Fast mode: the new IP is used at once. If it is already limited, the chat hits the limit again and rotates again.
    if (load().fast) {
      console.info(`[auto-rotate] fast mode: ${net.ip} used without a probe`)
      return { ...net, message: `${net.message} - not checked (fast mode)` }
    }
    autoStatus(`testing ${net.ip ?? "the new IP"} on a temporary session (${attempt}/${HUNT_MAX})…`)
    const probeStart = Date.now()
    const state = await probeIp(command)
    console.info(`[auto-rotate] try ${attempt} ${net.ip}: ${state} (probe ${((Date.now() - probeStart) / 1000).toFixed(1)}s)`)
    if (state === "ok") return { ...net, message: `${net.message} - works after ${attempt} ${attempt === 1 ? "try" : "tries"}` }
    broken = state === "failed" ? broken + 1 : 0
    if (broken >= brokenMax()) {
      if (++stage >= chain.length) return { ok: false, message: "the IP probe failed for a reason that is not a limit" }
      broken = 0
    }
  }
  return { ok: false, message: `no free IP after ${HUNT_MAX} tries` }
}

// What the server calls a limit: see toSessionError in packages/core/src/session/to-session-error.ts. Only the free
// allowance counts. A rate limit (429) passes by itself and may come from the user's own provider, and account
// budgets (Go, ChatGPT, quota) do not change with the IP: rotating for those would be a false alarm.
const LIMIT_ERROR = "provider.free-limit"
// An event older than this was replayed by a reconnect, not raised now.
const LIMIT_FRESH_MS = 60_000

/** The session a server-sent event block reports as stopped by a limit, `""` when it names none, else undefined. */
export function limitSession(block: string) {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("")
  try {
    const event = JSON.parse(data)
    if (event?.type !== "session.step.failed" && event?.type !== "session.error") return undefined
    // v2 events carry the error in `data`, the older ones in `properties`.
    const body = event.data ?? event.properties
    const type: unknown = body?.error?.type
    if (type !== LIMIT_ERROR) return undefined
    if (typeof event.created === "number" && Date.now() - event.created > LIMIT_FRESH_MS) return undefined
    return typeof body.sessionID === "string" ? body.sessionID : ""
  } catch {
    return undefined
  }
}

/** Chats that reached the limit and are waiting for the next working IP. */
export const pending = new Set<string>()

/** Sends "continue" to a session so the conversation goes on after the IP changed. True when the server took it. */
export async function resumeSession(sessionID: string) {
  if (!sessionID) return false
  const text = "continue"
  // After a service restart the new one needs a moment before it accepts requests.
  for (let attempt = 0; attempt < 20; attempt++) {
    const sidecar = SidecarCredentials.get()
    const url = sidecar && `${sidecar.url}/api/session/${encodeURIComponent(sessionID)}/prompt`
    const auth = url && SidecarCredentials.authorization(sidecar, url)
    const res = url
      ? await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { Authorization: auth } : {}) },
          body: JSON.stringify({ text }),
        }).catch(() => undefined)
      : undefined
    if (res?.ok) return true
    if (res && res.status < 500) break
    await sleep(500)
  }
  return false
}

/**
 * Whether a limit or connection event may rotate now. Pure, so the rules are tested without Electron.
 * A busy lock or the 3 s window retries only while chats are waiting; 10 rotations in a row pause for 3 minutes.
 */
export function decide(state: {
  now: number
  last: number
  streak: number
  locked: boolean
  pending: boolean
}): { run: boolean; pause?: boolean; retryMs?: number } {
  const { now, last, streak, locked, pending } = state
  if (locked) return { run: false, retryMs: pending ? 2_000 : undefined }
  // A fresh IP can be burned too (WARP needed 4 tries in a test): repeat quickly, but not forever.
  if (now - last < 3_000) return { run: false, retryMs: pending ? 3_000 - (now - last) : undefined }
  if (streak >= 10) return { run: false, pause: true, retryMs: pending ? 180_000 : undefined }
  return { run: true }
}

/** Watches the service's event stream and the connection; `rotateNow` runs the rotation and resumes the session. */
export function startWatch(rotateNow: (sessionID: string) => void) {
  let last = 0
  let streak = 0
  let fails = 0
  const trigger = (why: string, sessionID = "") => {
    const now = Date.now()
    if (!load().auto) return
    // Every chat that hit the limit is kept, even while a rotation is running; the finished rotation resumes them all.
    if (sessionID) pending.add(sessionID)
    if (now - last > 180_000) streak = 0
    const decision = decide({ now, last, streak, locked, pending: pending.size > 0 })
    // A chat waiting behind a rotation is retried when the window opens, so it is never dropped.
    if (decision.retryMs !== undefined) return void setTimeout(() => trigger(why), decision.retryMs)
    if (!decision.run) {
      if (decision.pause) autoNote = "auto-rotate paused: 10 rotations in a row, it tries again in 3 minutes"
      return
    }
    last = now
    streak++
    autoStatus(`${why}, changing the IP…`)
    rotateNow(sessionID)
  }

  // A dead free proxy or a dropped tunnel looks like two failed checks in a row, about 30 s.
  setInterval(async () => {
    if (!load().auto || load().mode === "NONE" || locked) return
    fails = (await checkIp()).ok ? 0 : fails + 1
    if (fails >= 2) {
      fails = 0
      trigger("connection lost")
    }
  }, 15_000)

  const listen = async () => {
    const sidecar = SidecarCredentials.get()
    const url = sidecar && `${sidecar.url}/api/event`
    const auth = url && SidecarCredentials.authorization(sidecar, url)
    if (!url) return sleep(1000)
    const res = await fetch(url, { headers: auth ? { Authorization: auth } : {} })
    if (!res.body) return
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const session = limitSession(block)
        if (session !== undefined) trigger("limit reached", session)
      }
    }
  }
  void (async () => {
    for (;;) {
      await listen().catch(() => undefined)
      await sleep(1000)
    }
  })()
  // The renderer reports limits too (it sees the same event); both paths share the dedupe above.
  return trigger
}

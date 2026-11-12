import { app } from "electron"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { connect as tcp, createServer, type Server, type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { SidecarCredentials } from "../service/sidecar-credentials"

// Port of the useful core of "OpenCode Infinite.bat": WARP / TOR / PROXY rotation and session renewal.
// shortcut: WIREGUARD and VPNGATE from the .bat are not ported (they need wireproxy / an admin OpenVPN helper).

export type Mode = "WARP" | "TOR" | "PROXY" | "NONE"
export type Result = { ok: boolean; message: string; ip?: string }

const WARP_PORT = 40000
const WARP_PROXY = `http://127.0.0.1:${WARP_PORT}`
const TOR_SOCKS = 19050
const TOR_CONTROL = 19051
const TOR_HTTP = 18118
const KEEP_BACKUPS = 5
const TRACE = "https://www.cloudflare.com/cdn-cgi/trace"
const LIST =
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settings = () => path.join(app.getPath("userData"), "infinite.json")

// --- saved mode ---------------------------------------------------------------------------------------------------

type Saved = { mode: Mode; proxy?: string; custom?: string; auto: boolean; country: string }
let saved: Saved | undefined

function load(): Saved {
  if (saved) return saved
  try {
    // Sync on purpose: the first background-service spawn needs the mode before any IPC call arrives.
    const raw = JSON.parse(readFileSync(settings(), "utf8"))
    saved = {
      mode: ["WARP", "TOR", "PROXY"].includes(raw.mode) ? raw.mode : "NONE",
      proxy: raw.proxy,
      custom: typeof raw.custom === "string" ? raw.custom : undefined,
      auto: raw.auto === true,
      country: typeof raw.country === "string" && /^[A-Za-z]{2}$/.test(raw.country) ? raw.country.toUpperCase() : "",
    }
  } catch {
    saved = { mode: "NONE", auto: false, country: "" }
  }
  return saved
}

export type Options = { auto: boolean; country: string; custom: string }
export const getOptions = (): Options => ({ auto: load().auto, country: load().country, custom: load().custom ?? "" })

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
  load().custom = normalizeProxies(next.custom).join("\n") || undefined
  load().country = /^[A-Za-z]{2}$/.test(next.country) ? next.country.toUpperCase() : ""
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
    ? { ok: true, ip: found.ip, loc: found.loc, message: `WARP active, IP ${found.ip}` }
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
  let created = await warp("registration", "new")
  if (!created.ok) {
    await sleep(2000)
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

const tor = { child: undefined as ChildProcess | undefined, bridge: undefined as Server | undefined }
const tunnels = new Set<Socket>()
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

/** Minimal HTTP CONNECT -> SOCKS5 bridge: OpenCode (Bun) only speaks HTTP proxies. */
// shortcut: CONNECT (https) only, no plain-HTTP forwarding; fine for the API calls OpenCode makes.
function startBridge() {
  if (tor.bridge) return
  tor.bridge = createServer((client) => {
    tunnels.add(client)
    client.once("close", () => tunnels.delete(client))
    client.once("data", (head) => {
      const match = /^CONNECT ([^:\s]+):(\d+) HTTP/.exec(head.toString("latin1"))
      if (!match) return client.destroy()
      const socks = tcp(TOR_SOCKS, "127.0.0.1")
      const fail = () => {
        client.destroy()
        socks.destroy()
      }
      client.on("error", fail)
      socks.on("error", fail)
      socks.once("connect", () => socks.write(Buffer.from([5, 1, 0])))
      socks.once("data", () => {
        const host = Buffer.from(match[1]!)
        const port = Number(match[2])
        socks.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([port >> 8, port & 255])]))
        socks.once("data", (reply) => {
          if (reply[1] !== 0) return fail()
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          client.pipe(socks)
          socks.pipe(client)
        })
      })
    })
  })
    .on("error", () => undefined) // port already taken: another bridge is serving it
    .listen(TOR_HTTP, "127.0.0.1")
}

let starting: Promise<Result> | undefined
// Service start, mode change and IP check all call this; they share one start-up instead of racing to spawn two Tors.
const startTor = () => (starting ??= bootTor().finally(() => (starting = undefined)))

async function bootTor(): Promise<Result> {
  startBridge()
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
    if (ip) return { ok: true, ip, message: `Tor active, IP ${ip}` }
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
  tunnels.forEach((socket) => socket.destroy())
  // The new circuit needs a moment to build; probe quickly instead of waiting a fixed time.
  let latest: string | undefined
  for (let i = 0; i < 40; i++) {
    latest = (await torIp()) ?? latest
    if (latest && latest !== known.TOR) break
    await sleep(400)
  }
  // The same exit can legitimately come back; that still counts as a working circuit.
  return latest
    ? { ok: true, ip: latest, message: `Tor new circuit, IP ${latest}` }
    : { ok: false, message: "Tor did not answer after the new circuit." }
}

// --- free proxies -------------------------------------------------------------------------------------------------

const proxyWorks = (p: string) =>
  run("curl", ["-s", "-m", "4", "-o", os.devNull, "-w", "%{http_code}", "-x", p, "https://opencode.ai"], 6000).then(
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

/** Free HTTP proxies: test untried ones in parallel until one reaches opencode.ai. */
async function pickProxy(): Promise<Result> {
  const list = customList()
  if (list.length) {
    // With a list, rotating means moving to another entry; with one entry it can only re-test that one.
    const pool = list.filter((p) => p !== load().proxy || list.length === 1).sort(() => Math.random() - 0.5)
    for (let i = 0; i < pool.length; i += 20) {
      const hit = await firstWorking(pool.slice(i, i + 20))
      if (hit) {
        load().proxy = hit
        await save()
        return { ok: true, ip: new URL(hit).hostname, message: `Your proxy (${list.length} in the list)` }
      }
    }
    return { ok: false, message: `None of your ${list.length} proxies answers (check host, port and login).` }
  }
  const text = await fetch(LIST)
    .then((r) => r.text())
    .catch(() => "")
  const all = text
    .split(/\s+/)
    .map((line) => line.replace(/^http:\/\//, ""))
    .filter((line) => /^[\d.]+:\d+$/.test(line))
    .sort(() => Math.random() - 0.5)
    .slice(0, 60)
    .map((line) => `http://${line}`)
  if (!all.length) return { ok: false, message: "Could not download the proxy list." }
  for (let i = 0; i < all.length; i += 20) {
    const hit = await firstWorking(all.slice(i, i + 20))
    if (hit) {
      load().proxy = hit
      await save()
      return { ok: true, ip: hit.slice(7).split(":")[0], message: `Proxy ${hit}` }
    }
  }
  return { ok: false, message: "No working free proxy found; try again." }
}

// --- public -------------------------------------------------------------------------------------------------------

/** Kicks the current mode into shape before the background service starts behind it. */
export async function prepareMode() {
  if (getMode() === "TOR") await startTor()
}

export const rotate = (m: Mode): Promise<Result> =>
  m === "WARP"
    ? rotateWarp()
    : m === "TOR"
      ? rotateTor()
      : m === "PROXY"
        ? pickProxy()
        : Promise.resolve({ ok: true, message: "No proxy (NONE)." })

/** WARP, Tor and None keep the same proxy URL across a rotation, so the service can start before the new IP is ready. */
export const upstreamKnown = () => getMode() !== "PROXY"

/** Apply a mode change before the service is restarted behind it. */
export async function applyMode(next: Mode): Promise<Result> {
  await setMode(next)
  if (next === "WARP") return remember(await connect())
  if (next === "TOR") return remember(await startTor())
  if (next === "PROXY") {
    const kept = load().custom ? undefined : load().proxy
    return remember(kept && (await proxyWorks(kept)) ? { ok: true, ip: kept.slice(7).split(":")[0], message: `Proxy ${kept}` } : await pickProxy())
  }
  return { ok: true, message: "No proxy (NONE)." }
}

// The last IP each mode was seen with, shown when a check cannot reach the internet right now.
const known: Partial<Record<Mode, string>> = {}
const remember = (result: Result) => {
  if (result.ok && result.ip) known[getMode()] = result.ip
  return result
}

/** The exit IP as the internet sees it through the current mode (direct for NONE). */
export async function checkIp(): Promise<Result> {
  const mode = getMode()
  const label = { WARP: "WARP", TOR: "Tor", PROXY: "Proxy", NONE: "None" }[mode]
  // Right after launch Tor may still be bootstrapping; wait for it instead of reporting a failure.
  if (mode === "TOR") await startTor()
  const url = upstream()
  // A proxy mode without a proxy would answer with the real IP; that is not what OpenCode uses.
  if (mode === "PROXY" && !url) return { ok: false, message: `${label} - connecting…` }
  const res = await run("curl", ["-s", "-m", "10", ...(url ? ["-x", url] : []), TRACE])
  const ip = /^ip=(.+)$/m.exec(res.out)?.[1]
  // Saved mode WARP but the daemon is not connected yet (fresh launch): bring it up instead of waiting for a click.
  if (!ip && mode === "WARP" && !locked) {
    const up = await connect()
    if (up.ok && up.ip) return { ok: true, ip: up.ip, message: `${label} - ${remember(up).ip}` }
  }
  if (res.ok && ip) {
    known[mode] = ip
    return { ok: true, ip, message: `${label} - ${ip}${autoNote ? ` · ${autoNote}` : ""}` }
  }
  // Not reachable right now (still connecting, or rotating): show the IP OpenCode was last using, not an error.
  const last = known[mode]
  return last ? { ok: false, ip: last, message: `${label} - ${last}` } : { ok: false, message: `${label} - connecting…` }
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
function probeIp(command: readonly string[]) {
  return new Promise<"ok" | "limit" | "failed">((resolve) => {
    // --archived keeps the probe sessions out of the session list.
    const args = ["run", "--standalone", "--archived", "-m", PROBE_MODEL, "Reply with exactly the word: pong"]
    const proc = spawn(command[0]!, [...command.slice(1), ...args], {
      env: { ...process.env, ...proxyEnv() },
      windowsHide: true,
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
  // The bar shows how the hunt ended, instead of staying on "looking for a free IP".
  const at = new Date().toLocaleTimeString()
  autoNote = result.ok ? `auto-rotated at ${at}` : `auto-rotate failed at ${at}: ${result.message}`
  return result
}

async function hunt(command: readonly string[]): Promise<Result> {
  // None has no IP to change: probing it again would only spend free messages.
  if (getMode() === "NONE") return { ok: false, message: "pick WARP, Tor or Proxy first (None cannot change the IP)" }
  // A dead free proxy fails the probe without being a limit, so Proxy keeps trying; elsewhere two in a row mean the probe is broken.
  const brokenMax = getMode() === "PROXY" ? HUNT_MAX : 2
  let broken = 0
  for (let attempt = 1; attempt <= HUNT_MAX; attempt++) {
    autoNote = `looking for a free IP (${attempt}/${HUNT_MAX})`
    const net = await rotateOnly()
    if (!net.ok) return net
    const state = await probeIp(command)
    if (state === "ok") return { ...net, message: `${net.message} - works after ${attempt} ${attempt === 1 ? "try" : "tries"}` }
    broken = state === "failed" ? broken + 1 : 0
    if (broken >= brokenMax) return { ok: false, message: "the IP probe failed for a reason that is not a limit" }
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
  // The IP changed but the chat did not get the message: say so in the bar instead of looking finished.
  autoNote += " - could not send \"continue\" to the chat, send it yourself"
  return false
}

/** Watches the service's event stream and the connection; `rotateNow` runs the rotation and resumes the session. */
export function startWatch(rotateNow: (sessionID: string) => void) {
  let last = 0
  let streak = 0
  let fails = 0
  const trigger = (why: string, sessionID = "") => {
    const now = Date.now()
    if (!load().auto || locked) return
    if (now - last > 180_000) streak = 0
    // A fresh IP can be burned too (WARP needed 4 tries in a test): repeat quickly, but not forever.
    if (now - last < 3_000) return
    if (streak >= 10) return void (autoNote = "auto-rotate paused: 10 rotations in a row, it tries again in 3 minutes")
    last = now
    streak++
    autoNote = `auto-rotated x${streak} (${why}) at ${new Date().toLocaleTimeString()}`
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

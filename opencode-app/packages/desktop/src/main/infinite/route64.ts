import { execFile } from "node:child_process"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseWireGuardConf } from "./wireguard-conf"

// route64 tunnel: the .conf the user downloads from manager.route64.org, kept under the user's own profile.
// The private key lives in that file, so the file is limited to the current user (icacls below).

export type Route64Status = { imported: boolean; endpoint?: string; up: boolean }

const dir = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "state"), "opencode-infinite", "route64")
const file = () => path.join(dir(), "route64.conf")
const TUNNEL = "route64"
const WIREGUARD = "C:\\Program Files\\WireGuard\\wireguard.exe"

function run(exe: string, args: string[], timeout = 30_000) {
  return new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(exe, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}` }),
    ),
  )
}

/** Save the config after checking it. Returns the endpoint host for display; never the key. */
export async function importRoute64(text: string) {
  const parsed = parseWireGuardConf(text)
  if (!parsed.ok) return { ok: false as const, message: parsed.errors.join("; ") }
  await mkdir(dir(), { recursive: true })
  await writeFile(file(), text, "utf8")
  // Only the current user may read it: the private key is inside.
  if (process.platform === "win32") {
    await run("icacls", [file(), "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`])
  }
  const endpoint = parsed.conf.peers[0]!.endpoint
  return { ok: true as const, message: `route64 config saved (endpoint ${endpoint})`, endpoint }
}

export async function route64Status(): Promise<Route64Status> {
  const exists = await stat(file()).then(() => true, () => false)
  let endpoint: string | undefined
  if (exists) {
    const parsed = parseWireGuardConf(await readFile(file(), "utf8"))
    if (parsed.ok) endpoint = parsed.conf.peers[0]!.endpoint
  }
  const service = await run("sc", ["query", `WireGuardTunnel$${TUNNEL}`])
  // The IPC schema's `endpoint` may be absent but never undefined: an explicit undefined fails the reply as a handler error.
  return { imported: exists, ...(endpoint ? { endpoint } : {}), up: service.ok && /RUNNING/.test(service.out) }
}

/**
 * Brings the tunnel up as a WireGuard service. Needs WireGuard already installed and an administrator
 * prompt (UAC); it never installs WireGuard itself.
 */
export async function bringUpRoute64() {
  if (!(await stat(file()).then(() => true, () => false))) return { ok: false, message: "Import a route64 .conf first." }
  if (!(await stat(WIREGUARD).then(() => true, () => false)))
    return { ok: false, message: "WireGuard is not installed. Install it first (the app asks before doing so)." }
  // Start-Process -Verb RunAs raises the UAC prompt; the user accepts it or nothing changes.
  const cmd = `Start-Process -FilePath '${WIREGUARD}' -ArgumentList '/installtunnelservice','${file()}' -Verb RunAs -Wait`
  const result = await run("powershell", ["-NoProfile", "-Command", cmd], 120_000)
  if (!result.ok) return { ok: false, message: "The tunnel was not started (UAC was refused or WireGuard failed)." }
  const status = await route64Status()
  return status.up
    ? { ok: true, message: "route64 tunnel is up." }
    : { ok: false, message: "WireGuard ran but the tunnel service is not RUNNING." }
}

/** Takes the tunnel down (UAC, like bringing it up). Called when the user leaves the Route64 mode. */
export async function bringDownRoute64() {
  if (!(await route64Status()).up) return { ok: true, message: "route64 tunnel is already down." }
  const cmd = `Start-Process -FilePath '${WIREGUARD}' -ArgumentList '/uninstalltunnelservice','${TUNNEL}' -Verb RunAs -Wait`
  const result = await run("powershell", ["-NoProfile", "-Command", cmd], 120_000)
  if (!result.ok) return { ok: false, message: "The tunnel was not stopped (UAC was refused)." }
  return (await route64Status()).up
    ? { ok: false, message: "route64 tunnel is still up." }
    : { ok: true, message: "route64 tunnel is down." }
}

export async function removeRoute64() {
  await rm(file(), { force: true })
  return { ok: true, message: "route64 config removed." }
}

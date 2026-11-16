import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"

// Mullvad and Windscribe are used through their own command-line tools. The app never installs them and never
// stores an account: the user logs in once in the client, and this only switches the server.

export type Client = "MULLVAD" | "WINDSCRIBE"
type Output = { ok: boolean; out: string }
export type Runner = (exe: string, args: string[], timeout?: number) => Promise<Output>

const exes: Record<Client, string> = {
  MULLVAD: "C:\\Program Files\\Mullvad VPN\\resources\\mullvad.exe",
  WINDSCRIBE: "C:\\Program Files\\Windscribe\\windscribe-cli.exe",
}
const names: Record<Client, string> = { MULLVAD: "Mullvad", WINDSCRIBE: "Windscribe" }
// Mullvad country codes used when the user gives no locations.
const MULLVAD_DEFAULT = ["se", "de", "nl", "ch", "no", "fi", "ro", "at"]

const real: Runner = (exe, args, timeout = 60_000) =>
  new Promise((resolve) =>
    execFile(exe, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}` }),
    ),
  )
let runner: Runner = real
/** Tests replace the runner so no client is needed. */
export function setRunner(next: Runner | undefined) {
  runner = next ?? real
}

export const clientName = (client: Client) => names[client]

export async function installed(client: Client) {
  return stat(exes[client]).then(
    () => true,
    () => false,
  )
}

/** The next location to use: from the user's list (or Mullvad's default codes), never the one in use. */
export function pickLocation(client: Client, locations: string[], current?: string): string | undefined {
  const pool = locations.length ? locations : client === "MULLVAD" ? MULLVAD_DEFAULT : []
  const others = pool.filter((item) => item !== current)
  const list = others.length ? others : pool
  return list.length ? list[Math.floor(Math.random() * list.length)] : undefined
}

export async function connectClient(client: Client, location?: string): Promise<{ ok: boolean; message: string }> {
  const name = names[client]
  if (!(await installed(client))) return { ok: false, message: `${name} is not installed.` }
  if (client === "MULLVAD") {
    if (location) {
      const set = await runner(exes.MULLVAD, ["relay", "set", "location", location])
      if (!set.ok) return { ok: false, message: `Mullvad refused ${location}: ${set.out.trim() || "unknown error"}` }
    }
    const up = await runner(exes.MULLVAD, ["connect", "--wait"], 90_000)
    return up.ok
      ? { ok: true, message: `Mullvad connected${location ? ` (${location})` : ""}` }
      : { ok: false, message: `Mullvad did not connect: ${up.out.trim() || "unknown error"}` }
  }
  const target = location ?? "best"
  const up = await runner(exes.WINDSCRIBE, ["connect", target], 90_000)
  return up.ok
    ? { ok: true, message: `Windscribe connected (${target})` }
    : { ok: false, message: `Windscribe did not connect: ${up.out.trim() || "unknown error"}` }
}

export async function disconnectClient(client: Client): Promise<{ ok: boolean; message: string }> {
  if (!(await installed(client))) return { ok: true, message: `${names[client]} is not installed; nothing to disconnect.` }
  const exe = exes[client]
  const down = await runner(exe, ["disconnect"], 60_000)
  return down.ok ? { ok: true, message: `${names[client]} disconnected.` } : { ok: false, message: `${names[client]} did not disconnect.` }
}

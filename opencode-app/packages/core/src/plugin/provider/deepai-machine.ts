export * as DeepAIMachine from "./deepai-machine.js"

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

// DeepAI grants its daily allowance once per machine: the server reads this digest and withholds the grant from a
// client that omits it. The digest is sent, never the raw identifier.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
])

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout))
  })

const platformUUID = (ioreg: string) => {
  const value = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg)?.[1]
  return value && UUID.test(value) ? value.toLowerCase() : undefined
}

const smbiosUUID = (output: string) => {
  const value = UUID.exec(output)?.[0]?.toLowerCase()
  return value && !PLACEHOLDERS.has(value) ? value : undefined
}

const machineGuid = (output: string) => {
  const value = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output)?.[1]
  return value && UUID.test(value) ? value.toLowerCase() : undefined
}

const linuxMachineId = (file: string) => {
  const value = file.trim().toLowerCase()
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value) ? value : undefined
}

async function detect() {
  // A rotated value (Infinite) stands in for the machine, so the server treats the run as a new machine.
  const override = process.env.OPENCODE_DEEPAI_MACHINE
  if (override) return override
  if (process.platform === "darwin") return platformUUID(await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))
  if (process.platform === "win32")
    return (
      smbiosUUID(await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"])) ??
      machineGuid(await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]))
    )
  if (process.platform === "linux")
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const id = linuxMachineId(await readFile(path, "utf8").catch(() => ""))
      if (id) return id
    }
}

let pending: Promise<Record<string, string>> | undefined

/** The machine header, computed once per process; empty when no identifier is readable. */
export function headers() {
  pending ??= detect().then(
    (raw): Record<string, string> =>
      raw ? { "X-DeepAI-Code-Machine": createHash("sha256").update(raw).digest("hex") } : {},
  )
  return pending
}

/** A fresh value for a rotation; the next process start sends its digest instead. */
export const rotate = () => (process.env.OPENCODE_DEEPAI_MACHINE = crypto.randomUUID())

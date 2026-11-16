import { execFile } from "node:child_process"
import { mkdir, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Installs WARP or WireGuard from their official sources, only after the user confirmed in the app.
// Order: detect -> download -> check the Authenticode signature of the publisher -> msiexec with UAC.

export type Tool = "WARP" | "WIREGUARD"

const TOOLS = {
  WARP: {
    exe: "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
    service: "CloudflareWARP",
    // Cloudflare's own redirect to the current MSI.
    url: async () => "https://downloads.cloudflareclient.com/v1/download/windows/ga",
    signer: /CN="?Cloudflare, Inc\.?"?/,
    file: "warp.msi",
  },
  WIREGUARD: {
    exe: "C:\\Program Files\\WireGuard\\wireguard.exe",
    service: "",
    url: wireguardUrl,
    signer: /CN=WireGuard LLC/,
    file: "wireguard.msi",
  },
} as const

const downloads = () =>
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "state"), "opencode-infinite", "downloads")

async function exists(file: string) {
  return stat(file).then(() => true, () => false)
}

function run(exe: string, args: string[], timeout = 600_000) {
  return new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(exe, args, { timeout, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}` }),
    ),
  )
}

/** The newest official WireGuard amd64 MSI, read from the publisher's listing. */
async function wireguardUrl() {
  const page = await fetch("https://download.wireguard.com/windows-client/").then((res) => res.text())
  const names = [...page.matchAll(/href="(wireguard-amd64-(\d+(?:\.\d+)*)\.msi)"/g)].map((m) => ({
    name: m[1]!,
    version: m[2]!.split(".").map(Number),
  }))
  names.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const d = (b.version[i] ?? 0) - (a.version[i] ?? 0)
      if (d) return d
    }
    return 0
  })
  const newest = names[0]
  if (!newest) throw new Error("Could not find the WireGuard installer on wireguard.com")
  return `https://download.wireguard.com/windows-client/${newest.name}`
}

/** Installed means the program is there and, for WARP, its service too. */
export async function installed(tool: Tool) {
  const spec = TOOLS[tool]
  if (!(await exists(spec.exe))) return false
  if (!spec.service) return true
  const service = await run("sc", ["query", spec.service], 10_000)
  return service.ok
}

/** What the app would install, for the confirmation text. Makes no change. */
export async function plan(tool: Tool) {
  const spec = TOOLS[tool]
  if (await installed(tool)) return { installed: true as const }
  return { installed: false as const, url: await spec.url(), publisher: tool === "WARP" ? "Cloudflare, Inc." : "WireGuard LLC" }
}

/** Refuses to install without `confirmed`, the user's yes from the app. Returns true only when the tool is there after. */
export async function install(tool: Tool, confirmed: boolean) {
  if (confirmed !== true) return { ok: false, message: "Installation needs your confirmation." }
  if (await installed(tool)) return { ok: true, message: `${tool} is already installed.` }

  const spec = TOOLS[tool]
  const url = await spec.url()
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) return { ok: false, message: `Download failed (HTTP ${response.status}).` }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length < 1_000_000 || data.length > 300_000_000) return { ok: false, message: "The download has an unexpected size; nothing was installed." }

  await mkdir(downloads(), { recursive: true })
  const file = path.join(downloads(), spec.file)
  await writeFile(file, data)

  // The publisher's signature must be valid and name the expected company, or the file is not installed.
  const sig = await run(
    "powershell",
    ["-NoProfile", "-Command", `$s = Get-AuthenticodeSignature -LiteralPath '${file}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
    60_000,
  )
  const [status = "", subject = ""] = sig.out.trim().split("|")
  if (!sig.ok || status !== "Valid" || !spec.signer.test(subject)) {
    return { ok: false, message: `The downloaded file is not signed by ${tool === "WARP" ? "Cloudflare" : "WireGuard LLC"}; nothing was installed.` }
  }

  // Start-Process -Verb RunAs raises the UAC prompt; without the user's permission nothing is installed.
  const msi = `Start-Process -FilePath msiexec.exe -ArgumentList '/i','${file}','/qn','/norestart' -Verb RunAs -Wait -PassThru | ForEach-Object { $_.ExitCode }`
  const ran = await run("powershell", ["-NoProfile", "-Command", msi])
  if (!ran.ok || !(await installed(tool))) return { ok: false, message: `${tool} was not installed (UAC refused or the installer failed).` }
  return { ok: true, message: `${tool} installed.` }
}

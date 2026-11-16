import type { Platform } from "@/runtime/platform/platform"
import { addHistory } from "@/shell/infinite-history"

// The connection doctor: finds what works on this computer and puts the best option in place, using the same calls the
// bottom bar uses. Everything here is a decision about order; the network work stays in the main process.

type Infinite = NonNullable<Platform["infinite"]>
export type Mode = "WARP" | "TOR" | "PROXY" | "SOCKS" | "ROUTE64" | "MULLVAD" | "WINDSCRIBE" | "NONE"
/** ready: can be used now. install: a program is missing and can be installed. setup: needs something from the user. */
export type RowState = "ready" | "install" | "setup"
export type Row = { id: Mode; label: string; state: RowState; detail: string; advanced: boolean }
export type Outcome = { ok: boolean; mode: Mode; ip?: string; message: string }

const LABELS: Record<Mode, string> = {
  WARP: "WARP",
  TOR: "Tor",
  PROXY: "Proxy",
  SOCKS: "SOCKS5",
  ROUTE64: "Route64",
  MULLVAD: "Mullvad",
  WINDSCRIBE: "Windscribe",
  NONE: "Direct",
}
export const modeName = (mode: Mode) => LABELS[mode]

/** What each connection needs and whether this computer has it. Makes no change. */
export async function diagnose(infinite: Infinite): Promise<Row[]> {
  const [warp, options, route64] = await Promise.all([
    infinite.toolPlan("WARP"),
    infinite.getOptions(),
    infinite.route64Status(),
  ])
  return [
    warp.installed
      ? { id: "WARP", label: LABELS.WARP, state: "ready", detail: "Installed. The fastest option.", advanced: false }
      : { id: "WARP", label: LABELS.WARP, state: "install", detail: "Not installed. One click installs it (Windows asks for permission).", advanced: false },
    { id: "TOR", label: LABELS.TOR, state: "ready", detail: "Included in the app. Slower, a good fallback.", advanced: false },
    { id: "NONE", label: LABELS.NONE, state: "ready", detail: "Your own connection, no proxy.", advanced: false },
    options.custom
      ? { id: "PROXY", label: LABELS.PROXY, state: "ready", detail: "Uses your proxy list.", advanced: true }
      : { id: "PROXY", label: LABELS.PROXY, state: "ready", detail: "No list of yours: uses a free list (unreliable).", advanced: true },
    options.socks
      ? { id: "SOCKS", label: LABELS.SOCKS, state: "ready", detail: "Uses your SOCKS5 servers.", advanced: true }
      : { id: "SOCKS", label: LABELS.SOCKS, state: "setup", detail: "Add SOCKS5 servers in Settings, Advanced.", advanced: true },
    route64.imported
      ? { id: "ROUTE64", label: LABELS.ROUTE64, state: "ready", detail: "Config imported. Needs administrator permission and WireGuard.", advanced: true }
      : { id: "ROUTE64", label: LABELS.ROUTE64, state: "setup", detail: "Import your route64 .conf in Settings, Advanced.", advanced: true },
    { id: "MULLVAD", label: LABELS.MULLVAD, state: "ready", detail: "Needs the Mullvad app, logged in.", advanced: true },
    { id: "WINDSCRIBE", label: LABELS.WINDSCRIBE, state: "ready", detail: "Needs the Windscribe app, logged in.", advanced: true },
  ]
}

let running: Promise<Outcome> | undefined

/**
 * Puts a working connection in place. Without `fresh` a connection that already answers is left alone; with it the
 * order is chosen from scratch. Order: the current mode, WARP, the user's own SOCKS5 and proxy lists, Tor, direct.
 * The automatic order never uses Route64, Mullvad or Windscribe: they need administrator rights or a logged-in app.
 * One run at a time; a second call gets the result of the first.
 */
export function fixConnection(infinite: Infinite, report: (text: string) => void, fresh = false): Promise<Outcome> {
  running ??= attempt(infinite, report, fresh).finally(() => {
    running = undefined
  })
  return running
}

async function attempt(infinite: Infinite, report: (text: string) => void, fresh: boolean): Promise<Outcome> {
  const current = (await infinite.getMode()) as Mode
  if (!fresh) {
    report("Checking the connection…")
    const checked = await infinite.checkIp()
    if (checked.ok && checked.ip) return { ok: true, mode: current, ip: checked.ip, message: `${modeName(current)} works` }
  }
  const rows = await diagnose(infinite)
  const usable = (id: Mode) => rows.find((row) => row.id === id)?.state === "ready"
  const options = await infinite.getOptions()
  const order = [
    ...(fresh || current === "NONE" || !["WARP", "TOR", "PROXY", "SOCKS"].includes(current) ? [] : [current]),
    "WARP",
    ...(options.socks ? ["SOCKS"] : []),
    ...(options.custom ? ["PROXY"] : []),
    "TOR",
    "NONE",
  ].filter((id, index, all): id is Mode => all.indexOf(id) === index && usable(id as Mode))

  const notes: string[] = []
  for (const mode of order) {
    report(`Trying ${modeName(mode)}…`)
    const applied = await infinite.setMode(mode)
    addHistory({ mode, ok: applied.ok, ip: applied.ip })
    if (applied.ok) return { ok: true, mode, ip: applied.ip, message: `${modeName(mode)} works` }
    notes.push(`${modeName(mode)}: ${applied.message}`)
  }
  return { ok: false, mode: current, message: notes.join(" | ") || "Nothing could be connected." }
}

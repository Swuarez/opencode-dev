import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { usePlatform } from "@/runtime/platform/platform"
import { advancedMode, autoRotate as auto, setAutoRotate as setAuto, verboseStatus } from "@/shell/infinite-state"
import { initLook } from "@/shell/infinite-look"
import { SettingsDialog } from "@/shell/settings-dialog"
import { addHistory } from "@/shell/infinite-history"
import { ConnectionDialog } from "@/shell/connection-dialog"
import { fixConnection } from "@/shell/infinite-doctor"
import { useCurrentRoute } from "@/shell/state/layout"
import { InfiniteUsage } from "@/shell/infinite-usage"

type Mode = "POOL" | "WARP" | "TOR" | "PROXY" | "SOCKS" | "ROUTE64" | "MULLVAD" | "WINDSCRIBE" | "NONE"
// Auto is not a mode of its own: it picks WARP when it works, otherwise None, and the bar then shows that mode.
type Choice = Mode | "AUTO"
type Result = { ok: boolean; message: string; ip?: string }

const modes: { id: Choice; label: string; title: string }[] = [
  { id: "AUTO", label: "Auto", title: "WARP when it works, otherwise a direct connection. Installs nothing." },
  { id: "POOL", label: "Pool", title: "Every route at once: each connection leaves by the next IP (WARP, Tor, SOCKS, proxies)." },
  { id: "WARP", label: "WARP", title: "Cloudflare WARP proxy. Asks before installing WARP." },
  { id: "TOR", label: "Tor", title: "Tor network. Changes exit node on rotation." },
  { id: "PROXY", label: "Proxy", title: "Your proxy list, or the free list when it is empty." },
  { id: "SOCKS", label: "SOCKS5", title: "Your SOCKS5 servers, reached through a local bridge. Needs a list in Settings." },
  { id: "ROUTE64", label: "Route64", title: "route64 WireGuard tunnel. Needs your .conf and administrator permission." },
  { id: "MULLVAD", label: "Mullvad", title: "Mullvad app: switches server. Needs Mullvad installed and logged in." },
  { id: "WINDSCRIBE", label: "Windscribe", title: "Windscribe app: switches server. Needs Windscribe installed and logged in." },
  { id: "NONE", label: "None", title: "Direct connection, no proxy." },
]

// Without advanced mode only Auto and None show; the rest sit behind Settings, Advanced mode.
const visibleModes = () => modes.filter((item) => advancedMode() || item.id === "AUTO" || item.id === "NONE")

const button =
  "px-2.5 py-1 rounded-md text-v2-text-text-base bg-v2-background-bg-layer-02 hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50 disabled:pointer-events-none"

const names: Record<string, string> = {
  AUTO: "Auto",
  POOL: "Pool",
  WARP: "WARP",
  TOR: "Tor",
  PROXY: "Proxy",
  SOCKS: "SOCKS5",
  ROUTE64: "Route64",
  MULLVAD: "Mullvad",
  WINDSCRIBE: "Windscribe",
  NONE: "None",
}
const modeLabel = (mode: string) => names[mode] ?? mode

// First-run marker: kept in this app's local storage, like the other per-computer preferences.
const SETUP_KEY = "opencode.infinite.setup"
const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return "1"
  }
}
const writeFlag = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Without storage the setup would repeat; readFlag answers "done" then, so it never loops.
  }
}

// Bottom bar with the OpenCode Infinite controls: connection choice, limit reset, IP check, auto-rotate and settings.
export function InfiniteBar() {
  const platform = usePlatform()
  const dialog = useDialog()
  const route = useCurrentRoute()
  const infinite = platform.infinite
  const [mode, setMode] = createSignal<Mode>("NONE")
  const [selected, setSelected] = createSignal<Choice>("NONE")
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<Result | undefined>()
  const [action, setAction] = createSignal<"" | "reset">("")
  // The outcome of the last manual action stays visible for a moment after the bar goes back to its idle state.
  const [flash, setFlash] = createSignal("")
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(flashTimer))

  onMount(() => {
    initLook()
    void infinite?.getMode().then((current) => {
      setMode(current)
      setSelected(current)
    })
    void infinite?.getOptions().then((options) => setAuto(options.auto))
    void infinite?.checkIp().then((checked) => {
      if (!busy()) setResult(checked)
    })
    // The doctor (panel, first run or watchdog) changed the connection: show the new mode and IP.
    const refresh = () => {
      void infinite?.getMode().then((current) => {
        setMode(current)
        setSelected(current)
      })
      void infinite?.checkIp().then((checked) => {
        if (!busy()) setResult(checked)
      })
    }
    window.addEventListener("infinite-connection", refresh)
    // First run: set the connection up on its own and show what was found. Never again after that.
    if (infinite && readFlag(SETUP_KEY) !== "1") {
      writeFlag(SETUP_KEY, "1")
      dialog.show(() => <ConnectionDialog autostart />)
    }
    // Keeps the dot honest between clicks, and heals a dead connection: a mode other than Direct whose proxy stopped
    // answering is repaired (at most every two minutes), so the chats keep working without anyone clicking.
    let lastHeal = 0
    const timer = setInterval(() => {
      if (busy()) return
      void infinite?.checkIp().then((checked) => {
        if (busy()) return
        setResult(checked)
        if (checked.ok || mode() === "NONE" || Date.now() - lastHeal < 120_000) return
        lastHeal = Date.now()
        void run("Connection lost, fixing it…", async () => {
          const outcome = await fixConnection(infinite!, (message) => setResult({ ok: true, message }))
          setMode(outcome.mode)
          setSelected(outcome.mode)
          return { ok: outcome.ok, message: outcome.message, ip: outcome.ip }
        })
      })
    }, 20_000)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("infinite-connection", refresh)
    })
  })

  const saveOptions = (next: boolean) => {
    setAuto(next)
    void infinite?.getOptions().then((options) => infinite.setOptions({ ...options, auto: next }))
  }

  const flashResult = (message: string) => {
    setFlash(message)
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => setFlash(""), 12_000)
  }

  // Every action is single-flight, and the service restart behind it can take a while. While it runs, the main
  // process reports its phase, so the bar shows what is really happening instead of one frozen label.
  const run = async (label: string, work: () => Promise<Result>, kind: "" | "reset" = "") => {
    if (busy()) return
    setBusy(true)
    setAction(kind)
    setResult({ ok: true, message: label })
    const started = Date.now()
    const timer = setInterval(() => {
      void infinite
        ?.getStatus()
        .then((status) => {
          if (!busy() || status.at < started || !status.message) return
          setResult({ ok: status.stage !== "failed", message: status.message })
        })
        .catch(() => undefined)
    }, 750)
    try {
      const outcome = await work()
      setResult(outcome)
      flashResult(outcome.message)
    } catch (error) {
      const outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
      setResult(outcome)
      flashResult(outcome.message)
    } finally {
      clearInterval(timer)
      setBusy(false)
      setAction("")
    }
  }

  // Switches the connection and remembers it in the history. The mode only changes when the switch worked.
  const apply = (next: Mode, label: string) =>
    run(`Switching to ${label}…`, async () => {
      const applied = await infinite!.setMode(next)
      addHistory({ mode: next, ok: applied.ok, ip: applied.ip })
      if (applied.ok) setMode(next)
      else setSelected(mode()) // the highlight goes back to the mode that is still in place
      return applied
    })

  // A missing client is installed only after the user says yes; installing needs administrator rights.
  const ensureInstalled = async (tool: "WARP" | "WIREGUARD", name: string): Promise<boolean> => {
    const plan = await infinite!.toolPlan(tool)
    if (plan.installed) return true
    const yes = window.confirm(
      `${name} is not installed.\n\nInstall it now from ${plan.url} (signed by ${plan.publisher})? Windows will ask for administrator permission.`,
    )
    if (!yes) {
      setResult({ ok: false, message: `Cancelled: ${name} was not installed.` })
      return false
    }
    setResult({ ok: true, message: `Installing ${name}…` })
    const installed = await infinite!.toolInstall(tool, true)
    setResult(installed)
    return installed.ok
  }

  // Auto: WARP if it is installed and connects, otherwise a direct connection. It never installs WARP.
  const autoConnect = async () => {
    if (busy()) return
    setSelected("AUTO")
    const warp = await infinite!.toolPlan("WARP")
    if (!warp.installed) return apply("NONE", "None (WARP is not installed)")
    setBusy(true)
    setResult({ ok: true, message: "Auto: trying WARP…" })
    try {
      const applied = await infinite!.setMode("WARP")
      addHistory({ mode: "WARP", ok: applied.ok, ip: applied.ip })
      if (applied.ok) {
        setMode("WARP")
        return setResult({ ok: true, message: `Auto: WARP. ${applied.message}`, ip: applied.ip })
      }
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
    await apply("NONE", "None (WARP did not connect)")
  }

  const pick = async (item: { id: Choice; label: string }) => {
    if (busy()) return
    try {
      if (item.id === "AUTO") return await autoConnect()
      if (item.id === "WARP" && !(await ensureInstalled("WARP", "WARP"))) return
      if (item.id === "ROUTE64") {
        if (!(await ensureInstalled("WIREGUARD", "WireGuard"))) return
        // Without a config the tunnel cannot start; say so here instead of failing inside the service.
        if (!(await infinite!.route64Status()).imported)
          return setResult({ ok: false, message: "No route64 config yet: import the .conf in Settings, Advanced." })
      }
      setSelected(item.id)
      await apply(item.id as Mode, item.label)
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  // What the bar says: the full detail with Verbose, otherwise the mode and the latest short state.
  const statusText = () => {
    if (verboseStatus())
      return [modeLabel(mode()), result()?.ip && `IP ${result()?.ip}`, result()?.message].filter(Boolean).join(" · ")
    const state = busy()
      ? (result()?.message ?? "Working…")
      : flash() || (result()?.ok === false ? "Not connected" : "Working")
    return `${modeLabel(mode())} · ${state}`
  }

  return (
    <Show when={infinite}>
      <div
        data-slot="infinite-bar"
        class="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-12-regular bg-v2-background-bg-deep border-t border-v2-border-border-muted text-v2-text-text-muted"
      >
        <div class="flex flex-wrap items-center gap-1 p-0.5 rounded-lg bg-v2-background-bg-layer-02" role="radiogroup" aria-label="Connection">
          <For each={visibleModes()}>
            {(item) => (
              <button
                type="button"
                role="radio"
                title={item.title}
                aria-checked={selected() === item.id}
                disabled={busy()}
                class="px-2.5 py-0.5 rounded-md disabled:pointer-events-none"
                classList={{
                  "bg-v2-background-bg-accent text-v2-text-text-base": selected() === item.id,
                  "hover:bg-v2-overlay-simple-overlay-hover": selected() !== item.id,
                }}
                onClick={() => void pick(item)}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>

        <button
          type="button"
          class={button}
          disabled={busy()}
          title="Tests what works on this computer and puts the best connection in place."
          onClick={() =>
            void run("Fixing the connection…", async () => {
              const outcome = await fixConnection(infinite!, (message) => setResult({ ok: true, message }), true)
              setMode(outcome.mode)
              setSelected(outcome.mode)
              return { ok: outcome.ok, message: outcome.message, ip: outcome.ip }
            })
          }
        >
          Fix connection
        </button>
        <button type="button" class={button} title="What works on this computer." onClick={() => void dialog.show(() => <ConnectionDialog />)}>
          Status
        </button>
        <button
          type="button"
          class={button}
          disabled={busy()}
          title='New IP and a fresh session, then sends "continue" to the open chat.'
          onClick={() => {
            const current = route()
            void run(
              "Resetting limit…",
              () => infinite!.resetLimit(current.type === "session" ? current.sessionId : undefined),
              "reset",
            )
          }}
        >
          {action() === "reset" ? "Resetting…" : "Reset limit"}
        </button>
        <label class="flex items-center gap-1.5" title="Rotates the IP when a limit error shows up or the connection drops. Keeps your session.">
          <input type="checkbox" checked={auto()} onChange={(event) => saveOptions(event.currentTarget.checked)} />
          Auto-rotate
        </label>
        <button type="button" class={button} onClick={() => void dialog.show(() => <SettingsDialog />)}>
          Settings
        </button>

        <span class="ms-auto flex items-center gap-1.5 min-w-0" role="status" aria-live="polite">
          <span
            class="size-2 shrink-0 rounded-full"
            classList={{
              "bg-v2-state-fg-warning animate-pulse": busy(),
              "bg-v2-state-fg-danger": !busy() && result()?.ok === false,
              "bg-green-500": !busy() && result()?.ok !== false,
            }}
          />
          <span class="truncate text-v2-text-text-faint" title={statusText()}>
            {statusText()}
          </span>
        </span>
        <InfiniteUsage />
      </div>
    </Show>
  )
}

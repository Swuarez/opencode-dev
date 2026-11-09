import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { usePlatform } from "@/runtime/platform/platform"
import { autoRotate as auto, setAutoRotate as setAuto } from "@/shell/infinite-state"
import { SettingsDialog } from "@/shell/settings-dialog"

type Mode = "WARP" | "TOR" | "PROXY" | "NONE"
type Result = { ok: boolean; message: string; ip?: string }

const modes: { id: Mode; label: string }[] = [
  { id: "WARP", label: "WARP" },
  { id: "TOR", label: "Tor" },
  { id: "PROXY", label: "Proxy" },
  { id: "NONE", label: "None" },
]

const button =
  "px-2.5 py-1 rounded-md text-v2-text-text-base bg-v2-background-bg-layer-02 hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50 disabled:pointer-events-none"

// Bottom bar with the OpenCode Infinite controls: connection mode, limit reset, IP check, session restore and themes.
export function InfiniteBar() {
  const platform = usePlatform()
  const dialog = useDialog()
  const infinite = platform.infinite
  const [mode, setMode] = createSignal<Mode>("NONE")
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<Result | undefined>()

  onMount(() => {
    void infinite?.getMode().then(setMode)
    void infinite?.getOptions().then((options) => setAuto(options.auto))
    void infinite?.checkIp().then(setResult)
    // Keeps the dot honest between clicks: a dead proxy shows up within seconds.
    const timer = setInterval(() => {
      if (!busy()) void infinite?.checkIp().then((checked) => !busy() && setResult(checked))
    }, 20_000)
    onCleanup(() => clearInterval(timer))
  })

  const saveOptions = (next: boolean) => {
    setAuto(next)
    void infinite?.getOptions().then((options) => infinite.setOptions({ ...options, auto: next }))
  }

  // Every action is single-flight, and the service restart behind it can take a while.
  const run = async (label: string, work: () => Promise<Result>) => {
    if (busy()) return
    setBusy(true)
    setResult({ ok: true, message: label })
    try {
      setResult(await work())
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={infinite}>
      <div
        data-slot="infinite-bar"
        class="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-12-regular bg-v2-background-bg-deep border-t border-v2-border-border-muted text-v2-text-text-muted"
      >
        <div class="flex items-center gap-1 p-0.5 rounded-lg bg-v2-background-bg-layer-02" role="radiogroup" aria-label="Connection">
          <For each={modes}>
            {(item) => (
              <button
                type="button"
                role="radio"
                aria-checked={mode() === item.id}
                disabled={busy()}
                class="px-2.5 py-0.5 rounded-md disabled:pointer-events-none"
                classList={{
                  "bg-v2-background-bg-accent text-v2-text-text-base": mode() === item.id,
                  "hover:bg-v2-overlay-simple-overlay-hover": mode() !== item.id,
                }}
                onClick={() => {
                  setMode(item.id)
                  void run(`Switching to ${item.label}…`, () => infinite!.setMode(item.id))
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>

        <button type="button" class={button} disabled={busy()} onClick={() => void run("Resetting limit…", () => infinite!.resetLimit())}>
          Reset limit
        </button>
        <label class="flex items-center gap-1.5" title="Rotates the IP when a limit error shows up or the connection drops. Keeps your session.">
          <input
            type="checkbox"
            checked={auto()}
            onChange={(event) => saveOptions(event.currentTarget.checked)}
          />
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
          <span class="truncate text-v2-text-text-faint">{result()?.message ?? ""}</span>
        </span>
      </div>
    </Show>
  )
}

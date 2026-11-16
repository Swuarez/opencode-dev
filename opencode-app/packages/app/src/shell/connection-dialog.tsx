import { For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { usePlatform } from "@/runtime/platform/platform"
import { addHistory } from "@/shell/infinite-history"
import { diagnose, fixConnection, type Mode, type Row } from "@/shell/infinite-doctor"
import { advancedMode } from "@/shell/infinite-state"
import { SettingsDialog } from "@/shell/settings-dialog"

const chip =
  "px-3.5 py-1.5 rounded-xl text-13-regular transition-colors disabled:opacity-50 bg-v2-background-bg-layer-02 text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
const primary =
  "px-4 py-2 rounded-xl text-13-regular transition-colors disabled:opacity-50 bg-v2-background-bg-accent text-v2-text-text-base"

/** What the computer has and what works, with one button that fixes the connection. `autostart` runs the fix on open. */
export function ConnectionDialog(props: { autostart?: boolean }) {
  const infinite = usePlatform().infinite
  const dialog = useDialog()
  const [state, setState] = createStore({
    rows: [] as Row[],
    mode: "" as Mode | "",
    busy: false,
    message: "",
    ok: true,
  })

  const refresh = async () => {
    if (!infinite) return
    setState({ rows: await diagnose(infinite), mode: (await infinite.getMode()) as Mode })
  }

  const fix = async (fresh: boolean) => {
    if (!infinite || state.busy) return
    setState({ busy: true, ok: true, message: "Starting…" })
    try {
      const outcome = await fixConnection(infinite, (message) => setState({ message }), fresh)
      setState({ ok: outcome.ok, message: [outcome.message, outcome.ip && `IP ${outcome.ip}`].filter(Boolean).join(" · ") })
    } catch (error) {
      setState({ ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    setState({ busy: false })
    window.dispatchEvent(new Event("infinite-connection"))
    await refresh()
  }

  const use = async (row: Row) => {
    if (!infinite || state.busy) return
    setState({ busy: true, ok: true, message: `Switching to ${row.label}…` })
    try {
      const applied = await infinite.setMode(row.id)
      addHistory({ mode: row.id, ok: applied.ok, ip: applied.ip })
      setState({ ok: applied.ok, message: applied.message })
      window.dispatchEvent(new Event("infinite-connection"))
    } catch (error) {
      setState({ ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    setState({ busy: false })
    await refresh()
  }

  // Installing needs the user's yes and, on Windows, administrator permission.
  const install = async (row: Row) => {
    if (!infinite || state.busy) return
    const plan = await infinite.toolPlan("WARP")
    if (plan.installed) return refresh()
    const yes = window.confirm(
      `WARP is not installed.\n\nInstall it now from ${plan.url} (signed by ${plan.publisher})? Windows will ask for administrator permission.`,
    )
    if (!yes) return
    setState({ busy: true, ok: true, message: `Installing ${row.label}…` })
    const done = await infinite.toolInstall("WARP", true).catch((error) => ({ ok: false, message: String(error) }))
    setState({ busy: false, ok: done.ok, message: done.message })
    await refresh()
    if (done.ok) await fix(true)
  }

  onMount(() => {
    void refresh().then(() => {
      if (props.autostart) void fix(true)
    })
  })

  const shown = () => state.rows.filter((row) => advancedMode() || !row.advanced)

  return (
    <Show when={infinite}>
      <Dialog size="wide">
        <DialogHeader>
          <DialogTitleGroup title="Connection" description="What works on this computer. Fix connection picks the best one for you." />
        </DialogHeader>
        <DialogBody class="min-h-0">
          <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 px-6 pb-6 pt-2">
            <div class="flex flex-wrap items-center gap-3">
              <button type="button" class={primary} disabled={state.busy} onClick={() => void fix(true)}>
                Fix connection
              </button>
              <Show when={state.message}>
                <span
                  class="text-13-regular"
                  classList={{ "text-v2-text-text-muted": state.ok, "text-v2-state-fg-danger": !state.ok }}
                  role="status"
                >
                  {state.message}
                </span>
              </Show>
            </div>
            <div class="flex flex-col gap-2">
              <For each={shown()}>
                {(row) => (
                  <div class="flex items-center gap-3 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-4 py-3">
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-13-medium text-v2-text-text-base">
                        {row.label}
                        <Show when={state.mode === row.id}>
                          <span class="ms-2 text-12-regular text-v2-state-fg-success">in use</span>
                        </Show>
                      </span>
                      <span class="text-12-regular text-v2-text-text-faint">{row.detail}</span>
                    </div>
                    <Show when={row.state === "ready" && state.mode !== row.id}>
                      <button type="button" class={chip} disabled={state.busy} onClick={() => void use(row)}>
                        Use
                      </button>
                    </Show>
                    <Show when={row.state === "install"}>
                      <button type="button" class={chip} disabled={state.busy} onClick={() => void install(row)}>
                        Install
                      </button>
                    </Show>
                    <Show when={row.state === "setup"}>
                      <button type="button" class={chip} onClick={() => dialog.show(() => <SettingsDialog />)}>
                        Settings
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={!advancedMode()}>
              <p class="text-12-regular text-v2-text-text-faint">
                More options (your own proxies, SOCKS5, Route64, Mullvad, Windscribe) show with Settings, Advanced mode.
              </p>
            </Show>
          </div>
        </DialogBody>
      </Dialog>
    </Show>
  )
}

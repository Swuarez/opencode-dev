import { createSignal, For, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useTheme, type ColorScheme } from "@opencode/ui/theme/context"
import { usePlatform } from "@/runtime/platform/platform"
import { clearBackground, getBackground, getDialogOpacity, getRainbow, getTextColor, setBackgroundFile, setBackgroundOpacity, setDialogOpacity, setRainbow, setTextColor, type RainbowTarget } from "@/shell/infinite-look"
import { createAppearanceSettingsController } from "@/settings/general/controllers"
import { readHistory } from "@/shell/infinite-history"
import { advancedMode, dictation, setAdvancedMode, setDictation, setVerboseStatus, verboseStatus } from "@/shell/infinite-state"

type Tab = "basic" | "advanced" | "personalization"

const tabs: { id: Tab; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "advanced", label: "Advanced" },
  { id: "personalization", label: "Personalization" },
]
const schemes: ColorScheme[] = ["system", "light", "dark"]

const chip = (active: boolean) =>
  `px-4 py-2 rounded-xl text-13-regular transition-colors disabled:opacity-50 ${active ? "bg-v2-background-bg-accent text-v2-text-text-base" : "bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"}`

const field =
  "w-full px-3.5 py-2.5 rounded-xl text-13-regular bg-v2-background-bg-layer-02 text-v2-text-text-base border border-v2-border-border-muted focus:outline-none focus:border-v2-background-bg-accent"

// A bordered group with a title and one line saying what it does. Every tab uses it, so the dialog reads the same everywhere.
function Card(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-4 rounded-2xl border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-5">
      <div class="flex flex-col gap-1">
        <h3 class="text-13-medium text-v2-text-text-base">{props.title}</h3>
        <Show when={props.hint}>
          <p class="text-12-regular text-v2-text-text-faint">{props.hint}</p>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

// Basic: what most people need. Advanced: proxies and the route64 tunnel. Themes: colors, mode and the background picture.
export function SettingsDialog() {
  const [tab, setTab] = createSignal<Tab>("basic")
  // The Advanced tab only exists in advanced mode; turning the mode off from it goes back to Basic.
  const visibleTabs = () => tabs.filter((item) => item.id !== "advanced" || advancedMode())
  const toggleAdvanced = () => {
    if (advancedMode()) {
      setTab("basic")
      setAdvancedMode(false)
    } else setAdvancedMode(true)
  }
  return (
    <Dialog size="wide" containerClass="infinite-settings">
      <DialogHeader>
        <DialogTitleGroup title="Settings" description="Connection and appearance. Basic has what most people need." />
      </DialogHeader>
      <DialogBody class="min-h-0">
        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 px-6 pb-6 pt-2">
          <div class="flex gap-1 p-1 rounded-2xl bg-v2-background-bg-layer-02 self-start" role="tablist">
            <For each={visibleTabs()}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab() === item.id}
                  class="px-5 py-2 rounded-xl text-13-regular transition-colors"
                  classList={{
                    "bg-v2-background-bg-accent text-v2-text-text-base": tab() === item.id,
                    "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover": tab() !== item.id,
                  }}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
          <Switch>
            <Match when={tab() === "basic"}>
              <div class="flex flex-col gap-5">
                <Card
                  title="Advanced mode"
                  hint="Off: only Auto and None show. On: every connection (WARP, Tor, Proxy, Route64, Mullvad, Windscribe) and the Advanced tab."
                >
                  <div>
                    <button type="button" class={chip(advancedMode())} onClick={toggleAdvanced}>
                      {advancedMode() ? "Hide advanced options" : "Show all options"}
                    </button>
                  </div>
                </Card>
                <BasicSection />
                <Card
                  title="Status detail"
                  hint="The text in the bottom-right corner. Off: only the connection and a one-word state (Working, Changing IP). On: the full detail with IP, timings and what was resumed."
                >
                  <div>
                    <button type="button" class={chip(verboseStatus())} onClick={() => setVerboseStatus(!verboseStatus())}>
                      {verboseStatus() ? "Detailed" : "Simple"}
                    </button>
                  </div>
                </Card>
                <Show when={usePlatform().infinite?.dictate}>
                  <Card
                    title="Voice dictation"
                    hint="Adds a microphone next to Send. It opens Windows voice typing (Win+H) in the message box; talk and your words are typed there. Press Enter yourself to send."
                  >
                    <DictationSection />
                  </Card>
                </Show>
              </div>
            </Match>
            <Match when={tab() === "advanced"}>
              <div class="flex flex-col gap-5">
                <Card
                  title="Proxies"
                  hint="One proxy or a whole list: host:port, host:port:user:password or http://user:password@host:port, separated by lines, spaces or commas. HTTP proxies only; SOCKS5 goes in its own box below. A rotating proxy goes in the list too. Empty means the free list. Used by the Proxy choice in the bottom bar."
                >
                  <div class="flex flex-col gap-6">
                    <ProxySection />
                    <ChangeIpSection />
                  </div>
                </Card>
                <Card
                  title="SOCKS5 servers"
                  hint="What the SOCKS5 choice in the bottom bar connects through: host:port, host:port:user:password, socks5://host:port or socks5://user:password@host:port, one per line. They are only reachable from this computer."
                >
                  <SocksSection />
                </Card>
                <Card
                  title="Failover chain"
                  hint="Modes Auto-rotate falls back to, in order, when the chosen one cannot get a fresh IP, for example TOR,PROXY. Empty keeps it on the chosen mode."
                >
                  <ChainSection />
                </Card>
                <Card title="route64 tunnel" hint="Import the .conf from manager.route64.org. Choose Route64 in the bottom bar to connect.">
                  <Route64Section />
                </Card>
                <Card title="VPN locations" hint="Mullvad or Windscribe locations to switch between, separated by commas. Empty means the defaults.">
                  <VpnLocationsSection />
                </Card>
              </div>
            </Match>
            <Match when={tab() === "personalization"}>
              <div class="flex flex-col gap-5">
                <Card title="Theme" hint="Applied at once, so you can judge it live.">
                  <ThemeSection />
                </Card>
                <Card title="Rainbow moves" hint="Only for the Rainbow theme: which part changes color.">
                  <RainbowSection />
                </Card>
                <Card title="Font" hint="Any font installed on this computer. Empty means the default.">
                  <FontSection />
                </Card>
                <Card title="Size" hint="Makes the whole app bigger or smaller.">
                  <SizeSection />
                </Card>
                <Card title="Motion" hint="Turn off the moving parts of the interface.">
                  <MotionSection />
                </Card>
                <Card title="Settings window" hint="How solid this window is. Lower shows more of what is behind it.">
                  <DialogOpacitySection />
                </Card>
                <Card title="Background" hint="Your own picture behind the window. It is shrunk and kept in this app only.">
                  <BackgroundSection />
                </Card>
                <Card title="Text color" hint="One color for all the text, over any theme.">
                  <TextColorSection />
                </Card>
              </div>
            </Match>
          </Switch>
        </div>
      </DialogBody>
    </Dialog>
  )
}

function DictationSection() {
  return (
    <div>
      <button type="button" class={chip(dictation().on)} onClick={() => setDictation({ on: !dictation().on })}>
        {dictation().on ? "Microphone on" : "Show microphone"}
      </button>
    </div>
  )
}

function ProxySection() {
  const infinite = usePlatform().infinite
  const [custom, setCustom] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [note, setNote] = createSignal<{ ok: boolean; text: string } | undefined>()
  const [busy, setBusy] = createSignal(false)
  let file: HTMLInputElement | undefined
  onMount(() => void infinite?.getOptions().then((options) => setCustom(options.custom)))

  const append = (text: string) => setCustom((current) => `${current.trim()}\n${text}`.trim())

  // A URL that ends in a port is a proxy itself; any other URL is a list to download.
  const addUrl = async () => {
    const value = url().trim()
    if (!infinite || !value || busy()) return
    if (/:\d{1,5}\/?$/.test(value)) {
      append(value)
      setUrl("")
      return setNote({ ok: true, text: "Proxy added to the list. Press Save to use it." })
    }
    setBusy(true)
    setNote({ ok: true, text: "Downloading the list…" })
    try {
      const fetched = await infinite.fetchList(value)
      if (!fetched.ok) return setNote({ ok: false, text: "Could not download that URL (check the address and that it is plain text)." })
      append(fetched.text)
      setUrl("")
      setNote({ ok: true, text: "List downloaded and added. Press Save to use it." })
    } finally {
      setBusy(false)
    }
  }

  // The service reads its proxy only when it starts, so a change while Proxy is active re-applies the mode.
  const save = async (value: string) => {
    if (!infinite || busy()) return
    setBusy(true)
    setNote({ ok: true, text: "Saving…" })
    try {
      const options = await infinite.getOptions()
      const saved = await infinite.setOptions({ ...options, custom: value })
      setCustom(saved.custom)
      const count = saved.custom ? saved.custom.split("\n").length : 0
      const skipped = value.split(/[\s,;]+/).filter(Boolean).length - count
      const kept = `${count} ${count === 1 ? "proxy" : "proxies"}${skipped > 0 ? `, ${skipped} invalid skipped` : ""}`
      if ((await infinite.getMode()) !== "PROXY")
        return setNote({ ok: true, text: count ? `Saved ${kept}. Used when you pick Proxy.` : "Saved. Proxy uses the free list." })
      setNote({ ok: true, text: "Testing the proxies…" })
      const applied = await infinite.setMode("PROXY")
      setNote({ ok: applied.ok, text: applied.ok ? `Active. ${applied.message}` : applied.message })
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <h3 class="text-13-medium text-v2-text-text-base">From a file</h3>
        <div class="flex items-center gap-3">
          <button type="button" class={chip(false)} disabled={busy()} onClick={() => file?.click()}>
            Choose file…
          </button>
          <span class="text-12-regular text-v2-text-text-faint">.txt, .csv or .list, one proxy per line</span>
        </div>
        <input
          ref={file}
          type="file"
          accept=".txt,.csv,.list,text/plain"
          class="hidden"
          onChange={async (event) => {
            const picked = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (!picked) return
            const text = await picked.text()
            append(text)
            setNote({ ok: true, text: `Loaded ${picked.name}. Press Save to use it.` })
          }}
        />
      </div>

      <div class="flex flex-col gap-2">
        <h3 class="text-13-medium text-v2-text-text-base">From a URL</h3>
        <div class="flex gap-2">
          <input
            type="text"
            class={field}
            placeholder="https://example.com/proxies.txt  or  http://host:3128"
            spellcheck={false}
            autocomplete="off"
            value={url()}
            onInput={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && void addUrl()}
          />
          <button type="button" class={chip(false)} disabled={busy() || !url().trim()} onClick={() => void addUrl()}>
            Add
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <h3 class="text-13-medium text-v2-text-text-base">Your list</h3>
        <textarea
          rows={7}
          class={`${field} font-mono resize-y`}
          placeholder={"127.0.0.1:8080\nhttp://user:password@host:3128"}
          spellcheck={false}
          autocomplete="off"
          value={custom()}
          onInput={(event) => setCustom(event.currentTarget.value)}
        />
      </div>

      <div class="flex items-center gap-3 flex-wrap">
        <button type="button" class={chip(true)} disabled={busy()} onClick={() => void save(custom())}>
          Save
        </button>
        <button type="button" class={chip(false)} disabled={busy()} onClick={() => void save("")}>
          Use free list
        </button>
        <Show when={note()}>
          {(item) => (
            <span class="flex items-center gap-2 min-w-0 text-12-regular text-v2-text-text-muted" role="status">
              <span class="size-2 shrink-0 rounded-full" classList={{ "bg-green-500": item().ok, "bg-v2-state-fg-danger": !item().ok }} />
              <span class="truncate">{item().text}</span>
            </span>
          )}
        </Show>
      </div>
      <p class="text-12-regular text-v2-text-text-faint">
        With a list, Auto-rotate moves to another proxy of it. A single proxy cannot change the IP unless the provider rotates it.
      </p>
    </section>
  )
}

function ChainSection() {
  const infinite = usePlatform().infinite
  const [chain, setChain] = createSignal("")
  const [burned, setBurned] = createSignal(0)
  const [note, setNote] = createSignal<string>()
  onMount(() =>
    void infinite?.getOptions().then((options) => {
      setChain(options.chain)
      setBurned(options.burned)
    }),
  )

  const save = async () => {
    if (!infinite) return
    try {
      const saved = await infinite.setOptions({ ...(await infinite.getOptions()), chain: chain() })
      setChain(saved.chain)
      setNote(saved.chain ? `Saved: ${saved.chain}.` : "Cleared; only the chosen mode is used.")
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
  }

  const forget = async () => {
    if (!infinite) return
    const done = await infinite.clearBurned()
    setBurned((await infinite.getOptions()).burned)
    setNote(done.message)
  }

  return (
    <section class="flex flex-col gap-3">
      <input
        class={`${field} font-mono`}
        placeholder="TOR,PROXY"
        spellcheck={false}
        autocomplete="off"
        value={chain()}
        onInput={(event) => setChain(event.currentTarget.value)}
      />
      <div class="flex items-center gap-3">
        <button type="button" class={chip(true)} onClick={() => void save()}>
          Save
        </button>
        <button type="button" class={chip(false)} onClick={() => void forget()}>
          Forget {burned()} used {burned() === 1 ? "IP" : "IPs"}
        </button>
        <Show when={note()}>{(value) => <span class="text-12-regular text-v2-text-text-muted">{value()}</span>}</Show>
      </div>
      <p class="text-12-regular text-v2-text-text-muted">
        A rotation never hands out an IP this run already used. Short lists start over on their own once every entry was
        used; forget them here to allow a known good one right away.
      </p>
    </section>
  )
}

function SocksSection() {
  const infinite = usePlatform().infinite
  const [text, setText] = createSignal("")
  const [note, setNote] = createSignal<string>()
  onMount(() => void infinite?.getOptions().then((options) => setText(options.socks)))

  const save = async () => {
    if (!infinite) return
    try {
      const options = await infinite.getOptions()
      const saved = await infinite.setOptions({ ...options, socks: text() })
      setText(saved.socks)
      const count = saved.socks ? saved.socks.split("\n").length : 0
      if ((await infinite.getMode()) === "SOCKS") {
        const applied = await infinite.setMode("SOCKS")
        return setNote(applied.ok ? `Active. ${applied.message}` : applied.message)
      }
      setNote(count ? `Saved ${count} ${count === 1 ? "server" : "servers"}. Used when you pick SOCKS5.` : "Cleared.")
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section class="flex flex-col gap-3">
      <textarea
        rows={5}
        class={`${field} font-mono resize-y`}
        placeholder={"host:port\nsocks5://user:password@host:1080"}
        spellcheck={false}
        autocomplete="off"
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div class="flex items-center gap-3">
        <button type="button" class={chip(true)} onClick={() => void save()}>
          Save
        </button>
        <Show when={note()}>{(value) => <span class="text-12-regular text-v2-text-text-muted">{value()}</span>}</Show>
      </div>
    </section>
  )
}

function DialogOpacitySection() {
  const [value, setValue] = createSignal(getDialogOpacity())
  return (
    <label class="flex items-center gap-3 text-12-regular text-v2-text-text-muted">
      <span class="w-40 shrink-0">Window opacity {value()}%</span>
      <input
        type="range"
        min="30"
        max="100"
        value={value()}
        class="flex-1"
        onInput={(event) => {
          setDialogOpacity(Number(event.currentTarget.value))
          setValue(getDialogOpacity())
        }}
      />
    </label>
  )
}

// Your own picture behind the window; the opacity is how much of the normal interface color stays over it.
function BackgroundSection() {
  const [look, setLook] = createSignal(getBackground())
  const [note, setNote] = createSignal<string | undefined>()
  let file: HTMLInputElement | undefined
  const refresh = () => setLook(getBackground())

  return (
    <div class="flex flex-col gap-2">
      <h3 class="text-13-medium text-v2-text-text-base">Background image</h3>
      <div class="flex items-center gap-3 flex-wrap">
        <button type="button" class={chip(false)} onClick={() => file?.click()}>
          Choose image…
        </button>
        <button
          type="button"
          class={chip(false)}
          disabled={!look().image}
          onClick={() => {
            clearBackground()
            refresh()
            setNote(undefined)
          }}
        >
          Remove
        </button>
        <span class="text-12-regular text-v2-text-text-faint">PNG, JPG or WebP; it is shrunk and kept in this app only</span>
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        class="hidden"
        onChange={async (event) => {
          const picked = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (!picked) return
          setNote((await setBackgroundFile(picked)) ?? undefined)
          refresh()
        }}
      />
      <Show when={look().image}>
        <label class="flex items-center gap-3 text-12-regular text-v2-text-text-muted">
          <span class="w-40 shrink-0">Interface opacity {look().opacity}%</span>
          <input
            type="range"
            min="30"
            max="100"
            value={look().opacity}
            class="flex-1"
            onInput={(event) => {
              setBackgroundOpacity(Number(event.currentTarget.value))
              refresh()
            }}
          />
        </label>
      </Show>
      <Show when={note()}>{(text) => <span class="text-12-regular text-v2-state-fg-danger">{text()}</span>}</Show>
    </div>
  )
}

// One color for all the text, over any theme; without it the theme decides (and Rainbow makes the text flow).
function TextColorSection() {
  const [color, setColor] = createSignal(getTextColor())
  const pick = (value: string) => {
    setTextColor(value)
    setColor(getTextColor())
  }

  return (
    <div class="flex flex-col gap-2">
      <h3 class="text-13-medium text-v2-text-text-base">Text color</h3>
      <div class="flex items-center gap-3 flex-wrap">
        <input
          type="color"
          aria-label="Text color"
          class="h-9 w-14 rounded-lg bg-transparent cursor-pointer"
          value={color() || "#ffffff"}
          onInput={(event) => pick(event.currentTarget.value)}
        />
        <button type="button" class={chip(false)} disabled={!color()} onClick={() => pick("")}>
          Use the theme's
        </button>
        <span class="text-12-regular text-v2-text-text-faint">
          {color() ? `${color()} on every theme` : "The theme's own colors; the Rainbow theme changes them when its target is Text"}
        </span>
      </div>
    </div>
  )
}

/** route64: import the .conf the manager gives you, then connect. Desktop only; the bridge is missing elsewhere. */
// Optional URL that changes the IP when opened; Proxy mode calls it before each rotation.
function ChangeIpSection() {
  const infinite = usePlatform().infinite
  const [rotateUrl, setRotateUrl] = createSignal("")
  const [note, setNote] = createSignal<string>()
  onMount(() => void infinite?.getOptions().then((options) => setRotateUrl(options.rotateUrl)))

  const save = async () => {
    if (!infinite) return
    try {
      const options = await infinite.getOptions()
      const saved = await infinite.setOptions({ ...options, rotateUrl: rotateUrl().trim() })
      setRotateUrl(saved.rotateUrl)
      setNote(saved.rotateUrl ? "Saved." : "Cleared.")
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Show when={infinite}>
      <div class="flex flex-col gap-3">
        <h3 class="text-13-medium text-v2-text-text-base">Change-IP URL (optional)</h3>
        <p class="text-13-regular text-v2-text-text-muted">
          Some providers change the IP when a URL is opened. Leave empty if your proxy already changes the IP per request.
        </p>
        <input
          type="text"
          class={field}
          placeholder="https://provider.example/rotate?key=…"
          spellcheck={false}
          autocomplete="off"
          value={rotateUrl()}
          onInput={(event) => setRotateUrl(event.currentTarget.value)}
        />
        <div class="flex items-center gap-3">
          <button type="button" class={chip(true)} onClick={() => void save()}>
            Save
          </button>
          <Show when={note()}>
            <span class="text-12-regular text-v2-text-text-faint">{note()}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function VpnLocationsSection() {
  const infinite = usePlatform().infinite
  const [locations, setLocations] = createSignal("")
  const [note, setNote] = createSignal<string>()
  onMount(() => void infinite?.getOptions().then((options) => setLocations(options.vpnLocations)))

  const save = async () => {
    if (!infinite) return
    try {
      const options = await infinite.getOptions()
      const saved = await infinite.setOptions({ ...options, vpnLocations: locations() })
      setLocations(saved.vpnLocations)
      setNote("Saved.")
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Show when={infinite}>
      <div class="flex flex-col gap-3">
        <input
          type="text"
          class={field}
          placeholder="Mullvad: se, de, nl   Windscribe: US-East, UK"
          spellcheck={false}
          autocomplete="off"
          value={locations()}
          onInput={(event) => setLocations(event.currentTarget.value)}
        />
        <div class="flex items-center gap-3">
          <button type="button" class={chip(true)} onClick={() => void save()}>
            Save
          </button>
          <Show when={note()}>
            <span class="text-12-regular text-v2-text-text-faint">{note()}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function Route64Section() {
  const infinite = usePlatform().infinite
  const [status, setStatus] = createSignal<{ imported: boolean; endpoint?: string; up: boolean }>()
  const [note, setNote] = createSignal<string>()
  let file: HTMLInputElement | undefined
  const refresh = () => void infinite?.route64Status().then(setStatus)
  onMount(refresh)

  const load = async (input: HTMLInputElement) => {
    const picked = input.files?.[0]
    input.value = ""
    if (!picked) return
    const result = await infinite?.route64Import(await picked.text())
    setNote(result?.message)
    refresh()
  }

  const act = async (run: () => Promise<{ message: string } | undefined> | undefined) => {
    const result = await run()
    setNote(result?.message)
    refresh()
  }

  // Connecting is the Route64 choice in the bottom bar: it installs WireGuard if needed and brings the tunnel up.
  return (
    <Show when={infinite}>
      <div class="flex flex-col gap-3">
        <div class="flex items-center gap-3 flex-wrap">
          <button type="button" class={chip(false)} onClick={() => file?.click()}>
            {status()?.imported ? "Replace .conf…" : "Import .conf…"}
          </button>
          <button type="button" class={chip(false)} disabled={!status()?.imported} onClick={() => void act(() => infinite?.route64Remove())}>
            Remove
          </button>
        </div>
        <span class="text-12-regular text-v2-text-text-muted">
          {status()?.imported
            ? `Config saved. Endpoint ${status()?.endpoint}${status()?.up ? " · tunnel up" : " · tunnel down"}`
            : "No config yet. Download the .conf from manager.route64.org."}
        </span>
        <Show when={note()}>
          <span class="text-12-regular text-v2-text-text-base">{note()}</span>
        </Show>
        <input ref={file} type="file" accept=".conf" class="hidden" onChange={(event) => void load(event.currentTarget)} />
      </div>
    </Show>
  )
}

// Two-letter country code for the proxy pick; empty means any. Saved on blur, no extra button.
function CountryField() {
  const infinite = usePlatform().infinite
  const [country, setCountry] = createSignal("")
  const [note, setNote] = createSignal<string>()
  onMount(() => void infinite?.getOptions().then((options) => setCountry(options.country)))

  const save = async (value: string) => {
    const code = value.trim().toUpperCase()
    if (code && !/^[A-Z]{2}$/.test(code)) return setNote("Use two letters, like ES.")
    const options = await infinite?.getOptions()
    if (!options) return
    await infinite?.setOptions({ ...options, country: code })
    setCountry(code)
    setNote(code ? `Exit country set to ${code}.` : "Any country.")
  }

  return (
    <div class="flex items-center gap-3 flex-wrap">
      <input
        type="text"
        maxLength={2}
        class={`${field} w-24`}
        placeholder="Any"
        value={country()}
        spellcheck={false}
        autocomplete="off"
        onInput={(event) => setCountry(event.currentTarget.value.toUpperCase())}
        onBlur={(event) => void save(event.currentTarget.value)}
        onKeyDown={(event) => event.key === "Enter" && void save(event.currentTarget.value)}
      />
      <Show when={note()}>{(text) => <span class="text-12-regular text-v2-text-text-muted">{text()}</span>}</Show>
    </div>
  )
}

// Fast mode: skips the IP probe before "continue" (see infinite.ts hunt). Saved at once, like the country.
function FastField() {
  const infinite = usePlatform().infinite
  const [fast, setFast] = createSignal(false)
  onMount(() => void infinite?.getOptions().then((options) => setFast(options.fast)))

  const save = async (next: boolean) => {
    const options = await infinite?.getOptions()
    if (!options) return
    await infinite?.setOptions({ ...options, fast: next })
    setFast(next)
  }

  return (
    <label class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
      <input type="checkbox" checked={fast()} onChange={(event) => void save(event.currentTarget.checked)} />
      Fast mode
    </label>
  )
}

// How many IPs one Auto-rotate tries before it gives up (see infinite.ts hunt). Saved when the field is left.
function AttemptsField() {
  const infinite = usePlatform().infinite
  const [attempts, setAttempts] = createSignal(10)
  onMount(() => void infinite?.getOptions().then((options) => setAttempts(options.attempts)))

  const save = async (value: string) => {
    const options = await infinite?.getOptions()
    if (!options) return
    // The main process clamps it to 1-50; the field shows what was really kept.
    const kept = await infinite?.setOptions({ ...options, attempts: Number(value) })
    if (kept) setAttempts(kept.attempts)
  }

  return (
    <label class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
      <input
        type="number"
        min="1"
        max="50"
        class={field.replace("w-full", "w-20")}
        value={attempts()}
        onChange={(event) => void save(event.currentTarget.value)}
      />
      IPs to try per rotation
    </label>
  )
}

// Basic: the connection itself is picked in the bottom bar. Here are the settings that change how it behaves.
// Restore defaults: free proxy list, Auto-rotate on, no background, theme text color; the theme itself is kept.
function BasicSection() {
  const infinite = usePlatform().infinite
  const [note, setNote] = createSignal<{ ok: boolean; text: string }>()
  const [busy, setBusy] = createSignal(false)

  const restore = async () => {
    if (!infinite || busy()) return
    setBusy(true)
    try {
      const options = await infinite.getOptions()
      await infinite.setOptions({ ...options, auto: true, country: "", custom: "", fast: false })
      clearBackground()
      setTextColor("")
      setNote({ ok: true, text: "Defaults restored: free proxy list, Auto-rotate on, no background, theme colors." })
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <Card title="Exit country" hint="Two letters, like ES or DE, for proxies from that country. Leave empty for any country.">
        <CountryField />
      </Card>

      <Card
        title="Speed"
        hint='Fast mode sends "continue" as soon as the IP changes, without checking it first: about 3 to 4 s instead of about 7 s. If the new IP is already limited, the chat hits the limit again and rotates again.'
      >
        <FastField />
      </Card>

      <Card
        title="Auto-rotate attempts"
        hint="How many new IPs Auto-rotate tries, each checked on a temporary session, before it stops and tells you. More attempts find a free IP more often but can take longer. 1 to 50, default 10."
      >
        <AttemptsField />
      </Card>

      <Card title="Recent connection changes" hint="The last ten changes on this computer. Nothing is sent anywhere.">
        <div class="flex flex-col gap-1">
          <For each={readHistory()} fallback={<span class="text-12-regular text-v2-text-text-faint">No changes yet.</span>}>
            {(entry) => (
              <span class="text-12-regular text-v2-text-text-muted">
                {new Date(entry.at).toLocaleTimeString()} · {entry.mode} · {entry.ok ? "ok" : "failed"}
                {entry.ip ? ` · IP ${entry.ip}` : ""}
              </span>
            )}
          </For>
        </div>
      </Card>

      <Card
        title="Reset"
        hint="Puts back the free proxy list, turns Auto-rotate on and Fast mode off, and removes your background and text color."
      >
        <div class="flex items-center gap-3 flex-wrap">
          <button type="button" class={chip(false)} disabled={busy()} onClick={() => void restore()}>
            Restore defaults
          </button>
          <Show when={note()}>
            {(item) => (
              <span class="flex items-center gap-2 min-w-0 text-12-regular text-v2-text-text-muted" role="status">
                <span class="size-2 shrink-0 rounded-full" classList={{ "bg-green-500": item().ok, "bg-v2-state-fg-danger": !item().ok }} />
                <span>{item().text}</span>
              </span>
            )}
          </Show>
        </div>
      </Card>
    </div>
  )
}

const rainbowTargets: { id: RainbowTarget; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "background", label: "Background" },
]

// Only the rainbow theme reads this: the letters or the window change color, never the buttons and borders.
function RainbowSection() {
  const [target, setTarget] = createSignal<RainbowTarget>(getRainbow())
  const pick = (id: RainbowTarget) => {
    setRainbow(id)
    setTarget(id)
  }
  return (
    <div class="flex flex-col gap-3">
      <div class="flex gap-2 flex-wrap">
        <For each={rainbowTargets}>
          {(item) => (
            <button type="button" class={chip(target() === item.id)} onClick={() => pick(item.id)}>
              {item.label}
            </button>
          )}
        </For>
      </div>
      <p class="text-12-regular text-v2-text-text-faint">Text: the letters change color. Background: the window changes color.</p>
    </div>
  )
}

const fontRows = [
  { label: "Interface font", kind: "ui" as const },
  { label: "Code font", kind: "code" as const },
  { label: "Terminal font", kind: "terminal" as const },
]

function FontSection() {
  const appearance = createAppearanceSettingsController()
  const set = { ui: appearance.fonts.setUI, code: appearance.fonts.setCode, terminal: appearance.fonts.setTerminal }
  return (
    <div class="flex flex-col gap-4">
      <For each={fontRows}>
        {(row) => (
          <label class="flex flex-col gap-1.5">
            <span class="text-13-medium text-v2-text-text-base">{row.label}</span>
            <input
              type="text"
              class={field}
              style={{ "font-family": appearance.fonts[row.kind]().family }}
              placeholder={appearance.fonts[row.kind]().placeholder}
              value={appearance.fonts[row.kind]().value}
              spellcheck={false}
              autocomplete="off"
              onInput={(event) => set[row.kind](event.currentTarget.value)}
            />
          </label>
        )}
      </For>
    </div>
  )
}

function SizeSection() {
  const appearance = createAppearanceSettingsController()
  return (
    <Show when={appearance.zoom.available()}>
      <div class="flex gap-2 flex-wrap">
        <For each={appearance.zoom.options}>
          {(level) => (
            <button type="button" class={chip(appearance.zoom.current() === level)} onClick={() => appearance.zoom.select(level)}>
              {appearance.zoom.label(level)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

const motionOptions = [
  { value: "system", label: "System" },
  { value: "on", label: "Reduced" },
  { value: "off", label: "Full" },
] as const

function MotionSection() {
  const appearance = createAppearanceSettingsController()
  return (
    <div class="flex gap-2 flex-wrap">
      <For each={motionOptions}>
        {(item) => (
          <button type="button" class={chip(appearance.reduceMotion.current() === item.value)} onClick={() => appearance.reduceMotion.select(item.value)}>
            {item.label}
          </button>
        )}
      </For>
    </div>
  )
}

function ThemeSection() {
  const theme = useTheme()
  onMount(() => void theme.loadThemes())

  // Rainbow first, then the pastel themes; the rest keep their alphabetical order.
  const rank = (id: string) => (id === "rainbow" ? 2 : id.startsWith("pastel") ? 1 : 0)
  const ids = () => [...theme.ids()].sort((a, b) => rank(b) - rank(a))

  return (
    <section class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <h3 class="text-13-medium text-v2-text-text-base">Mode</h3>
        <div class="flex gap-2">
          <For each={schemes}>
            {(scheme) => (
              <button type="button" class={chip(theme.colorScheme() === scheme)} onClick={() => theme.setColorScheme(scheme)}>
                {scheme[0]!.toUpperCase() + scheme.slice(1)}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <h3 class="text-13-medium text-v2-text-text-base">Theme</h3>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          <For each={ids()}>
            {(id) => (
              <button type="button" class={`${chip(theme.themeId() === id)} truncate text-start`} onClick={() => theme.setTheme(id)}>
                {theme.name(id)}
              </button>
            )}
          </For>
        </div>
      </div>
    </section>
  )
}

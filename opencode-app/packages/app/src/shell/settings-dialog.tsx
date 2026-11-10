import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useTheme, type ColorScheme } from "@opencode/ui/theme/context"
import { usePlatform } from "@/runtime/platform/platform"
import { clearBackground, getBackground, setBackgroundFile, setBackgroundOpacity } from "@/shell/infinite-look"

type Tab = "proxy" | "themes"

const tabs: { id: Tab; label: string }[] = [
  { id: "proxy", label: "Proxy" },
  { id: "themes", label: "Themes" },
]
const schemes: ColorScheme[] = ["system", "light", "dark"]

const chip = (active: boolean) =>
  `px-4 py-2 rounded-xl text-13-regular transition-colors disabled:opacity-50 ${active ? "bg-v2-background-bg-accent text-v2-text-text-base" : "bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"}`

const field =
  "w-full px-3.5 py-2.5 rounded-xl text-13-regular bg-v2-background-bg-layer-02 text-v2-text-text-base border border-v2-border-border-muted focus:outline-none focus:border-v2-background-bg-accent"

// Two sections: the proxies used by the Proxy mode, and the color theme (applied at once, so it can be judged live).
export function SettingsDialog() {
  const [tab, setTab] = createSignal<Tab>("proxy")
  return (
    <Dialog size="wide">
      <DialogHeader>
        <DialogTitleGroup title="Settings" description="Proxy and appearance." />
      </DialogHeader>
      <DialogBody class="min-h-0">
        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 px-6 pb-6 pt-2">
          <div class="flex gap-1 p-1 rounded-2xl bg-v2-background-bg-layer-02 self-start" role="tablist">
            <For each={tabs}>
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
            <Match when={tab() === "proxy"}>
              <ProxySection />
            </Match>
            <Match when={tab() === "themes"}>
              <ThemeSection />
            </Match>
          </Switch>
        </div>
      </DialogBody>
    </Dialog>
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
      <p class="text-13-regular text-v2-text-text-muted">
        One proxy or a whole list: host:port or http://user:password@host:port, separated by lines, spaces or commas. HTTP proxies only. Empty
        means the free list.
      </p>

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
      <BackgroundSection />
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

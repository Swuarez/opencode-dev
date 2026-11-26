import { createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
import { Badge } from "@opencode/ui/badge"
import { useDialog } from "@opencode/ui/context/dialog"
import type { ComposerState } from "@/composer/persistence"
import { isFreeModel } from "@/providers/models/models"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal, type ServerCtx } from "@/runtime/server/runtime"
import { useCommand } from "@/shell/commands/command"
import { useCurrentRoute, useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { useUsageFormat } from "@/usage/format"
import { type CurrentModel, usageView } from "@/usage/limits"

type ModelKey = { readonly providerID: string; readonly modelID: string }

type Target = {
  readonly ctx: ServerCtx
  readonly directory: string
  readonly key?: ModelKey
}

/**
 * The model in use and the account's usage at the end of the Infinite bar. The bar sits above the routed server
 * providers, so this resolves the active server and location itself and hands the Usage dialog that server's data.
 */
export function InfiniteUsage() {
  const language = useLanguage()
  const dialog = useDialog()
  const command = useCommand()
  const global = useGlobal()
  const layout = useLayout()
  const tabs = useTabs()
  const route = useCurrentRoute()
  const format = useUsageFormat()

  const target = createMemo<Target | undefined>(() => {
    const current = route()

    if (current.type === "session") {
      const ctx = global.serverCtx(current.server)
      const session = ctx?.data.session.get(current.sessionId)

      if (!ctx || !session) return

      // The session's durable model wins; the open composer covers a session that has not saved one yet.
      const tab = tabs.sessionTab(current.server, current.sessionId)
      const composer = tab ? tabs.stateValue<ComposerState>(tab, "prompt")?.model.current() : undefined

      return {
        ctx,
        directory: session.location.directory,
        key: session.model
          ? { providerID: session.model.providerID, modelID: session.model.id }
          : composer
            ? { providerID: composer.providerID, modelID: composer.modelID }
            : undefined,
      }
    }

    if (current.type === "draft") {
      const tab = tabs.store.find((item) => item.type === "draft" && item.draftID === current.draftID)

      if (tab?.type !== "draft") return

      const ctx = global.serverCtx(tab.server)

      if (!ctx) return

      const composer = tabs.stateValue<ComposerState>(tab, "prompt")?.model.current()

      return {
        ctx,
        directory: tab.directory,
        key: composer ? { providerID: composer.providerID, modelID: composer.modelID } : undefined,
      }
    }

    // Home and the settings screens have no composer: show the account for the server and project they point at.
    const home = layout.home.selection()

    const conn =
      global.servers.list().find((item) => ServerConnection.key(item) === home.server) ?? global.servers.list()[0]

    const ctx = conn && global.serverCtx(ServerConnection.key(conn))

    if (!ctx) return

    const project =
      ctx.projects.list().find((item) => item.worktree === home.directory) ??
      ctx.projects.last() ??
      ctx.projects.list()[0]

    if (!project) return

    return { ctx, directory: project.worktree }
  })

  const limits = createMemo(() => {
    const value = target()

    if (!value) return

    return value.ctx.data.location.usage.limits({ directory: value.directory })
  })

  const model = createMemo<(CurrentModel & { readonly free: boolean }) | undefined>(() => {
    const value = target()
    const key = value?.key

    if (!value || !key) return

    const info = value.ctx.data.location.model
      .list({ directory: value.directory })
      ?.find((item) => item.id === key.modelID && item.providerID === key.providerID)

    const cost = info?.cost.find((item) => item.tier === undefined) ?? info?.cost[0]

    return {
      providerID: key.providerID,
      modelID: key.modelID,
      name: info?.name ?? key.modelID,
      free: info ? isFreeModel({ provider: { id: info.providerID }, cost: { input: cost?.input ?? 0 } }) : false,
    }
  })

  const view = createMemo(() => {
    const info = limits()

    if (!info) return

    return usageView(info, { model: model() })
  })

  // Load the catalog and the account's limits once per location. The Usage dialog refreshes them when it opens.
  createEffect(() => {
    const value = target()

    if (!value || value.ctx.sdk.connection.status() !== "connected") return

    const ref = { directory: value.directory }

    if (value.ctx.data.location.usage.limits(ref) === undefined)
      void value.ctx.data.location.usage.sync(ref).catch(() => undefined)

    if (value.ctx.data.location.model.list(ref) === undefined)
      void value.ctx.data.location.model.sync(ref).catch(() => undefined)
  })

  // Spend moves as chats run, so refresh the account every five minutes; opening the dialog refreshes it too.
  onMount(() => {
    const timer = setInterval(() => {
      const value = target()

      if (!value || value.ctx.sdk.connection.status() !== "connected") return

      const ref = { directory: value.directory }
      value.ctx.data.location.usage.invalidate(ref)
      void value.ctx.data.location.usage.sync(ref).catch(() => undefined)
    }, 300_000)

    onCleanup(() => clearInterval(timer))
  })

  const label = createMemo(() => {
    const info = limits()

    if (info === undefined) return

    if (info === null) return language.t("usage.bar.signedOut")

    const current = view()

    if (!current) return

    if (current.callout)
      return language.t(current.callout.kind === "credits" ? "usage.bar.credits" : "usage.budget.reached")

    // A per-model budget only pauses the models it covers, so it blocks this one only when its note names the model.
    if (current.budgets.some((row) => row.reached && row.notes.some((note) => note.kind === "current-model")))
      return language.t("usage.budget.reached")

    if (current.go) {
      const tightest = current.go.reduce((most, row) => (row.percent > most.percent ? row : most))

      return language.t("usage.bar.go", { percent: Math.round(tightest.percent) })
    }

    const budget = current.budgets[0]

    if (!budget) return language.t("usage.bar.free")

    return budget.reached
      ? language.t("usage.budget.reached")
      : language.t("usage.budget.left", { amount: format.money(budget.left) })
  })

  const title = createMemo(() => {
    const info = limits()
    const workspace = (info && info.workspace.name) || language.t("usage.workspace.fallback")

    return language.t("usage.bar.title", { workspace })
  })

  const open = async () => {
    const value = target()

    if (!value) return

    const current = model()
    const currentRoute = route()
    const { DialogUsage } = await import("@/usage/dialog")

    void dialog.show(() => (
      <DialogUsage
        data={value.ctx.data}
        location={{ directory: value.directory }}
        model={current && { providerID: current.providerID, modelID: current.modelID, name: current.name }}
        onSwitchModel={
          currentRoute.type === "session" || currentRoute.type === "draft"
            ? () => void command.trigger("model.choose")
            : undefined
        }
      />
    ))
  }

  return (
    <Show when={model() || label()}>
      <button
        type="button"
        class="flex min-w-0 max-w-[320px] items-center gap-1.5 rounded-md bg-v2-background-bg-layer-02 px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover"
        title={title()}
        onClick={() => void open()}
      >
        <Show when={model()}>
          {(current) => (
            <span class="min-w-0 truncate text-v2-text-text-base" title={current().name}>
              {current().name}
            </span>
          )}
        </Show>
        <Show when={model()?.free}>
          <Badge variant="subtle" class="shrink-0">
            {language.t("model.tag.free")}
          </Badge>
        </Show>
        <Show when={model() && label()}>
          <span class="shrink-0 text-v2-text-text-faint">·</span>
        </Show>
        <Show when={label()}>
          {(text) => <span class="shrink-0 tabular-nums text-v2-text-text-faint">{text()}</span>}
        </Show>
      </button>
    </Show>
  )
}

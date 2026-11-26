import type { UsageLimitsBudget, UsageLimitsInfo } from "@opencode/client/promise"
import { createMemoryHistory, MemoryRouter } from "@solidjs/router"
import { onMount } from "solid-js"
import type { PromptModel } from "@/composer/schema"
import { DialogStoryRuntime, STORY_DIRECTORY, STORY_SERVER } from "@/components-lab/dialog-story-runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { InfiniteUsage } from "./infinite-usage"

const DRAFT_ID = "story-infinite-usage"

const resetsAt = Date.UTC(2026, 11, 1)

const hour = 3_600_000

const opus: PromptModel = { providerID: "opencode", modelID: "claude-opus-5-5" }

const budget = (input: Partial<UsageLimitsBudget> & Pick<UsageLimitsBudget, "id">): UsageLimitsBudget => ({
  limit: 150,
  spent: 0,
  scope: "each",
  per: "set",
  coverage: "all",
  models: [],
  vendors: [],
  picked: false,
  shared: false,
  resetsAt,
  ...input,
})

const anthropic = (spent: number) =>
  budget({
    id: "anthropic",
    coverage: "models",
    vendors: ["Anthropic"],
    models: [{ ...opus, name: "Claude Opus 5.5" }],
    spent,
  })

const info = (budgets: UsageLimitsBudget[], go = false): UsageLimitsInfo => ({
  workspace: { id: "wrk_story", name: "Personal", usageURL: "https://opencode.ai/wrk_story/activity/overview" },
  go: go
    ? {
        rolling: { percent: 42, limited: false, resetsAt: Date.now() + 3 * hour },
        weekly: { percent: 18, limited: false, resetsAt: Date.now() + 100 * hour },
        monthly: { percent: 7, limited: false, resetsAt: Date.now() + 500 * hour },
      }
    : undefined,
  budgets,
})

function BarStory(props: { model?: PromptModel }) {
  const tabs = useTabs()
  const history = createMemoryHistory()

  history.set({ value: `/new-session?draftId=${DRAFT_ID}`, replace: true, scroll: false })

  // The bar reads the active model from the draft's composer, so the story opens a real draft tab.
  onMount(() => {
    void tabs.newDraft(
      { draftID: DRAFT_ID, server: ServerConnection.key(STORY_SERVER), directory: STORY_DIRECTORY },
      undefined,
      props.model,
    )
  })

  return (
    <MemoryRouter history={history}>
      <div class="flex min-h-[320px] items-end">
        <div class="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-v2-border-border-muted bg-v2-background-bg-deep px-3 py-1.5 text-12-regular text-v2-text-text-muted">
          <span class="ms-auto truncate text-v2-text-text-faint">203.0.113.42 · WARP</span>
          <InfiniteUsage />
        </div>
      </div>
    </MemoryRouter>
  )
}

function Story(props: { usage: UsageLimitsInfo | null; model?: PromptModel }) {
  return (
    <DialogStoryRuntime usage={props.usage}>
      <BarStory model={props.model} />
    </DialogStoryRuntime>
  )
}

export default {
  title: "App/Shell/Infinite usage",
  id: "app-infinite-usage",
  parameters: {
    docs: {
      description: {
        component: "The active model and account usage at the end of the Infinite bar, read from a draft tab.",
      },
    },
  },
}

export const GoAllowance = { render: () => <Story usage={info([], true)} model={opus} /> }

export const BudgetLeft = { render: () => <Story usage={info([anthropic(123.14)])} model={opus} /> }

export const FreeModel = { render: () => <Story usage={info([])} model={{ providerID: "opencode", modelID: "big-pickle" }} /> }

export const BudgetReached = {
  render: () => <Story usage={info([budget({ id: "all", limit: 20, spent: 20 })])} model={opus} />,
}

export const SignedOut = { render: () => <Story usage={null} model={opus} /> }

export const LongModelName = {
  render: () => (
    <Story
      usage={info([anthropic(123.14)])}
      model={{ providerID: "opencode", modelID: "claude-opus-5-5-experimental-preview-long-name" }}
    />
  ),
}

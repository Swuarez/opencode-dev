import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AIError, ContentPolicyError } from "@opencode/ai/effect"
import { ModelRetry } from "../src/model-retry"

// A content filter that fires before any output is retried on a flat half-second gap, not on the
// general 2/4/8/10s schedule: the attempt itself already costs the model's thinking time, so a
// long backoff on top is most of the wait the user sees. These pin the gap and the budget.
const contentFilter = (message = "Provider blocked the response") =>
  new AIError({ reason: new ContentPolicyError({ message }) })

const decide = (cause: AIError, retry = true) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const policy = yield* ModelRetry.policy
      return yield* policy({ cause, retry })
    }),
  )

describe("content-filter retry budget", () => {
  test("waits half a second, not the general two-second first gap", async () => {
    const decision = await decide(contentFilter())

    expect(decision?.delay).toBe(500)
    expect(decision?.retry).toBe(true)
  })

  test("keeps the flat gap on every attempt", async () => {
    const policy = await Effect.runPromise(Effect.gen(function* () {
      return yield* ModelRetry.policy
    }))

    const delays: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const decision = await Effect.runPromise(policy({ cause: contentFilter(), retry: true }))
      if (!decision) break
      delays.push(decision.delay)
    }

    expect(delays).toEqual([500, 500, 500, 500, 500])
  })

  test("gives up after six attempts so a real refusal does not hang the turn", async () => {
    const policy = await Effect.runPromise(Effect.gen(function* () {
      return yield* ModelRetry.policy
    }))

    const decisions: Array<{ attempt: number; retry: boolean } | undefined> = []
    for (let attempt = 0; attempt < 8; attempt++) {
      const decision = await Effect.runPromise(policy({ cause: contentFilter(), retry: true }))
      decisions.push(decision === undefined ? undefined : { attempt: decision.attempt, retry: decision.retry })
      if (decision === undefined) break
    }

    // 1 initial attempt + 5 retries.
    const retried = decisions.filter((decision) => decision?.retry === true)
    expect(retried).toHaveLength(5)
  })

  test("a provider that refuses outright is not retried at all", async () => {
    const decision = await decide(contentFilter(), false)

    expect(decision?.retry).toBe(false)
  })
})

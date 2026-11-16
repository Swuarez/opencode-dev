export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable as providerRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

// OpenCode Infinite: with Auto-rotate on, the desktop app starts the service with this variable and changes the exit IP
// as soon as it sees a retry scheduled for the free allowance. The step then waits and resends on the new IP instead
// of failing, so the chat needs no "continue". Without the variable the free limit ends the step as before.
const freeRetry = process.env.OPENCODE_INFINITE_FREE_RETRY === "1"
const FREE_RETRY_DELAY_MS = 1_500

/** The daily free allowance of OpenCode Zen ran out (see toSessionError). */
export const isFreeLimit = (error: AIError) =>
  error.reason._tag === "QuotaExceeded" && error.reason.body?.includes("FreeUsageLimitError") === true

export const isRetryable = (error: AIError) => providerRetryable(error) || (freeRetry && isFreeLimit(error))

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy
    return (input: Input) =>
      Effect.gen(function* () {
        const next = yield* decide(input)
        if (!next) return { retry: false as const }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        // The desktop app holds the resend at its local proxy until the new IP is up, so the free limit needs no
        // growing back-off: a short fixed wait lets the IP change start first, then the resend goes out on it.
        const delay = freeRetry && isFreeLimit(input.cause) ? FREE_RETRY_DELAY_MS : normalized
        return { retry: true as const, attempt: next.attempt, delay }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })

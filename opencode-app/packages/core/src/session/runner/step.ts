export * as SessionStep from "./step.js"

import {
  AIError,
  ContentPolicyError,
  InvalidProviderOutputError,
  LLMClient,
  TransportError,
  isContextOverflowFailure,
  type ToolCall,
} from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{  Completed: { readonly needsContinuation: boolean }
  Retry: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
    /** The attempt already published output, so the retry writes into a new assistant message instead of appending. */
    readonly fresh?: boolean
  }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
  }
  RecoverFull: {}
  Compacted: {}
  OutputLimit: { readonly needsContinuation: boolean }
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  /** Set when this attempt runs because an earlier one in the step scheduled a retry. */
  readonly retryAttempt?: number
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    // The start snapshot only has to exist before local tools run, which cannot happen before Step.Started,
    // so it is captured while the provider request is in flight instead of delaying it.
    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)
    const started = yield* Clock.currentTimeMillis
    let firstOutputAt: number | undefined
    yield* Effect.annotateCurrentSpan({
      "gen_ai.provider.name": input.model.ref.providerID,
      "gen_ai.request.model": input.model.ref.id,
      ...(input.retryAttempt === undefined ? {} : { "opencode.retry.attempt": input.retryAttempt }),
    })
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      pendingSnapshot: Fiber.join(pendingStartSnapshot),
      started,
    })
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (publisher.record().providerFailed) return
          // Wait here, where cancellation still works, rather than inside the uninterruptible publish.
          if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
          yield* publisher.publish(event)
          if (firstOutputAt === undefined && publisher.record().outputStarted)
            firstOutputAt = yield* Clock.currentTimeMillis
          if (event.type !== "tool-call" || event.providerExecuted) return
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) =>
              restore(executeTool(event)).pipe(
                Effect.flatMap(toolOutput.truncate),
                Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
                Effect.catchTag("Tool.Error", (error) =>
                  publisher.failTool(event.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
                ),
              ),
            ).pipe(Effect.forkScoped),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // A shared lane can accept a request, open the stream, and then send nothing for tens of seconds:
    // DeepAI's queue does exactly that. There is only one budget, because nothing on the wire distinguishes the two
    // cases: a lane that is prefilling a 72k-character guide and a lane that has swallowed the request both open the
    // stream and stay quiet. Measured on the real lane, a 95k-character prompt takes 3–32 s to its first token (p50 ~20 s),
    // so the budget has to clear that whole tail or it turns working turns into failures — cutting a thinking turn on a
    // 4 s budget was exactly that. Nothing on the wire distinguishes prefill from a held slot before the first token, so
    // one budget sized above the slowest measured pass is the honest choice; a refused request is recovered by the
    // content-filter retry instead.
    //
    // The stream runs as a daemon because a pending body read cannot be interrupted — awaiting it
    // would hold the turn until the lane or the socket gives up — so the fiber is abandoned instead,
    // with the publisher closed so nothing it emits later can land in the retry.
    const firstOutputTimeout = input.model.firstOutputTimeout
    const guarded =
      firstOutputTimeout === undefined || firstOutputTimeout === false
        ? providerStream
        : Effect.gen(function* () {
            const stream = yield* Effect.forkDetach(providerStream)
            // `Effect.race` returns the first *success*, and waits when a branch fails, so both
            // branches succeed here and the decision is made from which one won. A failing deadline
            // would have held the turn until the stream itself failed, which is the opposite of a guard.
            const armedAt = publisher.lastActivity()
            const silent = Effect.gen(function* () {
              while (true) {
                const now = yield* Clock.currentTimeMillis
                // A turn whose text or reasoning is moving keeps `lastActivity` fresh and is never cut.
                if (publisher.lastActivity() === armedAt && now - armedAt >= firstOutputTimeout) return undefined
                yield* Effect.sleep(Math.min(250, firstOutputTimeout))
              }
            })
            const joined = yield* Effect.race(Fiber.join(stream).pipe(Effect.exit), silent)
            if (joined !== undefined) {
              if (Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
              return joined.value
            }
            publisher.abandon()
            return yield* Effect.fail(
              new AIError({
                reason: new TransportError({
                  message: `The provider produced nothing for ${firstOutputTimeout}ms; trying again`,
                  transport: "http",
                  operation: "read",
                  code: "Stalled",
                  phase: "receive",
                }),
              }),
            )
          })

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(guarded).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        // Cancelled before the start snapshot existed: record nothing, as when the capture preceded the request.
        if (
          Exit.isFailure(stream) &&
          streamInterrupted &&
          !publisher.hasStarted() &&
          !pendingStartSnapshot.pollUnsafe()
        )
          return yield* Effect.failCause(stream.cause)
        if (publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(streamFailure) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: streamFailure?.message,
          })
          return Outcome.Compacted()
        }

        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        // A gateway can close a response with content-filter before emitting a single token: DeepAI's
        // upstream does exactly that, intermittently, on requests it answers fine a moment later. Nothing
        // was produced, so repeating the request cannot duplicate output, and the block is transient
        // rather than a refusal. That is the only content-filter shape worth retrying — one that arrives
        // after output started is a decision about text that already exists and stays fatal.
        const blockedBeforeOutput =
          recorded.providerFailed && recorded.finish?.finish === "content-filter" && !recorded.outputStarted
        // A filter that lands *during* a stream is the same transient gateway flap, not a verdict on the whole turn: the
        // real lane cuts a keylogger answer mid-fence and serves the identical request complete a moment later. It is
        // repeatable only when no tool call was opened — repeating one would run the tool twice — and because this
        // attempt already published text, the retry has to write into a fresh assistant message (see `fresh` below).
        const blockedMidStream =
          input.model.retryBlockedStream === true &&
          recorded.providerFailed &&
          recorded.finish?.finish === "content-filter" &&
          recorded.outputStarted &&
          !publisher.hasToolCalls()
        const blocked = blockedBeforeOutput || blockedMidStream
        const retryFailure =
          llmFailure ??
          (blocked ? new AIError({ reason: new ContentPolicyError({ message: "Provider blocked the response" }) }) : undefined)
        const retryError = llmError ?? (blocked ? recorded.failure : undefined)
        const tokens = recorded.finish?.usage
        yield* Effect.annotateCurrentSpan({
          ...(firstOutputAt === undefined ? {} : { "opencode.llm.first_output_ms": firstOutputAt - started }),
          ...(recorded.finish === undefined ? {} : { "gen_ai.response.finish_reasons": [recorded.finish.finish] }),
          ...(tokens?.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": tokens.inputTokens }),
          ...(tokens?.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": tokens.outputTokens }),
          ...(tokens?.cacheReadInputTokens === undefined
            ? {}
            : { "gen_ai.usage.cache_read.input_tokens": tokens.cacheReadInputTokens }),
          ...(tokens?.cacheWriteInputTokens === undefined
            ? {}
            : { "gen_ai.usage.cache_creation.input_tokens": tokens.cacheWriteInputTokens }),
          ...(llmFailure === undefined ? {} : { "error.type": llmFailure.reason._tag }),
        })
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          retryFailure && retryError && !isContextOverflowFailure(retryFailure)
            ? yield* restore(
                input.retry(
                  retryFailure,
                  retryError,
                  blocked ||
                    SessionRunnerRetry.isRetryable(retryFailure) ||
                    (recorded.outputStarted && isInterruptedStream(retryFailure)),
                ),
              )
            : undefined
        if (retryFailure && retryError && retry?.retry && (!recorded.outputStarted || blockedMidStream)) {
          if (blockedMidStream) {
            // Close the partial attempt where it stands so it is never continued, then hand the retry a new message.
            yield* publisher.failAssistant(retryError)
            return Outcome.Retry({ error: retryError, decision: retry, fresh: true })
          }
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: retryError, decision: retry })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // Parsers may leave unfinished calls without an execution event.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
          yield* publisher.failIncompleteTools()
        }

        const record = publisher.record()
        if (record.finish || record.failure) {
          const startSnapshot = yield* Fiber.join(pendingStartSnapshot)
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const usage = record.finish ? SessionUsage.record(record.finish.usage, input.model.cost) : undefined
          if (usage) yield* Effect.annotateCurrentSpan("opencode.usage.cost_usd", usage.cost)
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              native: record.finish.native,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
        if (record.finish?.finish === "length") return Outcome.OutputLimit({ needsContinuation })
        return Outcome.Completed({ needsContinuation })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}

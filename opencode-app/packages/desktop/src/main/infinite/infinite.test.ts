import { expect, mock, test } from "bun:test"

// infinite.ts reads Electron's paths at import; the limit parser under test needs none of it.
// The mock also sets `default`: bun applies a module mock to the whole test run, so other files that import electron's default would break.
const electron = { app: { getPath: () => ".", once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { decide, limitRetry, limitSession } = await import("./infinite")

const idle = { now: 100_000, last: 0, streak: 0, locked: false, pending: false }

test("a limit rotates at once when nothing is running", () => {
  expect(decide(idle)).toEqual({ run: true })
})

test("a chat that arrives during a rotation or inside the 3 s window is retried, never dropped", () => {
  expect(decide({ ...idle, locked: true, pending: true })).toEqual({ run: false, retryMs: 2_000 })
  expect(decide({ ...idle, locked: true })).toEqual({ run: false, retryMs: undefined })
  expect(decide({ ...idle, last: 99_000, pending: true })).toEqual({ run: false, retryMs: 2_000 })
  expect(decide({ ...idle, last: 99_000 })).toEqual({ run: false, retryMs: undefined })
})

test("ten rotations in a row pause, and waiting chats come back after 3 minutes", () => {
  expect(decide({ ...idle, streak: 10, pending: true })).toEqual({ run: false, pause: true, retryMs: 180_000 })
  expect(decide({ ...idle, streak: 9 })).toEqual({ run: true })
})

const block = (event: unknown) => `event: message\ndata: ${JSON.stringify(event)}`
const failed = (type: string, created = Date.now()) => ({
  type: "session.step.failed",
  created,
  data: { sessionID: "ses_1", error: { type, message: "x" } },
})

test("only the free limit of a fresh event asks for a rotation", () => {
  expect(limitSession(block(failed("provider.free-limit")))).toBe("ses_1")
  // No false alarms: other provider errors, replayed events, other event types and text that only mentions a limit.
  for (const type of ["provider.rate-limit", "provider.go-limit", "provider.quota", "provider.transport", "provider.auth"])
    expect(limitSession(block(failed(type)))).toBeUndefined()
  expect(limitSession(block(failed("provider.free-limit", Date.now() - 120_000)))).toBeUndefined()
  expect(limitSession(block({ ...failed("provider.free-limit"), type: "session.step.finished" }))).toBeUndefined()
  expect(limitSession(block({ type: "message.part", data: { text: "Free usage limit reached. provider.free-limit" } }))).toBeUndefined()
  expect(limitSession("data: not json")).toBeUndefined()
})

// The chat retrying a spent free allowance asks only for a new IP; a failed step is still the "continue" path.
test("a retry scheduled for the free limit asks for an IP change, nothing else does", () => {
  const retry = (type: string, created = Date.now()) => ({ ...failed(type, created), type: "session.retry.scheduled" })
  expect(limitRetry(block(retry("provider.free-limit")))).toBe(true)
  expect(limitRetry(block(retry("provider.transport")))).toBe(false)
  expect(limitRetry(block(retry("provider.free-limit", Date.now() - 120_000)))).toBe(false)
  expect(limitRetry(block(failed("provider.free-limit")))).toBe(false)
  expect(limitSession(block(retry("provider.free-limit")))).toBeUndefined()
  expect(limitRetry("data: not json")).toBe(false)
})

import { expect, mock, test } from "bun:test"

// infinite.ts reads Electron's paths at import; the limit parser under test needs none of it.
mock.module("electron", () => ({ app: { getPath: () => ".", once: () => undefined } }))

const { limitSession } = await import("./infinite")

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

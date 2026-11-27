import { expect, mock, test } from "bun:test"

// infinite.ts reads Electron's paths at import; the limit parser under test needs none of it.
// The mock also sets `default`: bun applies a module mock to the whole test run, so other files that import electron's default would break.
const electron = { app: { getPath: () => ".", once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { decide, limitRetry, limitSession, resumeSession, rotationBudget, sessionRunning, waitForRunning } =
  await import("./infinite")
const { SidecarCredentials } = await import("../service/sidecar-credentials")

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

test("auto-rotate pauses after five IP changes in ten minutes", () => {
  const now = 1_000_000
  const budget = (rotations: number[], pausedUntil = 0) => rotationBudget({ now, rotations, pausedUntil })
  expect(budget([])).toMatchObject({ run: true })
  expect(budget([now - 1, now - 2, now - 3, now - 4])).toMatchObject({ run: true })
  expect(budget([now - 1, now - 2, now - 3, now - 4, now - 5])).toMatchObject({
    run: false,
    retryMs: 300_000,
    pausedUntil: now + 300_000,
    rotations: [],
  })
  // A change older than the window does not count.
  expect(budget([now - 600_001])).toMatchObject({ run: true })
  // The pause ends when its time is up.
  expect(budget([], now - 1)).toMatchObject({ run: true })
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

/** A local stand-in for the server's active and prompt routes; `prompts` counts the "continue" messages it took. */
function server(handler: (request: Request, url: URL, state: { prompts: number }) => Response | Promise<Response>) {
  const state = { prompts: 0 }
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler(request, new URL(request.url), state),
  })
  const previous = SidecarCredentials.get()
  SidecarCredentials.set({ url: `http://127.0.0.1:${instance.port}`, password: "test" })
  return {
    prompts: () => state.prompts,
    async close() {
      await instance.stop(true)
      SidecarCredentials.set(previous ?? { url: "http://127.0.0.1:1", password: null })
    },
  }
}

const active = (sessionID: string) => Response.json({ data: { [sessionID]: { type: "running" } } })

test("a chat the server already runs gets no second continue", async () => {
  const fixture = server((_request, url, state) => {
    if (url.pathname === "/api/session/active") return active("ses_running")
    if (url.pathname === "/api/session/ses_running/prompt") {
      state.prompts++
      return Response.json({ data: { id: "in_1" } })
    }
    return new Response("not found", { status: 404 })
  })
  try {
    expect(await sessionRunning("ses_running")).toBe(true)
    expect(await resumeSession("ses_running")).toBe("running")
    expect(fixture.prompts()).toBe(0)
  } finally {
    await fixture.close()
  }
})

test("an idle chat gets exactly one continue", async () => {
  let sent: { text?: string; auth?: string | null } | undefined
  const fixture = server(async (request, url, state) => {
    if (url.pathname === "/api/session/active") return Response.json({ data: {} })
    if (url.pathname === "/api/session/ses_idle/prompt") {
      state.prompts++
      sent = { text: (await request.json()).text, auth: request.headers.get("authorization") }
      return Response.json({ data: { id: "in_1" } })
    }
    return new Response("not found", { status: 404 })
  })
  try {
    expect(await resumeSession("ses_idle")).toBe("sent")
    expect(fixture.prompts()).toBe(1)
    expect(sent?.text).toBe("continue")
    expect(sent?.auth?.startsWith("Basic ")).toBe(true)
  } finally {
    await fixture.close()
  }
})

test("a failed continue is not sent again once the chat resumes", async () => {
  const fixture = server((_request, url, state) => {
    if (url.pathname === "/api/session/active")
      return Response.json({ data: state.prompts > 0 ? { ses_retry: { type: "running" } } : {} })
    if (url.pathname === "/api/session/ses_retry/prompt") {
      state.prompts++
      return new Response("busy", { status: 500 })
    }
    return new Response("not found", { status: 404 })
  })
  try {
    expect(await resumeSession("ses_retry")).toBe("running")
    expect(fixture.prompts()).toBe(1)
  } finally {
    await fixture.close()
  }
})

test("after a restart the reset waits for a resumed chat instead of prompting it", async () => {
  let polls = 0
  const fixture = server((_request, url, state) => {
    if (url.pathname === "/api/session/active") {
      polls++
      return polls > 2 ? active("ses_restart") : Response.json({ data: {} })
    }
    if (url.pathname === "/api/session/ses_restart/prompt") {
      state.prompts++
      return Response.json({ data: { id: "in_1" } })
    }
    return new Response("not found", { status: 404 })
  })
  try {
    expect(await waitForRunning("ses_restart")).toBe(true)
    expect(fixture.prompts()).toBe(0)
  } finally {
    await fixture.close()
  }
})

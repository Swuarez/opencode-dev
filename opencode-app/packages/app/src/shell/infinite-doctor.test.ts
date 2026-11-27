import { expect, test } from "bun:test"
import { fixConnection } from "./infinite-doctor"
import type { Platform } from "@/runtime/platform/platform"

type Infinite = NonNullable<Platform["infinite"]>

// A computer described by what it has; setMode answers ok only for the modes in `works`, and every call is recorded.
function computer(input: {
  mode?: string
  warp?: boolean
  socks?: string
  custom?: string
  works: string[]
  direct?: boolean
  busy?: boolean
  busyMode?: string
}) {
  const tried: string[] = []
  const infinite = {
    getMode: async () => input.mode ?? "NONE",
    checkIp: async () =>
      input.busy
        ? { ok: false, message: "changing the IP…", busy: true }
        : input.direct
          ? { ok: true, ip: "1.1.1.1", message: "" }
          : { ok: false, message: "down" },
    getOptions: async () => ({ socks: input.socks ?? "", custom: input.custom ?? "" }),
    route64Status: async () => ({ imported: false, up: false }),
    toolPlan: async () => ({ installed: input.warp === true }),
    setMode: async (mode: string) => {
      tried.push(mode)
      if (mode === input.busyMode) return { ok: false, message: "Another action is still running.", busy: true }
      return input.works.includes(mode) ? { ok: true, message: "ok", ip: "9.9.9.9" } : { ok: false, message: "no" }
    },
  } as unknown as Infinite
  return { infinite, tried }
}

test("a reset in progress is not a dead connection", async () => {
  const pc = computer({ mode: "WARP", warp: true, works: [], busy: true })
  const outcome = await fixConnection(pc.infinite, () => undefined)
  expect(outcome).toMatchObject({ ok: false, busy: true })
  expect(pc.tried).toEqual([])
})

test("a busy mode stops the doctor instead of trying the rest", async () => {
  const pc = computer({ warp: true, works: ["TOR"], busyMode: "WARP" })
  const outcome = await fixConnection(pc.infinite, () => undefined, true)
  expect(outcome).toMatchObject({ ok: false, busy: true })
  expect(pc.tried).toEqual(["WARP"])
})

test("an already working connection is left alone", async () => {
  const pc = computer({ mode: "WARP", direct: true, works: [] })
  const outcome = await fixConnection(pc.infinite, () => undefined)
  expect(outcome).toMatchObject({ ok: true, mode: "WARP", ip: "1.1.1.1" })
  expect(pc.tried).toEqual([])
})

test("from scratch: WARP first, then Tor, and direct as the last resort", async () => {
  const warp = computer({ warp: true, works: ["WARP"] })
  expect((await fixConnection(warp.infinite, () => undefined, true)).mode).toBe("WARP")

  const noWarp = computer({ warp: false, works: ["TOR"] })
  expect((await fixConnection(noWarp.infinite, () => undefined, true)).mode).toBe("TOR")
  expect(noWarp.tried).toEqual(["TOR"])

  const bad = computer({ warp: true, works: ["NONE"] })
  expect((await fixConnection(bad.infinite, () => undefined, true)).mode).toBe("NONE")
  expect(bad.tried).toEqual(["WARP", "TOR", "NONE"])
})

test("a dead current mode is retried first, and the user's own lists come before Tor", async () => {
  const pc = computer({ mode: "SOCKS", socks: "h:1", custom: "p:1", warp: true, works: ["PROXY"] })
  const outcome = await fixConnection(pc.infinite, () => undefined)
  expect(outcome).toMatchObject({ ok: true, mode: "PROXY" })
  expect(pc.tried).toEqual(["SOCKS", "WARP", "PROXY"])
})

test("when nothing connects, the outcome says why", async () => {
  const pc = computer({ works: [] })
  const outcome = await fixConnection(pc.infinite, () => undefined, true)
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain("Tor: no")
})

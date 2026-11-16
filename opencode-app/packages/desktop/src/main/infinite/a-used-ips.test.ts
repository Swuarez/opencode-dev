import { expect, mock, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// The settings are read from a temp folder written before the import, so the load path itself is under test.
const userData = mkdtempSync(path.join(os.tmpdir(), "oc-used-ips-"))
writeFileSync(
  path.join(userData, "infinite.json"),
  JSON.stringify({
    mode: "WARP",
    auto: false,
    country: "",
    fast: true,
    rotateUrl: "",
    vpnLocations: "",
    socks: "",
    burned: ["203.0.113.7", "198.51.100.4", 42],
    burnedAt: Date.now() - 60_000,
    chain: "tor, proxy, TOR, nope, warp",
  }),
)
const electron = { app: { getPath: () => userData, once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const I = await import("./infinite")

test("used IPs survive a restart and only strings are kept", () => {
  expect(I.getOptions().burned).toBe(2)
})

test("a failover chain is normalised: known modes only, deduplicated, without the mode already in use", async () => {
  await I.setMode("WARP")
  await I.setOptions({ ...I.getOptions(), chain: "tor, proxy, TOR, nope, warp" })
  expect(I.getOptions().chain).toBe("TOR,PROXY")
})

test("the used-IP window expires after a day and never before", () => {
  const hour = 60 * 60 * 1000
  expect(I.burnedExpired(0)).toBe(false)
  expect(I.burnedExpired(Date.now() - hour)).toBe(false)
  expect(I.burnedExpired(Date.now() - 23 * hour)).toBe(false)
  expect(I.burnedExpired(Date.now() - 25 * hour)).toBe(true)
})

test("forgetting the used IPs empties the list so a known good one can come back", async () => {
  expect((await I.clearBurned()).ok).toBe(true)
  expect(I.getOptions().burned).toBe(0)
  // Clearing also ends the window, so a new one only starts with the next used IP.
  expect(I.burnedExpired(Date.now() - 200 * 60 * 60 * 1000)).toBe(true)
})

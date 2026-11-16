import { expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// route64 is one fixed IP: rotating must fail (so the hunt stops) and the mode must be saved as ROUTE64.
// The settings go to a temp folder, never into the package.
const userData = mkdtempSync(path.join(os.tmpdir(), "oc-route64-"))
const electron = { app: { getPath: () => userData, once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const I = await import("./infinite")

test("route64 cannot rotate: the hunt gets a failure instead of the same IP", async () => {
  const result = await I.rotate("ROUTE64")
  expect(result.ok).toBe(false)
  expect(result.message).toContain("fixed IP")
})

test("route64 is kept as a mode and never falls back to None", async () => {
  await I.setMode("ROUTE64")
  expect(I.getMode()).toBe("ROUTE64")
  // No proxy is set for route64: the tunnel carries the traffic, not the service.
  expect(I.proxyEnv()).toEqual({})
  await I.setMode("NONE")
})

import { expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Rotating endpoints are proxies in the list; the change-IP URL is optional. Mullvad and Windscribe are not installed here.
const userData = mkdtempSync(path.join(os.tmpdir(), "oc-rotating-"))
const electron = { app: { getPath: () => userData, once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const I = await import("./infinite")
const V = await import("./vpn-clients")

test("a rotating endpoint is kept as a proxy in the list", async () => {
  const options = I.getOptions()
  await I.setOptions({ ...options, custom: "127.0.0.1:9" })
  expect(I.getOptions().custom).toBe("http://127.0.0.1:9")
  await I.setOptions({ ...options, custom: "" })
})

test("provider lists in host:port:user:password form are kept, for HTTP and SOCKS5 alike", async () => {
  const options = I.getOptions()
  await I.setOptions({ ...options, custom: "gate.example:80:user-1:pa:ss\nuser:pw@10.0.0.1:3128", socks: "gate.example:1080:u:p" })
  expect(I.getOptions().custom).toBe("http://user-1:pa%3Ass@gate.example:80\nhttp://user:pw@10.0.0.1:3128")
  expect(I.getOptions().socks).toBe("socks5://u:p@gate.example:1080")
  expect(I.parseSocks("gate.example:1080:u:p")).toEqual({ host: "gate.example", port: 1080, user: "u", pass: "p" })
  await I.setOptions({ ...options, custom: "", socks: "" })
})

test("an invalid change-IP URL is dropped, a valid one is kept", async () => {
  const options = I.getOptions()
  await I.setOptions({ ...options, rotateUrl: "not a url" })
  expect(I.getOptions().rotateUrl).toBe("")
  await I.setOptions({ ...options, rotateUrl: "https://provider.example/rotate" })
  expect(I.getOptions().rotateUrl).toBe("https://provider.example/rotate")
  await I.setOptions({ ...options, rotateUrl: "" })
})

test("pickLocation never returns the location in use while another exists", () => {
  for (let i = 0; i < 20; i++) expect(V.pickLocation("MULLVAD", ["se", "de"], "se")).toBe("de")
})

test("pickLocation uses Mullvad defaults and returns nothing for Windscribe without a list", () => {
  expect(V.pickLocation("MULLVAD", [])).toBeDefined()
  expect(V.pickLocation("WINDSCRIBE", [])).toBeUndefined()
})

test("a client that is not installed says so and does not run anything", async () => {
  V.setRunner(async () => {
    throw new Error("runner must not be called when the client is missing")
  })
  const up = await V.connectClient("MULLVAD", "se")
  expect(up.ok).toBe(false)
  expect(up.message).toContain("not installed")
  const down = await V.disconnectClient("WINDSCRIBE")
  expect(down.ok).toBe(true)
  V.setRunner(undefined)
})

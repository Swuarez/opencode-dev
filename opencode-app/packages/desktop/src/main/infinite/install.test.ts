import { describe, expect, test } from "bun:test"
import { install } from "./install"

// These cover only the refusal path: nothing is downloaded or installed.
describe("install guard", () => {
  test("refuses WARP without the user's confirmation", async () => {
    const result = await install("WARP", false)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("confirmation")
  })

  test("refuses WireGuard when confirmation is not exactly true", async () => {
    const result = await install("WIREGUARD", "yes" as unknown as boolean)
    expect(result.ok).toBe(false)
  })
})

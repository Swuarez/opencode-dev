import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { InfiniteRoute64Status } from "../../shared/ipc-rpc/infinite"

// The reply goes through the IPC schema: `endpoint` may be missing but never undefined, or the window sees
// "Desktop IPC handler failed". The status of a computer without a route64 config is the case that broke.
process.env.LOCALAPPDATA = mkdtempSync(path.join(os.tmpdir(), "oc-r64-status-"))
const { route64Status } = await import("./route64")

test("with no route64 config the status has no endpoint key and passes the reply schema", async () => {
  const status = await route64Status()
  expect(status.imported).toBe(false)
  expect("endpoint" in status).toBe(false)
  expect(() => Schema.encodeSync(InfiniteRoute64Status.successSchema)(status)).not.toThrow()
})

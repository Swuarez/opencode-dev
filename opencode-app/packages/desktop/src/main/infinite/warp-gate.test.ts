import { expect, mock, test } from "bun:test"
import { connect, createServer } from "node:net"

// infinite.ts reads Electron's paths at import; the door under test needs none of it.
const electron = { app: { getPath: () => "", isPackaged: false } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { warpGate } = await import("./infinite")

// WARP's port refuses connections while it re-registers; the door must hold the request and deliver it once WARP is back.
test("a request sent while the upstream refuses connections is answered when it comes back", async () => {
  const listen = 18921
  const upstream = 18922
  warpGate(listen, upstream)

  const client = connect(listen, "127.0.0.1")
  const answer = new Promise<string>((resolve) => client.once("data", (chunk) => resolve(chunk.toString())))
  client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n")

  await Bun.sleep(900) // upstream down: at least two refused attempts
  const server = createServer((socket) =>
    socket.once("data", () => socket.write("HTTP/1.1 200 Connection established\r\n\r\n")),
  ).listen(upstream, "127.0.0.1")

  expect(await answer).toStartWith("HTTP/1.1 200")
  client.destroy()
  server.close()
})

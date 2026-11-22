import { expect, mock, test } from "bun:test"
import { connect, createServer } from "node:net"

// infinite.ts reads Electron's paths at import; the door under test needs none of it.
const electron = { app: { getPath: () => "", isPackaged: false } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { proxyGate } = await import("./infinite")

// WARP's port refuses connections while it re-registers; the door must hold the request and deliver it once WARP is back.
test("a request sent while the upstream refuses connections is answered when it comes back", async () => {
  const listen = 18921
  const upstream = 18922
  proxyGate(listen, () => `http://127.0.0.1:${upstream}`)

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

// Pool mode: one door, several exits. Each new connection takes the next route, then the list wraps.
test("a pool hands each connection the next route", async () => {
  const listen = 18925
  const first = 18926
  const second = 18927
  const hits: string[] = []
  const serve = (port: number, name: string) =>
    createServer((socket) =>
      socket.once("data", () => {
        hits.push(name)
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
      }),
    ).listen(port, "127.0.0.1")
  const a = serve(first, "a")
  const b = serve(second, "b")
  proxyGate(listen, () => [`http://127.0.0.1:${first}`, `http://127.0.0.1:${second}`])
  const ask = () =>
    new Promise<void>((resolve) => {
      const client = connect(listen, "127.0.0.1")
      client.once("data", () => {
        client.destroy()
        resolve()
      })
      client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n")
    })
  await ask()
  await ask()
  await ask()
  expect(hits).toEqual(["a", "b", "a"])
  a.close()
  b.close()
})

// Proxy mode: the door follows the picked proxy per connection and passes its login, as OpenCode would have.
test("a proxy with a login gets the request with its Proxy-Authorization header", async () => {
  const listen = 18923
  const upstream = 18924
  let target = ""
  proxyGate(listen, () => target)
  const seen = new Promise<string>((resolve) =>
    createServer((socket) =>
      socket.once("data", (head) => {
        resolve(head.toString())
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
      }),
    ).listen(upstream, "127.0.0.1"),
  )
  const client = connect(listen, "127.0.0.1")
  client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
  await Bun.sleep(500) // no proxy picked yet: the request waits
  target = `http://us%40er:p%3Ass@127.0.0.1:${upstream}`
  const head = await seen
  expect(head).toStartWith("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n")
  expect(head).toContain(`Proxy-Authorization: Basic ${Buffer.from("us@er:p:ss").toString("base64")}\r\n\r\n`)
  client.destroy()
})

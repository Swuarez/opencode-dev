import { expect, mock, test } from "bun:test"

// infinite.ts reads Electron's paths at import; these helpers need none of it.
const electron = { app: { getPath: () => ".", once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { parseSocks } = await import("./infinite")

test("a bare host and port is a SOCKS5 server without credentials", () => {
  expect(parseSocks("127.0.0.1:1080")).toEqual({ host: "127.0.0.1", port: 1080 })
  expect(parseSocks(" socks5://example.test:1080 ")).toEqual({ host: "example.test", port: 1080 })
})

test("credentials are carried, percent-decoded", () => {
  expect(parseSocks("socks5://user:p%40ss@example.test:1080")).toEqual({
    host: "example.test",
    port: 1080,
    user: "user",
    pass: "p@ss",
  })
})

test("anything that is not a SOCKS server is dropped", () => {
  for (const value of ["", "http://example.test:3128", "example.test", "socks5://example.test", "socks5://:1080"])
    expect(parseSocks(value)).toBeUndefined()
})

#!/usr/bin/env node
"use strict"

// egress-rotator: an HTTP CONNECT proxy that leaves by a different source IP on every connection.
// Point OpenCode Infinite at it as a single proxy entry; the gateway rotates inside, so the client needs no list.
//
// Sources, in the order they are used:
//   SOURCE_FILE  one IPv4 or IPv6 address per line (addresses that are routed to this host)
//   SOURCE_CIDR  an IPv6 prefix routed to this host, e.g. 2001:db8:1:2::/64; a random address is picked per connection
// With both set, the two are alternated.

const crypto = require("node:crypto")
const dns = require("node:dns")
const fs = require("node:fs")
const net = require("node:net")

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8899) || 8899
const LISTEN_HOST = process.env.LISTEN_HOST || "::"
const PROXY_USER = process.env.PROXY_USER || ""
const PROXY_PASS = process.env.PROXY_PASS || ""
const SOURCE_FILE = process.env.SOURCE_FILE || ""
const SOURCE_CIDR = process.env.SOURCE_CIDR || ""
const SOURCE_TRY = Math.max(1, Number(process.env.SOURCE_TRY || 4) || 4)
const CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.CONNECT_TIMEOUT_MS || 10000) || 10000)
const ALLOW_PORTS = new Set(
  (process.env.ALLOW_PORTS || "443,80")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
)
const MAX_HEAD = 8192
const DNS_TTL_MS = 60_000
const DNS_MAX = 500

const dnsCache = new Map()

function resolve(host, family) {
  if (net.isIP(host)) return Promise.resolve(host)
  const key = `${host}|${family}`
  const hit = dnsCache.get(key)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.address)
  return dns.promises.lookup(host, { family }).then(({ address }) => {
    if (dnsCache.size >= DNS_MAX) dnsCache.clear()
    dnsCache.set(key, { address, until: Date.now() + DNS_TTL_MS })
    return address
  })
}

function ipv6ToBigInt(address) {
  const [head = "", tail] = address.split("::")
  const left = head ? head.split(":") : []
  const right = tail === undefined ? [] : tail ? tail.split(":") : []
  const fill = tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length)
  const groups = [...left, ...Array(fill).fill("0"), ...right]
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n)
}

function bigIntToIpv6(value) {
  const groups = []
  for (let index = 0; index < 8; index++) groups.unshift(((value >> BigInt(index * 16)) & 0xffffn).toString(16))
  return groups.join(":")
}

function ipv6Prefix(cidr) {
  const [address, bitsText] = cidr.split("/")
  const bits = Number(bitsText)
  if (!net.isIPv6(address) || !Number.isInteger(bits) || bits < 1 || bits > 128)
    throw new Error(`SOURCE_CIDR must be an IPv6 prefix such as 2001:db8:1:2::/64, got "${cidr}"`)
  const hostBits = BigInt(128 - bits)
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n
  return { prefix: ipv6ToBigInt(address) & ~hostMask, hostMask }
}

function randomIn(prefix) {
  const bytes = crypto.randomBytes(16)
  const value = bytes.reduce((current, byte) => (current << 8n) | BigInt(byte), 0n)
  return bigIntToIpv6(prefix.prefix | (value & prefix.hostMask))
}

function loadSources() {
  if (!SOURCE_FILE) return []
  const sources = []
  for (const line of fs.readFileSync(SOURCE_FILE, "utf8").split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue
    if (net.isIP(value)) sources.push(value)
  }
  return sources
}

function makePicker() {
  const list = loadSources()
  const pickers = []
  if (list.length) {
    let cursor = 0
    pickers.push(() => list[cursor++ % list.length])
  }
  if (SOURCE_CIDR) {
    const prefix = ipv6Prefix(SOURCE_CIDR)
    pickers.push(() => randomIn(prefix))
  }
  if (!pickers.length) throw new Error("set SOURCE_FILE (one IP per line) or SOURCE_CIDR (an IPv6 prefix)")
  let cursor = 0
  return () => pickers[cursor++ % pickers.length]()
}

function constantEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function authorized(head) {
  if (!PROXY_USER) return true
  const match = /^Proxy-Authorization:\s*Basic\s+(\S+)\s*$/im.exec(head)
  if (!match) return false
  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  return constantEqual(decoded, `${PROXY_USER}:${PROXY_PASS}`)
}

function fail(socket, code, text) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`)
}

function handle(client, head) {
  const text = head.toString("latin1")
  if (!authorized(text)) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\nConnection: close\r\n\r\n')
    return
  }
  const match = /^CONNECT\s+(\S+):(\d{1,5})\s+HTTP\/1\.[01]\r\n/i.exec(text)
  if (!match) return fail(client, 405, "Method Not Allowed")
  const port = Number(match[2])
  if (!ALLOW_PORTS.has(port)) return fail(client, 403, "Forbidden")
  const host = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1]

  let attempt = 0
  const dial = () => {
    if (client.destroyed) return
    if (attempt++ >= SOURCE_TRY) return fail(client, 502, "Bad Gateway")
    const localAddress = pickSource()
    const family = net.isIPv6(localAddress) ? 6 : 4
    resolve(host, family).then(
      (address) => {
        if (client.destroyed) return
        const upstream = net.connect({ host: address, port, localAddress })
        upstream.setNoDelay(true)
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          upstream.destroy()
          dial()
        }, CONNECT_TIMEOUT_MS)
        upstream.once("error", () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          upstream.destroy()
          dial()
        })
        upstream.once("connect", () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          upstream.removeAllListeners("error")
          upstream.on("error", () => client.destroy())
          client.on("error", () => upstream.destroy())
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
          console.log(`${new Date().toISOString()} ${localAddress} -> ${address}:${port}`)
        })
      },
      () => dial(),
    )
  }
  dial()
}

const pickSource = makePicker()
const server = net.createServer((client) => {
  client.setNoDelay(true)
  client.on("error", () => client.destroy())
  let head = Buffer.alloc(0)
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk])
    if (head.length > MAX_HEAD) return fail(client, 431, "Request Header Fields Too Large")
    const end = head.indexOf("\r\n\r\n")
    if (end < 0) return
    client.removeListener("data", onData)
    client.pause()
    handle(client, head.subarray(0, end + 4))
  }
  client.on("data", onData)
})

server.on("error", (error) => {
  console.error(error.message)
  process.exit(1)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const sources = SOURCE_FILE ? `${loadSources().length} listed` : "no list"
  const prefix = SOURCE_CIDR ? SOURCE_CIDR : "no prefix"
  console.log(`egress rotator on ${LISTEN_HOST}:${LISTEN_PORT} (${sources}, ${prefix}, auth ${PROXY_USER ? "on" : "off"})`)
})

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))

// Reads a WireGuard .conf (the file route64's manager gives you) and checks it before anything uses it.
// Errors name the field, never its value: the PrivateKey must not end up in a log or a message.

export type WireGuardConf = {
  interface: { privateKey: string; address: string[]; dns?: string[] }
  peers: { publicKey: string; endpoint: string; allowedIPs: string[]; presharedKey?: string; keepalive?: number }[]
}

export type ParseResult = { ok: true; conf: WireGuardConf } | { ok: false; errors: string[] }

const KEY = /^[A-Za-z0-9+/]{43}=$/

function keyOk(value: string | undefined) {
  if (!value || !KEY.test(value)) return false
  return Buffer.from(value, "base64").length === 32
}

function endpointOk(value: string | undefined) {
  // host:port, or [v6]:port. The port must be a real port number.
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s:[\]]+):(\d{1,5})$/.exec(value ?? "")
  if (!match) return false
  const port = Number(match[2])
  return port >= 1 && port <= 65535
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export function parseWireGuardConf(text: string): ParseResult {
  const errors: string[] = []
  const sections: { name: string; fields: Map<string, string> }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const head = /^\[(Interface|Peer)\]$/i.exec(line)
    if (head) {
      sections.push({ name: head[1]!.toLowerCase(), fields: new Map() })
      continue
    }
    const pair = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line)
    const current = sections.at(-1)
    if (!pair || !current) {
      errors.push("a line is not a [Section] or Key = value")
      continue
    }
    current.fields.set(pair[1]!.toLowerCase(), pair[2]!.trim())
  }

  const iface = sections.filter((s) => s.name === "interface")
  const peers = sections.filter((s) => s.name === "peer")
  if (iface.length !== 1) errors.push("the file needs exactly one [Interface] section")
  if (peers.length < 1) errors.push("the file needs at least one [Peer] section")
  if (errors.length) return { ok: false, errors }

  const i = iface[0]!.fields
  if (!keyOk(i.get("privatekey"))) errors.push("Interface PrivateKey is missing or is not a WireGuard key")
  if (list(i.get("address")).length === 0) errors.push("Interface Address is missing")

  const parsedPeers = peers.map((p, n) => {
    const f = p.fields
    if (!keyOk(f.get("publickey"))) errors.push(`Peer ${n + 1}: PublicKey is missing or is not a WireGuard key`)
    if (!endpointOk(f.get("endpoint"))) errors.push(`Peer ${n + 1}: Endpoint must be host:port`)
    if (list(f.get("allowedips")).length === 0) errors.push(`Peer ${n + 1}: AllowedIPs is missing`)
    const keepalive = f.get("persistentkeepalive")
    return {
      publicKey: f.get("publickey") ?? "",
      endpoint: f.get("endpoint") ?? "",
      allowedIPs: list(f.get("allowedips")),
      presharedKey: f.get("presharedkey"),
      keepalive: keepalive && keepalive !== "off" ? Number(keepalive) : undefined,
    }
  })

  if (errors.length) return { ok: false, errors }
  const dns = list(i.get("dns"))
  return {
    ok: true,
    conf: {
      interface: { privateKey: i.get("privatekey")!, address: list(i.get("address")), dns: dns.length ? dns : undefined },
      peers: parsedPeers,
    },
  }
}

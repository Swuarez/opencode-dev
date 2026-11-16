import { describe, expect, test } from "bun:test"
import { parseWireGuardConf } from "./wireguard-conf"

// Valid base64 keys of 32 bytes; the values are fake.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
const GOOD = `
[Interface]
PrivateKey = ${KEY}
Address = 2a0c:1234::2/128, 10.0.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = ${KEY}
AllowedIPs = ::/0, 0.0.0.0/0
Endpoint = [2001:db8::1]:51820
PersistentKeepalive = 25
`

describe("parseWireGuardConf", () => {
  test("accepts a complete route64-style file", () => {
    const result = parseWireGuardConf(GOOD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.conf.interface.address).toEqual(["2a0c:1234::2/128", "10.0.0.2/32"])
    expect(result.conf.interface.dns).toEqual(["1.1.1.1"])
    expect(result.conf.peers[0]!.endpoint).toBe("[2001:db8::1]:51820")
    expect(result.conf.peers[0]!.keepalive).toBe(25)
  })

  test("rejects a missing private key and says which field, never its value", () => {
    const result = parseWireGuardConf(GOOD.replace(/PrivateKey = .*/, "PrivateKey = not-a-key"))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(" ")).toContain("PrivateKey")
    expect(result.errors.join(" ")).not.toContain("not-a-key")
  })

  test("rejects a bad endpoint port", () => {
    const result = parseWireGuardConf(GOOD.replace("[2001:db8::1]:51820", "example.org:99999"))
    expect(result.ok).toBe(false)
  })

  test("requires exactly one Interface and at least one Peer", () => {
    expect(parseWireGuardConf("[Peer]\nPublicKey = " + KEY).ok).toBe(false)
    expect(parseWireGuardConf(`[Interface]\nPrivateKey = ${KEY}\nAddress = 10.0.0.2/32`).ok).toBe(false)
  })

  test("ignores comments and blank lines", () => {
    const result = parseWireGuardConf("# route64\n\n" + GOOD)
    expect(result.ok).toBe(true)
  })
})

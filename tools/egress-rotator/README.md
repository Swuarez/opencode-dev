# egress-rotator

One proxy endpoint that leaves by a different **source IP on every connection**. It is the server-side half of
OpenCode Infinite's Pool mode: the app sees one proxy entry, the gateway rotates inside.

You cannot invent routable IPs. You own a block that is routed to a machine and source-bind each outbound connection
to an address inside it. IPv6 is the only block that is cheap: a single VPS usually comes with a `/64`, which is
18,446,744,073,709,551,616 addresses.

## What you need

- A Linux VPS whose provider routes an IPv6 prefix to it. Hetzner Cloud gives every server a `/64`; Oracle Cloud and
  most KVM hosts do too. The prefix must be **routed**, not just one address configured on the interface.
- Node.js 18 or newer on the VPS.
- The proxy port reachable from the machine running OpenCode Infinite.

Check what the provider gave you:

```bash
ip -6 addr show scope global
ip -6 route show
```

If `ip -6 route` shows the `/64` on the interface, the prefix is routed and non-local binding works.

## Setup

```bash
sudo mkdir -p /opt/egress-rotator
sudo cp rotator.js /opt/egress-rotator/
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin egress || true

# Let this host bind any address inside the routed prefix, not only the ones configured on the NIC.
echo 'net.ipv6.ip_nonlocal_bind = 1' | sudo tee /etc/sysctl.d/99-egress.conf
sudo sysctl --system

sudo firewall-cmd --permanent --add-port=8899/tcp && sudo firewall-cmd --reload   # firewalld
# or: sudo ufw allow 8899/tcp

sudo cp egress-rotator.service /etc/systemd/system/
sudo cp egress-rotator.env.example /etc/egress-rotator.env
sudo nano /etc/egress-rotator.env        # prefix, login, port
sudo chmod 600 /etc/egress-rotator.env   # it holds the proxy password
sudo systemctl daemon-reload
sudo systemctl enable --now egress-rotator
sudo journalctl -u egress-rotator -f
```

## Test the rotation

```bash
for i in 1 2 3 4; do
  curl -s -x "http://user:password@203.0.113.10:8899" https://www.cloudflare.com/cdn-cgi/trace | grep '^ip='
done
```

Four different `ip=` lines mean four source addresses. If they repeat, the prefix is not routed, `ip_nonlocal_bind`
is off, or the provider filters source addresses outside the one assigned to the NIC.

## Wire it into OpenCode Infinite

In the desktop app: **Settings > Advanced > Proxies**, add one line:

```
http://user:password@203.0.113.10:8899
```

One entry is enough. Infinite already treats a one-entry proxy list as a rotating gateway: every new connection goes
to the same URL, and the gateway picks the next source. Choose **Pool** (or **Proxy**) in the bottom bar. The app's
own idle-tunnel close gives the next request a new source.

## IPv4 variant

IPv4 addresses cannot be generated; they are rented. If the provider routes a small block to the VPS:

```bash
sudo ip addr add 203.0.113.11/32 dev eth0
sudo ip addr add 203.0.113.12/32 dev eth0
printf '203.0.113.11\n203.0.113.12\n' | sudo tee /opt/egress-rotator/sources.txt
```

Set `SOURCE_FILE=/opt/egress-rotator/sources.txt` in the env file. Add `net.ipv4.ip_nonlocal_bind = 1` only when the
provider routes the block to the server rather than requiring ARP for each address; with a bridged block you must
also add the addresses on the interface.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN_PORT` | `8899` | Proxy port |
| `LISTEN_HOST` | `::` | Listen address; `::` accepts IPv4 and IPv6 |
| `PROXY_USER` / `PROXY_PASS` | empty | Basic auth. Set both on a public VPS |
| `SOURCE_CIDR` | empty | Routed IPv6 prefix, e.g. `2001:db8:1:2::/64` |
| `SOURCE_FILE` | empty | File with one source IP per line |
| `SOURCE_TRY` | `4` | Sources tried before answering 502 |
| `CONNECT_TIMEOUT_MS` | `10000` | Per-source connect timeout |
| `ALLOW_PORTS` | `443,80` | Destination ports allowed through CONNECT |

Both `SOURCE_CIDR` and `SOURCE_FILE` may be set; the gateway alternates between them.

## Limits, stated plainly

- Every source is a distinct address, so per-IP counters see a new IP. Reputation systems may group the whole `/64`
  or the ASN; a fresh address is not a fresh reputation.
- With `SOURCE_CIDR` alone the gateway is IPv6-only: it resolves AAAA records and cannot reach an IPv4-only host.
  `opencode.ai` and `api.opencode.ai` publish AAAA records, so an IPv6-only prefix reaches OpenCode. Add an IPv4
  source or a NAT64 prefix for IPv4-only targets.
- A `/64` from one VPS is one network. If a service rate-limits by prefix or provider, add a second VPS in another
  network and put both gateways in Infinite's proxy list.
- The rotator is a CONNECT proxy with no TLS interception: the client's TLS runs end to end. It sees the target host
  and port, not the payload.
- Run it only on infrastructure you control. An open proxy on the public internet is found within hours.

#pragma once
// vpn.h - pure parsing for the WireGuard (wireproxy) and VPN Gate (OpenVPN) egress modes.
// No Windows calls here, so the same code is exercised by a test harness.
#include <string>
#include <vector>
#include <set>
#include <functional>

namespace oi {

// WireGuard .conf files (the .bat takes only names matching ^[A-Za-z0-9_=+.-]{1,32}$ and non-empty).
bool wgNameOk(const std::string& baseName);
// [Interface] with a PrivateKey and at least one [Peer]. Never copies the key anywhere.
bool wgConfValid(const std::string& text);
// the .conf plus the local HTTP listener wireproxy serves (same text the .bat writes to run.conf)
std::string wgRunConf(const std::string& conf, int port);

struct VgServer {
    std::string host, country, b64;
    double score = 0;
};
// VPN Gate API csv ("#HostName,..." header; "*" and "#" lines are not data). false = no header.
bool parseVpnGateCsv(const std::string& text, std::vector<VgServer>& out);
// servers with a config, not failed, in the country (empty = any), best score first, at most max
std::vector<VgServer> vgPick(const std::vector<VgServer>& all, const std::set<std::string>& failed,
                             const std::string& country, int max);
// HostName becomes a file name: only letters, digits, . _ - are accepted
bool vgHostOk(const std::string& host);
std::string base64Decode(const std::string& in);

struct OvpnBuilt { std::string text; int routes = 0; };
using ResolveFn = std::function<std::vector<std::string>(const std::string&)>;
// Server routes and every directive that runs programs / touches files removed, one route per OpenCode IP.
OvpnBuilt buildOvpn(const std::string& text, const std::vector<std::string>& ocIps, const ResolveFn& resolve);

// "Initialization Sequence Completed" = 1, AUTH_FAILED|Exiting due to fatal error|SIGTERM = -1, else 0
int ovpnLogState(const std::string& log);

} // namespace oi

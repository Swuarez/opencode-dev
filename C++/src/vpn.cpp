// vpn.cpp - see vpn.h. Port of the .bat blocks OC_VPN_PS (wireproxy) and OC_VGATE_PS (VPN Gate).
#include "vpn.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <map>
#include <regex>

namespace oi {

static std::vector<std::string> lines(const std::string& t) {
    std::vector<std::string> v;
    size_t p = 0;
    while (p <= t.size()) {
        size_t e = t.find('\n', p);
        if (e == std::string::npos) e = t.size();
        std::string l = t.substr(p, e - p);
        if (!l.empty() && l.back() == '\r') l.pop_back();
        v.push_back(l);
        p = e + 1;
    }
    return v;
}
static std::string lowerS(std::string s) { for (char& c : s) c = (char)tolower((unsigned char)c); return s; }
static std::string upperS(std::string s) { for (char& c : s) c = (char)toupper((unsigned char)c); return s; }
static std::string trimS(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && isspace((unsigned char)s[a])) ++a;
    while (b > a && isspace((unsigned char)s[b - 1])) --b;
    return s.substr(a, b - a);
}

// ---------------------------------------------------------------- WireGuard

bool wgNameOk(const std::string& n) {
    if (n.empty() || n.size() > 32) return false;
    for (unsigned char c : n) if (!(isalnum(c) || c == '_' || c == '=' || c == '+' || c == '.' || c == '-')) return false;
    return true;
}

bool wgConfValid(const std::string& text) {
    bool iface = false, peer = false, key = false, inIface = false;
    for (const auto& raw : lines(text)) {
        std::string l = lowerS(trimS(raw));
        if (l.empty() || l[0] == '#' || l[0] == ';') continue;
        if (l[0] == '[') {
            inIface = (l == "[interface]");
            if (inIface) iface = true;
            if (l == "[peer]") peer = true;
            continue;
        }
        if (inIface && l.compare(0, 10, "privatekey") == 0 && trimS(l.substr(10)).compare(0, 1, "=") == 0) key = true;
    }
    return iface && peer && key;
}

std::string wgRunConf(const std::string& conf, int port) {
    std::string t = conf;
    while (!t.empty() && isspace((unsigned char)t.back())) t.pop_back();
    return t + "\r\n\r\n[http]\r\nBindAddress = 127.0.0.1:" + std::to_string(port) + "\r\n";
}

// ---------------------------------------------------------------- VPN Gate

bool vgHostOk(const std::string& h) {
    if (h.empty() || h.size() > 64 || h[0] == '.') return false;
    for (unsigned char c : h) if (!(isalnum(c) || c == '.' || c == '_' || c == '-')) return false;
    return true;
}

static std::vector<std::string> csvLine(const std::string& l) {
    std::vector<std::string> f;
    std::string cur;
    bool q = false;
    for (size_t i = 0; i < l.size(); ++i) {
        char c = l[i];
        if (q) {
            if (c == '"' && i + 1 < l.size() && l[i + 1] == '"') { cur += '"'; ++i; }
            else if (c == '"') q = false;
            else cur += c;
        } else if (c == '"') q = true;
        else if (c == ',') { f.push_back(cur); cur.clear(); }
        else cur += c;
    }
    f.push_back(cur);
    return f;
}

bool parseVpnGateCsv(const std::string& text, std::vector<VgServer>& out) {
    out.clear();
    auto ls = lines(text);
    std::vector<std::string> hdr;
    for (const auto& l : ls) if (l.compare(0, 9, "#HostName") == 0) { hdr = csvLine(l.substr(1)); break; }
    if (hdr.empty()) return false;
    std::map<std::string, size_t> col;
    for (size_t i = 0; i < hdr.size(); ++i) col[lowerS(hdr[i])] = i;
    auto at = [&](const char* n) -> long { auto it = col.find(n); return it == col.end() ? -1 : (long)it->second; };
    long iHost = at("hostname"), iScore = at("score"), iCc = at("countryshort"), iCfg = at("openvpn_configdata_base64");
    if (iHost < 0 || iCfg < 0) return false;
    for (const auto& l : ls) {
        if (l.empty() || l[0] == '#' || l[0] == '*') continue;
        auto f = csvLine(l);
        if ((long)f.size() <= iCfg || (long)f.size() <= iHost) continue;
        VgServer s;
        s.host = f[iHost];
        s.b64 = f[iCfg];
        if (iCc >= 0 && (long)f.size() > iCc) s.country = f[iCc];
        if (iScore >= 0 && (long)f.size() > iScore) s.score = atof(f[iScore].c_str());
        out.push_back(s);
    }
    return true;
}

std::vector<VgServer> vgPick(const std::vector<VgServer>& all, const std::set<std::string>& failed,
                             const std::string& country, int max) {
    std::string cc = upperS(trimS(country));
    std::vector<VgServer> v;
    for (const auto& s : all) {
        if (s.b64.empty() || failed.count(s.host)) continue;
        if (!cc.empty() && upperS(s.country) != cc) continue;
        v.push_back(s);
    }
    std::stable_sort(v.begin(), v.end(), [](const VgServer& a, const VgServer& b) { return a.score > b.score; });
    if (max > 0 && (int)v.size() > max) v.resize(max);
    return v;
}

std::string base64Decode(const std::string& in) {
    static const std::string tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    unsigned val = 0;
    int bits = -8;
    for (unsigned char c : in) {
        if (c == '=' || isspace(c)) continue;
        size_t p = tbl.find((char)c);
        if (p == std::string::npos) return "";
        val = (val << 6) | (unsigned)p;
        bits += 6;
        if (bits >= 0) { out += (char)((val >> bits) & 0xFF); bits -= 8; }
    }
    return out;
}

OvpnBuilt buildOvpn(const std::string& text, const std::vector<std::string>& ocIps, const ResolveFn& resolve) {
    static const std::regex remote("^\\s*remote\\s+(\\S+)", std::regex::icase);
    static const std::regex routes("^\\s*(--)?(redirect-gateway|route|route-ipv6|route-nopull|dhcp-option|block-outside-dns|pull-filter)\\b", std::regex::icase);
    // openvpn runs elevated: server-supplied directives that run programs, load code or touch local files are dropped
    static const std::regex danger("^\\s*(--)?(script-security|up|down|ipchange|plugin|tls-verify|auth-user-pass-verify|client-connect|client-disconnect|learn-address|tls-crypt-v2-verify|tls-export-cert|config|cd|chroot|log|log-append|status|writepid|tmp-dir|management\\S*|win-sys|iproute|askpass|auth-user-pass|daemon|setenv|setenv-safe)(\\s|$)", std::regex::icase);
    static const std::regex ipv4("^\\d{1,3}(\\.\\d{1,3}){3}$");
    std::vector<std::string> keep, server;
    for (const auto& ln : lines(text)) {
        std::smatch m;
        if (std::regex_search(ln, m, remote)) server.push_back(m[1]);
        if (std::regex_search(ln, routes)) continue;
        if (std::regex_search(ln, danger)) continue;
        keep.push_back(ln);
    }
    std::vector<std::string> srvIps;
    for (const auto& s : server) {
        if (std::regex_match(s, ipv4)) srvIps.push_back(s);
        else if (resolve) for (const auto& ip : resolve(s)) srvIps.push_back(ip);
    }
    keep.push_back("route-nopull");
    keep.push_back("pull-filter ignore \"redirect-gateway\"");
    keep.push_back("pull-filter ignore \"dhcp-option\"");
    OvpnBuilt r;
    std::vector<std::string> v6;
    for (const auto& ip : ocIps) {
        if (std::find(srvIps.begin(), srvIps.end(), ip) != srvIps.end()) continue;   // never route the tunnel onto itself
        if (ip.find(':') != std::string::npos) v6.push_back(ip);
        else keep.push_back("route " + ip + " 255.255.255.255");
        ++r.routes;
    }
    // Bun ignores NODE_OPTIONS: OpenCode's IPv6 goes into the tunnel and is refused there, so IPv4 wins and nothing leaks
    if (!v6.empty()) {
        keep.push_back("ignore-unknown-option block-ipv6");
        keep.push_back("ifconfig-ipv6 fd15:53b6:dead::2/64 fd15:53b6:dead::1");
        keep.push_back("block-ipv6");
        for (const auto& ip : v6) keep.push_back("route-ipv6 " + ip + "/128");
    }
    for (size_t i = 0; i < keep.size(); ++i) r.text += (i ? "\r\n" : "") + keep[i];
    return r;
}

int ovpnLogState(const std::string& log) {
    if (log.find("Initialization Sequence Completed") != std::string::npos) return 1;
    if (log.find("AUTH_FAILED") != std::string::npos || log.find("Exiting due to fatal error") != std::string::npos ||
        log.find("SIGTERM") != std::string::npos) return -1;
    return 0;
}

} // namespace oi

// egress.cpp
#include "egress.h"
#include "http.h"
#include "proc.h"
#include "util.h"
#include "log.h"
#include "json.h"
#include "vpn.h"
#include "lang.h"
#include "updates.h"

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <algorithm>
#include <random>
#include <mutex>
#include <cctype>
#include <thread>
#include <sddl.h>
#include "vgate_helper.inc"

#pragma comment(lib, "ws2_32.lib")

namespace oi {

static const char* kTraceUrl = "https://www.cloudflare.com/cdn-cgi/trace";
static const char* kTorCheckUrl = "https://check.torproject.org/api/ip";

const char* egressName(Egress e) {
    switch (e) {
        case Egress::Warp: return "WARP";
        case Egress::Tor: return "TOR";
        case Egress::Proxy: return "PROXY";
        case Egress::Wireproxy: return "WIREGUARD";
        case Egress::VpnGate: return "VPNGATE";
        default: return "NONE";
    }
}

Egress egressFromName(const std::string& s) {
    std::string v = upper(trim(s));
    if (v == "WARP") return Egress::Warp;
    if (v == "TOR") return Egress::Tor;
    if (v == "PROXY") return Egress::Proxy;
    if (v == "WIREGUARD") return Egress::Wireproxy;
    if (v == "VPNGATE") return Egress::VpnGate;
    return Egress::None;
}

EgressEngine::EgressEngine(Config* cfg, EgressState* st) : cfg_(cfg), st_(st) {}
EgressEngine::~EgressEngine() { if (runTag_.empty()) shutdown(); else wgStop(); }

// ---------------------------------------------------------------- helpers

static void wsaOnce() {
    static bool done = false;
    if (done) return;
    WSADATA d;
    done = WSAStartup(MAKEWORD(2, 2), &d) == 0;
}

bool EgressEngine::portOpen(uint16_t port, int timeoutMs) const {
    wsaOnce();
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    u_long nb = 1;
    ioctlsocket(s, FIONBIO, &nb);
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
    bool open = false;
    if (connect(s, (sockaddr*)&sa, sizeof(sa)) == 0) open = true;
    else if (WSAGetLastError() == WSAEWOULDBLOCK) {
        fd_set wr, ex;
        FD_ZERO(&wr); FD_ZERO(&ex);
        FD_SET(s, &wr); FD_SET(s, &ex);
        timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
        if (select(0, nullptr, &wr, &ex, &tv) > 0 && FD_ISSET(s, &wr)) {
            int err = 0, len = sizeof(err);
            getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&err, &len);
            open = (err == 0);
        }
    }
    closesocket(s);
    return open;
}

static void say(const ProgressFn& fn, int kind, const std::string& msg) {
    logInfo(fmt("[egress] %s", msg.c_str()));
    if (fn) fn(kind, msg);
}

void EgressEngine::detectTools() {
    st_->warpFound = warpAvailable();
    st_->torFound = !torExePath().empty() || portOpen(cfg_->i("TOR_SOCKS_PORT"), 800);
}

std::string EgressEngine::torDir() const { return joinPath(cfg_->dir(), "tor"); }
std::string EgressEngine::torLogPath() const { return joinPath(torDir(), "tor.log"); }

// ---------------------------------------------------------------- WARP

bool EgressEngine::warpAvailable() const {
    std::string p = findOnPath("warp-cli.exe");
    if (!p.empty()) return true;
    std::string pf = envVar("ProgramFiles");
    if (!pf.empty() && fileExists(joinPath(pf, "Cloudflare\\Cloudflare WARP\\warp-cli.exe"))) return true;
    return false;
}

bool EgressEngine::warpCall(const std::string& args, int timeoutSec, std::string* out) const {
    std::string exe = findOnPath("warp-cli.exe");
    if (exe.empty()) {
        std::string pf = envVar("ProgramFiles");
        exe = joinPath(pf, "Cloudflare\\Cloudflare WARP\\warp-cli.exe");
    }
    if (!fileExists(exe)) return false;
    RunResult r = runCapture(exe, "--accept-tos " + args, {}, timeoutSec * 1000);
    if (out) *out = r.out;
    // daemon chatter is kept for diagnosis, like wcli.log in the batch version
    std::string logf = joinPath(cfg_->dir(), "wcli.log");
    std::string entry = fmt("$ warp-cli %s  (exit %d)\n%s%s\n", args.c_str(), r.exitCode, r.out.c_str(), r.err.c_str());
    HANDLE h = CreateFileW(utf8ToWide(logf).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD wr = 0;
        WriteFile(h, entry.data(), (DWORD)entry.size(), &wr, nullptr);
        CloseHandle(h);
    }
    bool ok = r.started && r.exitCode == 0;
    // failures reach the launcher log too, not only wcli.log
    if (!ok) logWarn(fmt("[egress] warp-cli %s failed (exit %d)", args.c_str(), r.exitCode));
    return ok;
}

bool EgressEngine::warpCheck(std::string* ip) const {
    HttpResult r = httpGet(kTraceUrl, fmt("http://127.0.0.1:%d", cfg_->i("PROXY_PORT")), 15);
    if (!r.ok) return false;
    std::string warp;
    for (const auto& line : split(r.body, '\n')) {
        if (startsWith(line, "warp=")) warp = trim(line.substr(5));
        else if (ip && startsWith(line, "ip=")) *ip = trim(line.substr(3));
    }
    return warp == "on" || warp == "plus";
}

// The WARP daemon must run before warp-cli can connect. Starting it needs administrator rights, so the
// message comes first and the prompt once, and only when the service is really stopped (same command as the .bat).
bool EgressEngine::warpSvcFix(ProgressFn log) {
    RunResult q = runCapture("sc.exe", "query CloudflareWARP", {}, 10000);
    if (q.out.find("STOPPED") == std::string::npos) return true;   // running, starting or not installed: warp-cli decides
    say(log, 0, tx("WARP service is stopped or disabled. Turning it on needs administrator rights, which this program never asks for. Start the WARP service yourself, or run this program as administrator."));
    if (!isElevated()) return false;
    std::string ps = joinPath(envVar("SystemRoot"), "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    std::wstring w = utf8ToWide("Set-Service -Name CloudflareWARP -StartupType Automatic; Start-Service -Name CloudflareWARP");
    std::string bytes((const char*)w.data(), w.size() * sizeof(wchar_t));
    uint32_t code = 0;
    Spawned sp = spawnElevated(ps, "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + base64Encode(bytes), true, &code);
    if (!sp.ok) { say(log, 2, tx("the WARP service could not be started (this program is not administrator).")); return false; }
    logInfo(fmt("[warp] service start exit %u", code));
    return code == 0;
}

bool EgressEngine::warpUp(ProgressFn log) {
    if (!warpAvailable()) { say(log, 3, "warp-cli missing"); return false; }
    if (!warpSvcFix(log)) return false;
    int port = cfg_->i("PROXY_PORT");
    int callTo = cfg_->i("WARP_CALL_TIMEOUT");
    warpCall("registration show", callTo);
    std::string out;
    if (!warpCall("registration show", callTo, &out) || out.find("Missing") != std::string::npos) {
        warpCall("registration new", callTo);
    }
    warpCall("mode proxy", callTo);
    warpCall(fmt("proxy port %d", port), callTo);
    warpCall("connect", callTo);
    int wait = cfg_->i("WARP_WAIT");
    for (int i = 0; i < wait; ++i) {
        std::string st;
        if (warpCall("status", callTo, &st) && st.find("Connected") != std::string::npos) break;
        Sleep(1000);
    }
    std::string ip;
    return warpCheck(&ip);
}

bool EgressEngine::warpRotate(ProgressFn log) {
    if (!warpAvailable()) return false;
    int callTo = cfg_->i("WARP_CALL_TIMEOUT");
    say(log, 0, "disconnecting WARP and asking for a new registration...");
    // disconnect first so the old tunnel is gone; disconnect/delete may fail harmlessly
    // (already down / nothing registered), a failed "registration new" fails this attempt
    warpCall("disconnect", callTo);
    warpCall("registration delete", callTo);
    if (!warpCall("registration new", callTo)) {
        say(log, 2, "warp-cli registration new failed.");
        return false;
    }
    return warpUp(log);
}

// ---------------------------------------------------------------- Tor

std::string EgressEngine::torExePath() const {
    std::string d = torDir();
    std::string a = joinPath(joinPath(d, "Tor"), "tor.exe");
    if (fileExists(a)) return a;
    std::string b = joinPath(d, "tor.exe");
    if (fileExists(b)) return b;
    return findOnPath("tor.exe");
}

bool EgressEngine::torSocksUp() const { return portOpen(cfg_->i("TOR_SOCKS_PORT"), 900); }

bool EgressEngine::torInstall(ProgressFn log) {
    if (!fileExists(torExePath())) {
        say(log, 0, "downloading the portable Tor expert bundle...");
    } else {
        return true;
    }
    // The Tor Browser updater metadata carries the current bundle name.
    HttpResult meta = httpGet("https://aus1.torproject.org/torbrowser/update_3/release/downloads.json", "", 30);
    std::string url;
    if (meta.ok) {
        std::string err;
        Json j = Json::parse(meta.body, &err);
        const Json& platforms = j["projects"]["tor"]["platforms"];
        const Json& pl = platforms["windows_x86_64"];
        if (pl.isObject()) {
            std::string base = pl["download_url"].asString();
            std::string file = pl["download_filename"].asString();
            if (!base.empty() && !file.empty()) {
                while (!base.empty() && base.back() == '/') base.pop_back();
                url = base + "/" + file;
            }
        }
    }
    if (url.empty()) {
        say(log, 3, "could not read the Tor bundle metadata; install Tor by hand or pick another connection.");
        return false;
    }
    std::string tgz = joinPath(tempDir(), "tor-expert-bundle.tar.gz");
    removeFile(tgz);
    uint64_t size = 0;
    if (!httpDownload(url, tgz, "", 600, &size) || size < 4000000) {
        say(log, 3, "the Tor bundle download failed.");
        removeFile(tgz);
        return false;
    }
    // Same check as the .bat: SHA-256 against sha256sums-signed-build.txt published next to the bundle; fail closed.
    {
        std::string base = url.substr(0, url.rfind('/') + 1), name = url.substr(base.size());
        HttpResult sums = httpGet(base + "sha256sums-signed-build.txt", "", 30);
        std::string want;
        size_t p = 0;
        while (sums.ok && p < sums.body.size()) {
            size_t e = sums.body.find('\n', p);
            if (e == std::string::npos) e = sums.body.size();
            std::string ln = sums.body.substr(p, e - p);
            p = e + 1;
            while (!ln.empty() && isspace((unsigned char)ln.back())) ln.pop_back();
            if (ln.size() > 65 + name.size() && isspace((unsigned char)ln[ln.size() - name.size() - 1]) && ln.compare(ln.size() - name.size(), name.size(), name) == 0 &&
                isspace((unsigned char)ln[64]) && ln.find_first_not_of("0123456789abcdefABCDEF") == 64) {
                want = ln.substr(0, 64);
                break;
            }
        }
        std::string got = sha256File(tgz);
        auto lower = [](std::string x) { for (char& c : x) c = (char)tolower((unsigned char)c); return x; };
        if (want.empty() || got.empty() || lower(want) != got) {
            say(log, 3, "the Tor bundle failed the SHA-256 check against sha256sums-signed-build.txt; it was deleted and NOT unpacked.");
            removeFile(tgz);
            return false;
        }
    }
    makeDirs(torDir());
    std::string tar = joinPath(envVar("SystemRoot"), "System32\\tar.exe");
    if (!fileExists(tar)) tar = "tar.exe";
    RunResult r = runCapture(tar, fmt("-xzf %s -C %s", quoteArg(tgz).c_str(), quoteArg(torDir()).c_str()), {}, 300000);
    removeFile(tgz);
    if (r.exitCode != 0 || !fileExists(torExePath())) {
        say(log, 3, "the Tor bundle could not be unpacked.");
        return false;
    }
    say(log, 1, "Tor is installed.");
    return true;
}

bool EgressEngine::torStart(ProgressFn log) {
    if (torSocksUp()) {
        // a Tor we did not start: leave it alone, just bridge to it
        st_->ourTor = false;
        say(log, 0, fmt("using the Tor already listening on :%d", cfg_->i("TOR_SOCKS_PORT")));
        return true;
    }
    std::string exe = torExePath();
    if (exe.empty() && cfg_->b("TOR_AUTO_INSTALL")) {
        if (!torInstall(log)) return false;
        exe = torExePath();
    }
    if (exe.empty()) { say(log, 3, "tor.exe was not found and TOR_AUTO_INSTALL is off."); return false; }

    std::string d = torDir();
    makeDirs(d);
    std::string fwd = replaceAll(d, "\\", "/");     // tor rejects backslashes in quoted paths
    std::string torrc = joinPath(d, "torrc");
    std::string content = fmt("SocksPort \"127.0.0.1:%d\"\nDataDirectory \"%s/data\"\nLog \"notice file %s/tor.log\"\n",
                              cfg_->i("TOR_SOCKS_PORT"), fwd.c_str(), fwd.c_str());
    writeFileText(torrc, content);
    removeFile(torLogPath());

    say(log, 0, "starting Tor...");
    std::string args = fmt("-f %s --quiet", quoteArg(torrc).c_str());
    Spawned sp = spawnDetached(exe, args, {}, d, true);
    if (!sp.ok) { say(log, 3, "tor could not be started."); return false; }
    torPid_ = sp.pid;
    st_->ourTor = true;

    int wait = cfg_->i("TOR_BOOTSTRAP_WAIT");
    for (int i = 0; i < wait; ++i) {
        if (!isAlive(sp.pid)) {
            std::string tail = readFileTail(torLogPath(), 600);
            say(log, 3, "tor exited right after starting.");
            if (!tail.empty()) say(log, 0, tail);
            return false;
        }
        std::string lg = readFileText(torLogPath());
        if (lg.find("Bootstrapped 100") != std::string::npos) break;
        Sleep(1000);
    }
    return true;
}

void EgressEngine::torStop() {
    if (torPid_ && isAlive(torPid_)) killTree(torPid_);
    torPid_ = 0;
    if (bridge_) { bridge_->stop(); bridge_.reset(); }
}

bool EgressEngine::torReady(ProgressFn log) {
    if (!torStart(log)) return false;

    if (!bridge_) bridge_.reset(new SocksBridge());
    if (!bridge_->running()) {
        if (!bridge_->start((uint16_t)cfg_->i("TOR_HTTP_PORT"), (uint16_t)cfg_->i("TOR_SOCKS_PORT"))) {
            say(log, 3, "the local Tor HTTP bridge could not be started (port busy?).");
            return false;
        }
    }
    // the bridge must actually route through Tor, not merely listen
    for (int i = 0; i < 30; ++i) {
        HttpResult r = httpGet(kTorCheckUrl, fmt("http://127.0.0.1:%d", cfg_->i("TOR_HTTP_PORT")), 20);
        if (r.ok && r.body.find("\"IsTor\":true") != std::string::npos) return true;
        Sleep(1000);
    }
    say(log, 2, "Tor is up but the exit IP is not a Tor exit yet.");
    return false;
}

bool EgressEngine::torRotate(ProgressFn log) {
    if (!st_->ourTor) {
        say(log, 2, "this Tor was not started by the launcher, so its circuit cannot be renewed from here.");
        return false;
    }
    say(log, 0, "restarting Tor for a new circuit...");
    torStop();
    Sleep(2000);
    return torReady(log);
}

// ---------------------------------------------------------------- proxy list

bool EgressEngine::parseProxies(const std::string& text, std::vector<std::string>& out) {
    // every ip:port in the payload counts, whatever the surrounding format is
    size_t i = 0;
    while (i < text.size()) {
        if (!isdigit((unsigned char)text[i])) { ++i; continue; }
        size_t start = i;
        int dots = 0;
        while (i < text.size() && (isdigit((unsigned char)text[i]) || text[i] == '.')) {
            if (text[i] == '.') ++dots;
            ++i;
        }
        if (dots != 3 || i >= text.size() || text[i] != ':') { continue; }
        std::string ip = text.substr(start, i - start);
        ++i;
        size_t ps = i;
        while (i < text.size() && isdigit((unsigned char)text[i])) ++i;
        std::string port = text.substr(ps, i - ps);
        if (ip.empty() || port.empty() || port.size() > 5) continue;
        int pn = atoi(port.c_str());
        if (pn < 1 || pn > 65535) continue;
        out.push_back(ip + ":" + port);
    }
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
    return !out.empty();
}

bool EgressEngine::proxyPick(ProgressFn log) {
    // the user's own proxy replaces the list; it must still answer the trace check
    std::string fixed = trim(cfg_->s("PROXY_FIXED"));
    if (startsWith(fixed, "http://")) fixed = fixed.substr(7);
    if (!fixed.empty()) {
        if (fixed.find(':') == std::string::npos) { say(log, 3, "your own proxy must be host:port."); return false; }
        HttpResult r = httpGet(kTraceUrl, "http://" + fixed, cfg_->i("PROXY_PROBE_TIMEOUT"));
        if (!r.ok || r.body.find("ip=") == std::string::npos) { say(log, 2, fmt("your own proxy %s did not answer.", fixed.c_str())); return false; }
        st_->activeProxy = fixed;
        st_->proxyUrl = "http://" + fixed;
        say(log, 1, fmt("proxy picked: %s", fixed.c_str()));
        return true;
    }
    std::string src = cfg_->s("PROXY_LIST_URL");
    std::string raw;
    if (fileExists(src)) raw = readFileText(src);
    else {
        HttpResult r = httpGet(src, "", 20);
        if (!r.ok) { say(log, 2, "the proxy list could not be downloaded."); return false; }
        raw = r.body;
    }
    int minBytes = cfg_->i("PROXY_LIST_MIN_BYTES");
    if (minBytes > 0 && (int)raw.size() < minBytes) {
        say(log, 2, "the proxy list is smaller than PROXY_LIST_MIN_BYTES.");
        return false;
    }
    std::vector<std::string> list;
    if (!parseProxies(raw, list)) { say(log, 2, "no ip:port entries in the proxy list."); return false; }

    std::mt19937 rng((unsigned)GetTickCount64());
    std::shuffle(list.begin(), list.end(), rng);

    int tryMax = cfg_->i("PROXY_TRY_MAX");
    int timeout = cfg_->i("PROXY_PROBE_TIMEOUT");
    int tries = 0;
    for (const auto& p : list) {
        if (++tries > tryMax) break;
        HttpResult r = httpGet(kTraceUrl, "http://" + p, timeout);
        if (!r.ok || r.body.find("ip=") == std::string::npos) continue;
        if (cfg_->b("PROXY_API_CHECK")) {
            std::string url = cfg_->s("PROXY_API_CHECK_URL");
            HttpResult a = httpGet(url, "http://" + p, timeout);
            if (!a.ok && a.status == 0) continue;
        }
        st_->activeProxy = p;
        st_->proxyUrl = "http://" + p;
        say(log, 1, fmt("proxy picked: %s", p.c_str()));
        return true;
    }
    say(log, 2, fmt("no working proxy in %d tries.", tries));
    return false;
}

// ---------------------------------------------------------------- VPN modes (WireGuard through wireproxy, VPN Gate through OpenVPN)
// Port of the .bat blocks OC_VPN_PS and OC_VGATE_PS. Parsing lives in vpn.cpp.

// the pinned wireproxy release, checked by SHA-256 before it is unpacked (same pin as the .bat)
static const char* kWpVer = "1.1.3";
static const char* kWpSha = "bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f";
static const char* kVgApi = "https://www.vpngate.net/api/iphone/";
// checked through a routed host, so a request that leaves by the physical route shows the old IP
static const char* kOcTraceUrl = "https://opencode.ai/cdn-cgi/trace";

static TraceInfo parseTrace(const std::string& body) {
    TraceInfo t;
    t.raw = body;
    for (const auto& line : split(body, '\n')) {
        std::string l = trim(line);
        if (startsWith(l, "ip=")) t.ip = l.substr(3);
        else if (startsWith(l, "loc=")) t.loc = l.substr(4);
        else if (startsWith(l, "warp=")) t.warp = l.substr(5);
    }
    t.ok = !t.ip.empty();
    return t;
}

static TraceInfo traceVia(const std::string& proxyUrl, int timeoutSec) {
    HttpResult r = httpGet(kTraceUrl, proxyUrl, timeoutSec);
    return r.ok ? parseTrace(r.body) : TraceInfo();
}

static bool portFree(int port) {
    wsaOnce();
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
    bool ok = bind(s, (sockaddr*)&sa, sizeof(sa)) == 0;
    closesocket(s);
    return ok;
}

// every address a host resolves to (IPv4, and IPv6 unless link-local)
static std::vector<std::string> resolveAll(const std::string& host) {
    wsaOnce();
    std::vector<std::string> out;
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0) { logWarn(fmt("[vpn] resolve failed: %s", host.c_str())); return out; }
    for (addrinfo* p = res; p; p = p->ai_next) {
        char buf[INET6_ADDRSTRLEN] = {};
        if (p->ai_family == AF_INET) inet_ntop(AF_INET, &((sockaddr_in*)p->ai_addr)->sin_addr, buf, sizeof(buf));
        else if (p->ai_family == AF_INET6) {
            const in6_addr& a = ((sockaddr_in6*)p->ai_addr)->sin6_addr;
            if (IN6_IS_ADDR_LINKLOCAL(&a)) continue;
            inet_ntop(AF_INET6, &a, buf, sizeof(buf));
        }
        if (buf[0]) out.push_back(buf);
    }
    freeaddrinfo(res);
    return out;
}

// polls until the exit IP differs from prev. 0 = new IP, 1 = answered but unchanged, 2 = no answer
static int waitNewIp(const std::string& prev, int secs, const std::function<TraceInfo()>& tr, TraceInfo* out) {
    int64_t end = nowSeconds() + secs;
    bool any = false;
    for (;;) {
        TraceInfo t = tr();
        if (t.ok) { any = true; *out = t; if (t.ip != prev) return 0; }
        if (nowSeconds() >= end) break;
        Sleep(3000);
    }
    return any ? 1 : 2;
}

static std::string logPathOf(const Config* c) { return joinPath(c->dir(), "launcher.log"); }

// ---- WireGuard (wireproxy): a user-mode client that serves a local HTTP proxy only OpenCode uses

std::string EgressEngine::wpExe(ProgressFn log) {
    std::string bin = joinPath(cfg_->dir(), "bin");
    std::string exe = joinPath(bin, "wireproxy.exe");
    if (fileExists(exe)) return exe;
    makeDirs(bin);
    std::string tgz = joinPath(bin, "wireproxy.tar.gz");
    removeFile(tgz);
    say(log, 0, tx("downloading wireproxy {0}...", kWpVer));
    std::string url = fmt("https://github.com/windtf/wireproxy/releases/download/v%s/wireproxy_windows_amd64.tar.gz", kWpVer);
    uint64_t size = 0;
    if (!httpDownload(url, tgz, "", 120, &size)) { logWarn("[vpn] wireproxy download failed"); removeFile(tgz); return ""; }
    std::string h = lower(sha256File(tgz));
    if (h != kWpSha) {
        logWarn(fmt("[vpn] wireproxy archive hash %s is not %s", h.c_str(), kWpSha));
        removeFile(tgz);
        return "";
    }
    std::string tar = joinPath(envVar("SystemRoot"), "System32\\tar.exe");
    if (!fileExists(tar)) tar = "tar.exe";
    RunResult r = runCapture(tar, fmt("-xzf %s -C %s wireproxy.exe", quoteArg(tgz).c_str(), quoteArg(bin).c_str()), {}, 120000);
    removeFile(tgz);
    if (r.exitCode != 0 || !fileExists(exe)) { logWarn("[vpn] tar could not unpack wireproxy"); return ""; }
    logInfo(fmt("[vpn] wireproxy %s installed", kWpVer));
    return exe;
}

void EgressEngine::wgStop() {
    if (wpProc_) {
        bool ex = false;
        handleExitCode(wpProc_, &ex);
        if (!ex) killTree(wpPid_);      // the handle is still ours, so the pid cannot have been reused
        closeProcHandle(wpProc_);
    }
    wpProc_ = nullptr; wpPid_ = 0; wpPort_ = 0;
}

bool EgressEngine::wpStart(const std::string& exe, const std::string& confPath, int port) {
    std::string runDir = joinPath(cfg_->dir(), std::string(runTag_.empty() ? "wireproxy" : "wireproxy-") + runTag_);
    makeDirs(runDir);
    std::string run = joinPath(runDir, "run.conf");
    writeFileText(run, wgRunConf(readFileText(confPath), port));
    Spawned sp = spawnDetached(exe, "-s -c " + quoteArg(run), {}, runDir, true, true);
    if (!sp.ok) { removeFile(run); return false; }
    wpPid_ = sp.pid; wpProc_ = sp.process; wpPort_ = port;
    bool up = false;
    for (int i = 0; i < 33 && !up; ++i) {          // ~10 s, like the .bat
        bool ex = false;
        uint32_t code = handleExitCode(wpProc_, &ex);
        if (ex) { logWarn(fmt("[vpn] wireproxy exited at start, code %u", code)); break; }
        if (portOpen((uint16_t)port, 300)) up = true; else Sleep(300);
    }
    removeFile(run);                                // the private key does not stay in a second file
    return up;
}

bool EgressEngine::wgSwitch(ProgressFn log) {
    say(log, 0, tx("[vpn] changing the {0} tunnel...", "WIREGUARD"));
    std::string exe = wpExe(log);
    if (exe.empty()) {
        say(log, 3, tx("[vpn] wireproxy is missing and could not be downloaded and verified. Log: {0}", logPathOf(cfg_)));
        return false;
    }
    std::string dir = trim(cfg_->s("WG_DIR"));
    if (dir.empty() || dir == "-") dir = joinPath(cfg_->dir(), "wireguard");
    makeDirs(dir);
    struct Conf { std::string name, path; };
    std::vector<Conf> confs;
    for (const auto& f : listDir(dir, false)) {
        if (f.size() < 6 || !iequals(f.substr(f.size() - 5), ".conf")) continue;
        std::string base = f.substr(0, f.size() - 5), path = joinPath(dir, f);
        if (!wgNameOk(base) || fileSizeOf(path) == 0) continue;
        if (!wgConfValid(readFileText(path))) {      // never prints the file: it holds the private key
            say(log, 2, tx("[vpn] the WireGuard config \"{0}\" was skipped: it needs an [Interface] with a PrivateKey and a [Peer].", base));
            continue;
        }
        confs.push_back({base, path});
    }
    std::sort(confs.begin(), confs.end(), [](const Conf& a, const Conf& b) { return lower(a.name) < lower(b.name); });
    if (confs.empty()) {
        say(log, 3, tx("[vpn] there are no .conf files in \"{0}\". Copy your WireGuard configs there.", dir));
        return false;
    }
    // the exit IP to beat: the current proxy's if it runs, else this PC's own
    TraceInfo prevT;
    if (!curName_.empty() && wpProc_ && wpPort_ > 0) prevT = traceVia(fmt("http://127.0.0.1:%d", wpPort_), 8);
    if (!prevT.ok) prevT = traceVia("", 8);
    std::string prev = prevT.ok ? prevT.ip : "";
    // next file after the active one, wrapping around; the active one and the failed ones are skipped
    size_t start = 0;
    for (size_t i = 0; i < confs.size(); ++i) if (confs[i].name == curName_) start = i + 1;
    std::vector<Conf> cands;
    for (size_t i = 0; i < confs.size(); ++i) {
        const Conf& c = confs[(start + i) % confs.size()];
        if (!failedWg_.count(c.name) && c.name != curName_) cands.push_back(c);
    }
    if (cands.empty()) {
        wgStop(); curName_.clear();
        say(log, 3, tx("[vpn] nothing left to try: every .conf failed in this session."));
        return false;
    }
    int timeout = cfg_->i("VPN_TIMEOUT"), tried = 0;
    for (const Conf& c : cands) {
        ++tried;
        say(log, 0, tx("[vpn] trying {0} ...", c.name));
        wgStop();
        int port = 0;
        for (int p = 25345; p < 25355 && !port; ++p) if (portFree(p)) port = p;
        if (!port) break;
        if (!wpStart(exe, c.path, port)) { failedWg_.insert(c.name); logWarn("[vpn] failed " + c.name + ": proxy did not start"); wgStop(); continue; }
        curName_ = c.name;
        std::string proxy = fmt("http://127.0.0.1:%d", port);
        TraceInfo t;
        int w = waitNewIp(prev, timeout, [&] { return traceVia(proxy, 8); }, &t);
        if (w == 0) {
            st_->proxyUrl = proxy;
            say(log, 1, tx("[vpn] tunnel \"{0}\" is up. Exit IP {1} (country {2}).", {c.name, t.ip, t.loc}));
            return true;
        }
        failedWg_.insert(c.name);
        if (w == 1) say(log, 2, tx("[vpn] {0} left the same exit IP, next one.", c.name));
        else say(log, 2, tx("[vpn] {0} gave no answer in {1}s, next one.", c.name, std::to_string(timeout)));
        logWarn("[vpn] failed " + c.name + (w == 1 ? ": same exit IP" : ": no answer"));
        wgStop();
    }
    wgStop(); curName_.clear();
    say(log, 3, tx("[vpn] no tunnel gave a new IP ({0} tried). Log: {1}", std::to_string(tried), logPathOf(cfg_)));
    return false;
}

// ---- VPN Gate (OpenVPN, elevated): only OpenCode's hosts are routed into the tunnel

std::string EgressEngine::ovpnExe(ProgressFn log) {
    for (const char* v : {"ProgramFiles", "ProgramFiles(x86)"}) {
        std::string b = envVar(v);
        if (b.empty()) continue;
        std::string p = joinPath(b, "OpenVPN\\bin\\openvpn.exe");
        if (fileExists(p)) return p;
    }
    std::string w = findOnPath("winget.exe");
    if (w.empty()) { logWarn("[vpn] winget is missing, OpenVPN cannot be installed"); return ""; }
    if (!isElevated()) { say(log, 3, tx("[vpn] OpenVPN is missing. Installing it needs administrator rights, which this program never asks for: install it yourself or run this program as administrator.")); return ""; }
    say(log, 0, tx("[vpn] OpenVPN is missing, installing it with winget..."));
    uint32_t code = 0;
    spawnElevated(w, "install --id OpenVPNTechnologies.OpenVPN -e --silent --accept-package-agreements --accept-source-agreements", true, &code);
    logInfo(fmt("[vpn] winget install exit %u", code));
    std::string p = joinPath(envVar("ProgramFiles"), "OpenVPN\\bin\\openvpn.exe");
    return fileExists(p) ? p : "";
}

std::vector<std::string> EgressEngine::ocIps() const {
    std::vector<std::string> v;
    for (const char* h : {"opencode.ai", "models.opencode.ai", "opentunnel.xyz"})
        for (const auto& ip : resolveAll(h)) v.push_back(ip);
    std::sort(v.begin(), v.end());
    v.erase(std::unique(v.begin(), v.end()), v.end());
    return v;
}

// the exit IP as OpenCode's own host sees it (through the tunnel when it is up). IPv4 first: an IPv6 request
// leaves by the physical route and would report the old IP for a working tunnel.
TraceInfo EgressEngine::vgTrace() const {
    std::string curl = joinPath(envVar("SystemRoot"), "System32\\curl.exe");
    if (!fileExists(curl)) curl = "curl.exe";
    RunResult r = runCapture(curl, std::string("-4 -s --max-time 8 --noproxy \"*\" ") + kOcTraceUrl, {}, 15000);
    TraceInfo t = parseTrace(r.out);
    if (t.ok) return t;
    HttpResult h = httpGet(kOcTraceUrl, "", 8);
    return h.ok ? parseTrace(h.body) : TraceInfo();
}

// ---- VPN Gate helper: one elevated process per session (vgate_helper.inc), reached through a named pipe.
// The helper only accepts this user's SID, checks each config against an allow-list and runs OpenVPN itself.

static const wchar_t* kVgPipe = L"\\\\.\\pipe\\opencode-infinite-vgate";
static std::atomic<bool> gVgStarted{false};   // this process started the helper (the pool engine shares it)
static std::mutex gVgMtx;                     // the helper serves one pipe instance: one request at a time

// one request, one answer line; "" = nothing answered within ms
static std::string vgRequest(const std::string& req, int ms) {
    std::lock_guard<std::mutex> lk(gVgMtx);
    ULONGLONG end = GetTickCount64() + ms;
    HANDLE h;
    while ((h = CreateFileW(kVgPipe, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr)) == INVALID_HANDLE_VALUE) {
        if (GetTickCount64() >= end) return "";
        Sleep(100);
    }
    std::string line = req + "\n", out;
    DWORD n = 0;
    // non-blocking reads: a helper that stops answering must not hold gVgMtx past the deadline
    DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if (!SetNamedPipeHandleState(h, &mode, nullptr, nullptr)) { CloseHandle(h); return ""; }
    bool nl = false;
    if (WriteFile(h, line.data(), (DWORD)line.size(), &n, nullptr)) {
        char c = 0;
        DWORD got = 0;
        while (GetTickCount64() < end) {
            if (!ReadFile(h, &c, 1, &got, nullptr)) {
                if (GetLastError() == ERROR_NO_DATA) { Sleep(10); continue; }
                break;
            }
            if (got != 1) { Sleep(10); continue; }
            if (c == '\n') { nl = true; break; }
            out += c;
        }
    }
    if (!nl) out.clear();   // a partial line is not an answer
    CloseHandle(h);
    if (!out.empty() && out.back() == '\r') out.pop_back();
    return out;
}

// the SID of this user: the only account the helper's pipe accepts
static std::string currentUserSid() {
    std::string sid;
    HANDLE tok = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return sid;
    DWORD n = 0;
    GetTokenInformation(tok, TokenUser, nullptr, 0, &n);
    std::vector<BYTE> buf(n);
    if (n && GetTokenInformation(tok, TokenUser, buf.data(), n, &n)) {
        LPSTR s = nullptr;
        if (ConvertSidToStringSidA(reinterpret_cast<TOKEN_USER*>(buf.data())->User.Sid, &s)) { sid = s; LocalFree(s); }
    }
    CloseHandle(tok);
    return sid;
}

bool vgHelperAlive() { return !vgRequest("STATUS", 400).empty(); }

// starts the helper when it is not running. Never prompts for administrator rights: only when this process is already elevated (OpenVPN is installed first if missing)
bool EgressEngine::vgEnsure(ProgressFn log) {
    if (vgHelperAlive()) { gVgStarted = true; return true; }
    std::string exe = ovpnExe(log);
    if (exe.empty()) {
        say(log, 3, tx("[vpn] OpenVPN is missing and winget could not install it. Install OpenVPN from openvpn.net, then try again."));
        return false;
    }
    std::string sid = currentUserSid();
    if (sid.empty()) { logWarn("[vpn] could not read the user SID"); return false; }
    std::string script = "$Pipe = 'opencode-infinite-vgate'; $ClientSid = '" + sid + "'; $IdleSec = 600\r\n" + vgHelperScript();
    std::wstring w = utf8ToWide(script);
    std::string bytes((const char*)w.data(), w.size() * sizeof(wchar_t));
    std::string ps = joinPath(envVar("SystemRoot"), "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if (!isElevated()) { say(log, 3, tx("[vpn] VPN Gate needs administrator rights, which this program never asks for: run this program as administrator to use it.")); return false; }
    Spawned sp = spawnElevated(ps, "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + base64Encode(bytes), false);
    if (!sp.ok) { say(log, 3, tx("[vpn] the VPN Gate helper could not be started.")); return false; }
    closeProcHandle(sp.process);
    ULONGLONG end = GetTickCount64() + 90000;
    while (GetTickCount64() < end) {
        if (vgHelperAlive()) { gVgStarted = true; return true; }
        Sleep(700);
    }
    say(log, 3, tx("[vpn] the VPN Gate helper did not start."));
    return false;
}

// the helper checks the config, runs OpenVPN and waits for its "Initialization Sequence Completed". true = tunnel up
bool EgressEngine::vgStart(const std::string& cfgText, const std::vector<std::string>& ips, int secs) {
    std::string ipList;
    for (const auto& ip : ips) ipList += (ipList.empty() ? "" : " ") + ip;
    std::string r = vgRequest("START " + base64Encode(ipList) + " " + base64Encode(cfgText) + " " + std::to_string(secs), (secs + 30) * 1000);
    logInfo("[vpn] helper: " + (r.empty() ? std::string("no answer") : r));
    return r == "OK";
}

// tears the tunnel down and removes its routes (the helper does both). Does nothing when no helper was started.
void EgressEngine::vgStop() {
    vpnUp_ = false;
    if (gVgStarted) vgRequest("STOP", 2000);
}

// the app is closing: stop the tunnel and let the helper exit
void EgressEngine::vgQuit() {
    vgStop();
    if (gVgStarted) { vgRequest("QUIT", 3000); gVgStarted = false; }
}

// the VPN Gate list: fresh from the API, else the last saved copy (the API is slow and sometimes down)
static bool vgServers(const std::string& stateDir, std::vector<VgServer>& out) {
    std::string cache = joinPath(stateDir, "vgate.csv");
    HttpResult r = httpGet(kVgApi, "", 60);
    if (r.ok && parseVpnGateCsv(r.body, out)) { writeFileText(cache, r.body); return true; }
    logWarn("[vpn] VPN Gate list download failed");
    return parseVpnGateCsv(readFileText(cache), out);
}

bool EgressEngine::vgSwitch(ProgressFn log) {
    say(log, 0, tx("[vpn] changing the {0} tunnel...", "VPNGATE"));
    std::vector<std::string> ips = ocIps();
    if (ips.empty()) {
        say(log, 3, tx("[vpn] could not resolve the OpenCode hosts (opencode.ai, models.opencode.ai, opentunnel.xyz). Check the internet connection."));
        return false;
    }
    logInfo("[vpn] opencode hosts resolve to " + std::to_string(ips.size()) + " addresses");
    std::string cc = upper(trim(cfg_->s("VPNGATE_COUNTRY")));
    if (cc == "-") cc.clear();
    int max = cfg_->i("VPNGATE_MAX"), timeout = cfg_->i("VPN_TIMEOUT");
    std::vector<VgServer> all;
    if (!vgServers(cfg_->dir(), all)) {
        say(log, 3, tx("[vpn] the VPN Gate list could not be downloaded and there is no saved copy."));
        return false;
    }
    std::vector<VgServer> cands = vgPick(all, failedVg_, cc, max);
    if (cands.empty()) {
        if (!cc.empty()) say(log, 3, tx("[vpn] no VPN Gate server matches the country \"{0}\". Clear the country to use any.", cc));
        else say(log, 3, tx("[vpn] nothing left to try: every VPN Gate server failed in this session."));
        return false;
    }
    cands.erase(std::remove_if(cands.begin(), cands.end(), [&](const VgServer& s) { return s.host == curName_; }), cands.end());
    if (cands.empty()) {
        vgStop(); curName_.clear();
        say(log, 3, tx("[vpn] nothing left to try: every VPN Gate server failed in this session."));
        return false;
    }
    if (!vgEnsure(log)) return false;
    // the exit IP to beat: OpenCode's host as seen from this PC right now (the old tunnel is still up until the switch)
    TraceInfo p0 = vgTrace();
    std::string prev = p0.ok ? p0.ip : "";
    int tried = 0;
    for (const VgServer& s : cands) {
        ++tried;
        say(log, 0, tx("[vpn] trying {0} ...", s.host));
        vgStop();
        std::string raw = vgHostOk(s.host) ? base64Decode(s.b64) : "";   // the host names a file: only plain names
        if (raw.empty()) { failedVg_.insert(s.host); logWarn("[vpn] skipped a server with an unusable name or config"); continue; }
        OvpnBuilt built = buildOvpn(raw, ips, resolveAll);
        logInfo(fmt("[vpn] config %s: %d opencode routes", s.host.c_str(), built.routes));
        if (!vgStart(built.text, ips, timeout)) { failedVg_.insert(s.host); logWarn("[vpn] failed " + s.host + ": tunnel did not start"); vgStop(); continue; }
        curName_ = s.host;
        TraceInfo t;
        int w = waitNewIp(prev, timeout, [&] { return vgTrace(); }, &t);
        if (w == 0) {
            vpnUp_ = true;
            st_->nodeOptions = "--no-network-family-autoselection --dns-result-order=ipv4first";
            say(log, 1, tx("[vpn] tunnel \"{0}\" is up. Exit IP {1} (country {2}).", {s.host, t.ip, t.loc}));
            return true;
        }
        failedVg_.insert(s.host);
        if (w == 1) say(log, 2, tx("[vpn] {0} left the same exit IP, next one.", s.host));
        else say(log, 2, tx("[vpn] {0} gave no answer in {1}s, next one.", s.host, std::to_string(timeout)));
        logWarn("[vpn] failed " + s.host + (w == 1 ? ": same exit IP" : ": no answer"));
        vgStop();
    }
    vgStop(); curName_.clear();
    say(log, 3, tx("[vpn] no tunnel gave a new IP ({0} tried). Log: {1}", std::to_string(tried), logPathOf(cfg_)));
    return false;
}

// ---------------------------------------------------------------- routes

bool EgressEngine::setMode(const std::string& name, ProgressFn log) {
    (void)log;
    Egress e = egressFromName(name);
    if (e != st_->mode) {
        // leaving a mode: stop what we own there
        if (st_->mode == Egress::Tor) torStop();
        if (st_->mode == Egress::Wireproxy) { wgStop(); curName_.clear(); }
        if (st_->mode == Egress::VpnGate) { vgStop(); curName_.clear(); }
    }
    st_->nodeOptions.clear();
    st_->mode = e;
    st_->proxyUrl.clear();
    st_->activeProxy.clear();
    return true;
}

bool EgressEngine::up(ProgressFn log) {
    st_->proxyUrl.clear();
    switch (st_->mode) {
        case Egress::Warp:
            if (!warpUp(log)) return false;
            st_->proxyUrl = fmt("http://127.0.0.1:%d", cfg_->i("PROXY_PORT"));
            return true;
        case Egress::Tor:
            if (!torReady(log)) return false;
            st_->proxyUrl = fmt("http://127.0.0.1:%d", cfg_->i("TOR_HTTP_PORT"));
            return true;
        case Egress::Proxy:
            return proxyPick(log);
        case Egress::Wireproxy:
            if (!wgSwitch(log)) return false;      // a fresh start always switches to the next .conf
            st_->proxyUrl = fmt("http://127.0.0.1:%d", wpPort_);
            return true;
        case Egress::VpnGate:
            return vgSwitch(log);                  // no proxy: the OS routes OpenCode's hosts into the tunnel
        default:
            return true;
    }
}

// A rotation counts only when the exit IP really changed (sameIp: IPv4 whole, IPv6 /64).
bool EgressEngine::rotate(ProgressFn log) {
    // nothing to retry: no route, or a Tor this launcher cannot restart
    if (st_->mode == Egress::None || (st_->mode == Egress::Tor && !st_->ourTor)) return rotateRoute(log);
    int tries = cfg_->i("ROTATE_TRIES_MAX");
    int cooldown = cfg_->i("ROTATE_COOLDOWN");
    int64_t t0 = nowSeconds();
    std::string before = st_->lastIp, reason;
    TraceInfo t;
    int attempt = 0;
    bool ok = false;
    while (!ok && attempt < tries) {
        if (attempt++ > 0) Sleep(cooldown * 1000);   // Cloudflare throttles rapid registrations
        if (!rotateRoute(log)) { reason = "the route did not come up"; continue; }
        // WARP can keep the old exit a few seconds after reconnecting: poll once a second
        int64_t deadline = nowSeconds() + (st_->mode == Egress::Warp ? cfg_->i("WARP_WAIT") : 0);
        for (;;) {
            t = trace();
            if ((t.ok && !sameIp(t.ip, before)) || nowSeconds() >= deadline) break;
            Sleep(1000);
        }
        if (!t.ok) reason = "the new route does not answer";
        else if (sameIp(t.ip, before)) reason = "the exit IP did not change";
        else { reason = "new IP"; ok = true; }
        if (!ok) say(log, 2, fmt("  attempt %d/%d: %s", attempt, tries, reason.c_str()));
    }
    say(log, ok ? 1 : 2, fmt("rotation %s: %s -> %s, %d attempt(s), %llds, %s",
                             ok ? "done" : "failed", before.empty() ? "?" : before.c_str(),
                             t.ip.empty() ? "?" : t.ip.c_str(), attempt,
                             (long long)(nowSeconds() - t0), reason.c_str()));
    if (ok) { st_->lastIp = t.ip; st_->lastLoc = t.loc; }
    return ok;
}

bool EgressEngine::rotateRoute(ProgressFn log) {
    switch (st_->mode) {
        case Egress::Warp:
            if (!warpRotate(log)) return false;
            st_->proxyUrl = fmt("http://127.0.0.1:%d", cfg_->i("PROXY_PORT"));
            return true;
        case Egress::Tor:
            if (!torRotate(log)) return false;
            st_->proxyUrl = fmt("http://127.0.0.1:%d", cfg_->i("TOR_HTTP_PORT"));
            return true;
        case Egress::Proxy:
            if (trim(cfg_->s("PROXY_FIXED")).empty() && poolUse(log)) return true;
            return proxyPick(log);
        case Egress::Wireproxy:
            if (poolUse(log)) return true;
            if (!wgSwitch(log)) return false;
            st_->proxyUrl = fmt("http://127.0.0.1:%d", wpPort_);
            return true;
        case Egress::VpnGate:
            if (poolUse(log)) return true;
            return vgSwitch(log);
        default:
            return false;
    }
}

TraceInfo EgressEngine::trace(int timeoutSec) const {
    if (st_->mode == Egress::VpnGate) return vgTrace();   // only OpenCode's hosts are routed: ask one of them
    return traceVia(st_->proxyUrl, timeoutSec);
}

bool EgressEngine::routeOk(const TraceInfo& t) const {
    if (!t.ok) return false;
    if (st_->mode == Egress::Warp) return t.warp == "on" || t.warp == "plus";
    return true;
}

bool EgressEngine::targetMatch(const std::string& ip, const std::string& loc) const {
    std::string c = cfg_->s("TARGET_COUNTRY");
    if (!c.empty() && upper(loc) != upper(c)) return false;
    std::string p = cfg_->s("TARGET_PREFIX");
    if (!p.empty() && ip.compare(0, p.size(), p) != 0) return false;
    return true;
}

// ---------------------------------------------------------------- probe

bool EgressEngine::probeClassifyLimit(const std::string& text) {
    static const char* pats[] = {
        "free usage limit", "usage limit reached", "out of usage",
        "insufficient credits", "payment required", "rate limit"
    };
    std::string l = lower(text);
    for (const char* p : pats) if (l.find(p) != std::string::npos) return true;
    return false;
}

int EgressEngine::probe(ProgressFn log, const std::string& cli, const std::string& model) {
    if (!cfg_->b("PROBE")) return 0;
    if (cli.empty()) {
        say(log, 0, "no OpenCode CLI found next to the desktop app, so the IP probe is skipped.");
        return 0;   // no verdict available: treat the route as usable
    }
    std::string logFile = joinPath(userProfile(), ".local\\share\\opencode\\log\\opencode.log");
    int64_t offset = fileSizeOf(logFile);

    EnvList env;
    if (!st_->proxyUrl.empty()) {
        env.push_back({"HTTP_PROXY", st_->proxyUrl});
        env.push_back({"HTTPS_PROXY", st_->proxyUrl});
        env.push_back({"http_proxy", st_->proxyUrl});
        env.push_back({"https_proxy", st_->proxyUrl});
    } else {
        env.push_back({"HTTP_PROXY", ""});
        env.push_back({"HTTPS_PROXY", ""});
    }
    say(log, 0, model.empty() ? std::string("probing the new IP with the chat model...")
                              : fmt("probing the new IP with %s...", model.c_str()));
    // --standalone: the shared server ignores the proxy env, so without it the probe would test the wrong route
    std::string margs = model.empty() ? std::string() : "--model " + quoteArg(model) + " ";
    RunResult r = runCapture(cli, fmt("run --standalone --format json %s--auto \"reply with the word ok\"", margs.c_str()),
                             env, 120000, userProfile());

    // v3.4.5: delete the session this probe created, the same way opencode-infinite.sh does.
    // The id is the first ses_ token in the JSON output. Without this every probe left a chat behind.
    {
        size_t p = r.out.find("ses_");
        if (p != std::string::npos) {
            size_t e = p + 4;
            while (e < r.out.size()) {
                char c = r.out[e];
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
                if (!ok) break;
                ++e;
            }
            std::string sid = r.out.substr(p, e - p);
            if (sid.size() > 4) runCapture(cli, "session delete " + sid, env, 30000, userProfile());
        }
    }

    std::string delta = readFileFrom(logFile, offset);
    bool limit = probeClassifyLimit(r.out) || probeClassifyLimit(r.err) || probeClassifyLimit(delta);
    if (limit) return 1;
    std::string all = lower(r.out + r.err + delta);
    if (all.find("modelnotfound") != std::string::npos || all.find("model not found") != std::string::npos || all.find("model unavailable") != std::string::npos) {
        say(log, 2, fmt("  the probe model %s does not exist.", model.c_str()));
        return 3;
    }
    if (r.exitCode == 0) return 0;
    // the start of the error, without colour codes, so the log says why the probe failed
    const std::string& why = r.err.empty() ? r.out : r.err;
    std::string clean;
    for (size_t k = 0; k < why.size() && clean.size() < 160; ++k) {
        char c = why[k];
        if (c == '\x1b') { while (k < why.size() && !((why[k] >= 'a' && why[k] <= 'z') || (why[k] >= 'A' && why[k] <= 'Z'))) ++k; continue; }
        clean += (c == '\r' || c == '\n') ? ' ' : c;
    }
    say(log, 2, fmt("  probe exit %d: %s", r.exitCode, clean.c_str()));
    return 2;
}

// ---------------------------------------------------------------- hunt

bool EgressEngine::hunt(ProgressFn log, const std::string& cli) {
    if (st_->mode == Egress::None) {
        say(log, 2, "the connection is NONE - there is nothing to rotate.");
        return false;
    }
    bool goal = !cfg_->s("TARGET_COUNTRY").empty() || !cfg_->s("TARGET_PREFIX").empty();
    int interval = goal ? cfg_->i("TARGET_INTERVAL") : cfg_->i("ROTATE_COOLDOWN");
    const int tryMax = cfg_->i("TARGET_TRIES");
    const ULONGLONG limitMs = (ULONGLONG)cfg_->i("TARGET_MINUTES") * 60000;
    const ULONGLONG t0 = GetTickCount64();
    cancelHunt_ = false;
    int burnedLimit = cfg_->i("IP_FIND_MAX");
    int brokenMax = cfg_->i("PROBE_BROKEN_MAX");
    int proxyRotMax = cfg_->i("PROXY_ROT_MAX");

    int burned = 0, broken = 0;
    std::string startIp = st_->lastIp;   // rotate() moves lastIp on, keep the IP the hunt left

    for (int i = 1; !cancelHunt_; ++i) {
        if (i > tryMax) { say(log, 3, fmt("attempt limit reached: %d attempts, no match.", tryMax)); return false; }
        if (GetTickCount64() - t0 >= limitMs) { say(log, 3, fmt("time limit reached: %d min, %d attempts, no match.", (int)(limitMs / 60000), i - 1)); return false; }
        say(log, 0, fmt("[%d/%d] rotating...", i, tryMax));
        if (!rotate(log)) {
            say(log, 2, "  rotation failed.");
            Sleep(interval * 1000);
            continue;
        }
        TraceInfo t = trace();
        if (!t.ok || !routeOk(t)) {
            say(log, 2, "  the new route does not answer.");
            Sleep(interval * 1000);
            continue;
        }
        say(log, 1, fmt("  exit IP %s (country %s)", t.ip.c_str(), t.loc.c_str()));
        if (sameIp(t.ip, startIp)) {
            say(log, 2, "  back on the IP the hunt started from, rotating again...");
            Sleep(interval * 1000);
            continue;
        }
        if (!targetMatch(t.ip, t.loc)) {
            say(log, 0, "  not the target, rotating again...");
            Sleep(interval * 1000);
            continue;
        }
        int p = probe(log, cli, cfg_->s("PROBE_MODEL"));
        if (p == 3) { say(log, 3, "set Probe model in Settings to a model that exists."); return false; }
        if (p == 0) {
            st_->lastIp = t.ip;
            st_->lastLoc = t.loc;
            logInfo(fmt("accepted %s %s", t.ip.c_str(), t.loc.c_str()));
            say(log, 1, fmt("accepted %s (%s)", t.ip.c_str(), t.loc.c_str()));
            return true;
        }
        if (p == 1) {
            ++burned;
            say(log, 2, "  this IP already hit the limit, rotating again...");
            if (burnedLimit > 0 && burned >= burnedLimit) {
                say(log, 3, "the burned-IP limit was reached.");
                return false;
            }
            if (st_->mode == Egress::Proxy && burned >= proxyRotMax) {
                burned = 0;
                say(log, 2, "too many burned proxies in a row.");
            }
        } else {
            ++broken;
            say(log, 3, fmt("  the probe failed for a reason that is not a limit (%d of %d)", broken, brokenMax));
            if (broken >= brokenMax) {
                say(log, 3, "the probe looks broken - check Probe model in Settings.");
                return false;
            }
        }
        Sleep(interval * 1000);
    }
    say(log, 2, "the hunt was cancelled.");
    return false;
}

void EgressEngine::shutdown() {
    if (st_->mode == Egress::Tor || st_->ourTor) torStop();
    wgStop();
    vgQuit();
    if (bridge_) { bridge_->stop(); bridge_.reset(); }
}

// ---------------------------------------------------------------- IP pool
// Routes that worked: PROXY (host:port), WIREGUARD (.conf name), VPNGATE (server host).
// File <cfg dir>/ip_pool.txt, one tab-separated line each: mode, id, ip, loc.

namespace {
struct PoolItem { std::string mode, id, ip, loc; };
std::mutex gPoolMtx;

std::string poolFile(const Config* cfg) { return joinPath(cfg->dir(), "ip_pool.txt"); }

std::vector<PoolItem> poolLoad(const Config* cfg) {
    std::vector<PoolItem> v;
    for (const auto& line : split(readFileText(poolFile(cfg)), '\n')) {
        std::vector<std::string> f = split(trim(line), '\t');
        if (f.size() == 4 && !f[0].empty() && !f[1].empty()) v.push_back({f[0], f[1], f[2], f[3]});
    }
    return v;
}

bool poolStore(const Config* cfg, const std::vector<PoolItem>& v) {
    std::string out;
    for (const auto& p : v) out += p.mode + "\t" + p.id + "\t" + p.ip + "\t" + p.loc + "\r\n";
    return writeFileText(poolFile(cfg), out);
}

bool poolHas(const std::vector<PoolItem>& v, const PoolItem& it) {
    for (const auto& p : v)
        if (p.mode == it.mode && (p.id == it.id || (!it.ip.empty() && p.ip == it.ip))) return true;
    return false;
}

// takes the first saved route of this mode whose exit IP is not the current one
bool poolTake(const Config* cfg, const std::string& mode, const std::string& curIp, PoolItem& out) {
    std::lock_guard<std::mutex> lk(gPoolMtx);
    std::vector<PoolItem> v = poolLoad(cfg);
    for (size_t i = 0; i < v.size(); ++i) {
        if (v[i].mode != mode || sameIp(v[i].ip, curIp)) continue;
        out = v[i];
        v.erase(v.begin() + (long)i);
        poolStore(cfg, v);
        return true;
    }
    return false;
}

// keeps at most max routes per mode, dropping the oldest
bool poolAdd(const Config* cfg, const PoolItem& it, int max) {
    std::lock_guard<std::mutex> lk(gPoolMtx);
    std::vector<PoolItem> v = poolLoad(cfg);
    if (poolHas(v, it)) return false;
    v.push_back(it);
    int n = 0;
    for (const auto& p : v) if (p.mode == it.mode) ++n;
    for (size_t i = 0; n > max && i < v.size();) {
        if (v[i].mode == it.mode) { v.erase(v.begin() + (long)i); --n; }
        else ++i;
    }
    if (!poolStore(cfg, v)) return false;
    return true;
}
} // namespace

std::string EgressEngine::wgConfPath(const std::string& name) const {
    std::string dir = trim(cfg_->s("WG_DIR"));
    if (dir.empty() || dir == "-") dir = joinPath(cfg_->dir(), "wireguard");
    return joinPath(dir, name + ".conf");
}

// one WireGuard config up through its own wireproxy (no search)
bool EgressEngine::wgUseConf(const std::string& name, const std::string& path, ProgressFn log) {
    std::string exe = wpExe(log);
    if (exe.empty()) return false;
    wgStop();
    int port = 0;
    for (int p = 25345; p < 25355 && !port; ++p) if (portFree(p)) port = p;
    if (!port || !wpStart(exe, path, port)) { wgStop(); return false; }
    curName_ = name;
    st_->proxyUrl = fmt("http://127.0.0.1:%d", port);
    return true;
}

// one VPN Gate server up from a saved .ovpn (no search); the helper is started on first use, like vgSwitch
bool EgressEngine::vgUseHost(const std::string& host, const std::string& cfgPath, const std::vector<std::string>& ips, ProgressFn log) {
    if (!vgEnsure(log)) return false;
    vgStop();
    if (!vgStart(readFileText(cfgPath), ips, cfg_->i("VPN_TIMEOUT"))) {
        logWarn("[vpn] failed " + host + ": tunnel did not start");
        vgStop();
        return false;
    }
    curName_ = host;
    vpnUp_ = true;
    st_->nodeOptions = "--no-network-family-autoselection --dns-result-order=ipv4first";
    return true;
}

// rotation: a saved route of the current mode, if any; false = search for a new one as before
bool EgressEngine::poolUse(ProgressFn log) {
    if (!cfg_->b("POOL_ENABLE")) return false;
    std::string mode = egressName(st_->mode);
    PoolItem it;
    while (poolTake(cfg_, mode, st_->lastIp, it)) {
        bool ok = false;
        if (st_->mode == Egress::Proxy) {
            st_->activeProxy = it.id;
            st_->proxyUrl = "http://" + it.id;
            ok = true;           // the rotation checks the exit IP next
        } else if (st_->mode == Egress::Wireproxy) {
            std::string path = wgConfPath(it.id);
            ok = fileExists(path) && wgUseConf(it.id, path, log);
        } else if (st_->mode == Egress::VpnGate) {
            std::string path = joinPath(joinPath(cfg_->dir(), "vgate"), it.id + ".ovpn");
            ok = fileExists(path) && vgUseHost(it.id, path, ocIps(), log);
        }
        if (ok) {
            say(log, 1, fmt("pool: using the saved %s route %s (%s).", mode.c_str(), it.id.c_str(), it.ip.c_str()));
            return true;
        }
        say(log, 2, fmt("pool: saved route %s is not usable, next one.", it.id.c_str()));
    }
    return false;
}

// background worker: tests one new candidate and keeps it when its IP is new and the probe accepts it
bool EgressEngine::poolFillOne(ProgressFn log, const std::string& cli, const std::string& curIp, bool useProbe) {
    std::string mode = egressName(st_->mode);
    int max = cfg_->i("POOL_MAX");
    auto keep = [&](const std::string& id, const TraceInfo& t) -> bool {
        if (!t.ok || sameIp(t.ip, curIp)) return false;
        PoolItem it{mode, id, t.ip, t.loc.empty() ? std::string("-") : t.loc};
        {
            std::lock_guard<std::mutex> lk(gPoolMtx);
            if (poolHas(poolLoad(cfg_), it)) return false;      // already saved: no probe spent on it
        }
        if (useProbe && !cli.empty() && probe(log, cli, cfg_->s("PROBE_MODEL")) != 0) return false;
        if (!poolAdd(cfg_, it, max)) return false;
        say(log, 1, fmt("pool: saved %s %s (%s).", mode.c_str(), id.c_str(), it.ip.c_str()));
        return true;
    };

    if (st_->mode == Egress::Proxy) {
        std::string src = cfg_->s("PROXY_LIST_URL"), raw;
        if (fileExists(src)) raw = readFileText(src);
        else {
            HttpResult r = httpGet(src, "", 20);
            if (!r.ok) return false;
            raw = r.body;
        }
        std::vector<std::string> list;
        if (!parseProxies(raw, list)) return false;
        std::mt19937 rng((unsigned)GetTickCount64());
        std::shuffle(list.begin(), list.end(), rng);
        int tryMax = cfg_->i("PROXY_TRY_MAX"), timeout = cfg_->i("PROXY_PROBE_TIMEOUT"), tries = 0;
        for (const auto& p : list) {
            if (poolTried_.count(p)) continue;
            if (cancelHunt_ || ++tries > tryMax) break;
            poolTried_.insert(p);
            st_->proxyUrl = "http://" + p;
            if (keep(p, trace(timeout))) { st_->proxyUrl.clear(); return true; }
        }
        st_->proxyUrl.clear();
        return false;
    }

    if (st_->mode == Egress::Wireproxy) {
        std::string dir = trim(cfg_->s("WG_DIR"));
        if (dir.empty() || dir == "-") dir = joinPath(cfg_->dir(), "wireguard");
        for (const auto& f : listDir(dir, false)) {
            if (cancelHunt_) break;
            if (f.size() < 6 || !iequals(f.substr(f.size() - 5), ".conf")) continue;
            std::string name = f.substr(0, f.size() - 5), path = joinPath(dir, f);
            if (poolTried_.count(name) || !wgNameOk(name) || fileSizeOf(path) == 0) continue;
            poolTried_.insert(name);
            if (!wgConfValid(readFileText(path))) continue;
            if (!wgUseConf(name, path, log)) { wgStop(); continue; }
            bool kept = keep(name, trace(8));
            wgStop();
            curName_.clear();
            st_->proxyUrl.clear();
            if (kept) return true;
        }
        return false;
    }

    if (st_->mode == Egress::VpnGate) {
        if (tunnelUp()) return false;          // never touch the routes of a tunnel that is in use
        std::vector<std::string> ips = ocIps();
        if (ips.empty()) return false;
        std::string cc = upper(trim(cfg_->s("VPNGATE_COUNTRY")));
        if (cc == "-") cc.clear();
        std::vector<VgServer> all;
        if (!vgServers(cfg_->dir(), all)) return false;
        std::string cfgDir = joinPath(cfg_->dir(), "vgate");
        makeDirs(cfgDir);
        for (const VgServer& s : vgPick(all, poolTried_, cc, cfg_->i("VPNGATE_MAX"))) {
            if (cancelHunt_) break;
            poolTried_.insert(s.host);
            std::string raw = vgHostOk(s.host) ? base64Decode(s.b64) : std::string();
            if (raw.empty()) continue;
            std::string path = joinPath(cfgDir, s.host + ".ovpn");
            writeFileText(path, buildOvpn(raw, ips, resolveAll).text);
            if (!vgUseHost(s.host, path, ips, log)) continue;
            bool kept = keep(s.host, vgTrace());
            vgStop();
            if (kept) return true;
        }
        return false;
    }
    return false;
}

} // namespace oi

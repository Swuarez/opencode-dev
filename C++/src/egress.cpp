// egress.cpp
#include "egress.h"
#include "http.h"
#include "proc.h"
#include "util.h"
#include "log.h"
#include "json.h"

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <algorithm>
#include <random>
#include <cctype>
#include <thread>

#pragma comment(lib, "ws2_32.lib")

namespace oi {

static const char* kTraceUrl = "https://www.cloudflare.com/cdn-cgi/trace";
static const char* kTorCheckUrl = "https://check.torproject.org/api/ip";

const char* egressName(Egress e) {
    switch (e) {
        case Egress::Warp: return "WARP";
        case Egress::Tor: return "TOR";
        case Egress::Proxy: return "PROXY";
        default: return "NONE";
    }
}

Egress egressFromName(const std::string& s) {
    std::string v = upper(trim(s));
    if (v == "WARP") return Egress::Warp;
    if (v == "TOR") return Egress::Tor;
    if (v == "PROXY") return Egress::Proxy;
    return Egress::None;
}

EgressEngine::EgressEngine(Config* cfg, EgressState* st) : cfg_(cfg), st_(st) {}
EgressEngine::~EgressEngine() { shutdown(); }

// ---------------------------------------------------------------- helpers

bool EgressEngine::portOpen(uint16_t port, int timeoutMs) const {
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

bool EgressEngine::warpUp(ProgressFn log) {
    if (!warpAvailable()) { say(log, 3, "warp-cli missing"); return false; }
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

// ---------------------------------------------------------------- routes

bool EgressEngine::setMode(const std::string& name, ProgressFn log) {
    (void)log;
    Egress e = egressFromName(name);
    if (e != st_->mode) {
        // leaving a mode: stop what we own there
        if (st_->mode == Egress::Tor) torStop();
    }
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
            return proxyPick(log);
        default:
            return false;
    }
}

TraceInfo EgressEngine::trace(int timeoutSec) const {
    TraceInfo t;
    HttpResult r = httpGet(kTraceUrl, st_->proxyUrl, timeoutSec);
    if (!r.ok) return t;
    t.raw = r.body;
    for (const auto& line : split(r.body, '\n')) {
        std::string l = trim(line);
        if (startsWith(l, "ip=")) t.ip = l.substr(3);
        else if (startsWith(l, "loc=")) t.loc = l.substr(4);
        else if (startsWith(l, "warp=")) t.warp = l.substr(5);
    }
    t.ok = !t.ip.empty();
    return t;
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
    say(log, 0, fmt("probing the new IP with %s...", model.c_str()));
    RunResult r = runCapture(cli, fmt("run --format json --model %s --auto \"reply with the word ok\"", quoteArg(model).c_str()),
                             env, 120000, userProfile());

    std::string delta = readFileFrom(logFile, offset);
    bool limit = probeClassifyLimit(r.out) || probeClassifyLimit(r.err) || probeClassifyLimit(delta);
    if (limit) return 1;
    if (r.exitCode == 0) return 0;
    return 2;
}

// ---------------------------------------------------------------- hunt

bool EgressEngine::hunt(ProgressFn log, const std::string& cli) {
    if (st_->mode == Egress::None) {
        say(log, 2, "the connection is NONE - there is nothing to rotate.");
        return false;
    }
    bool goal = !cfg_->s("TARGET_COUNTRY").empty() || !cfg_->s("TARGET_PREFIX").empty();
    int tries = goal ? cfg_->i("TARGET_TRIES") : cfg_->i("ROTATE_TRIES_MAX");
    int interval = goal ? cfg_->i("TARGET_INTERVAL") : cfg_->i("ROTATE_COOLDOWN");
    int minutes = cfg_->i("TARGET_MINUTES");
    int burnedLimit = cfg_->i("IP_FIND_MAX");
    int brokenMax = cfg_->i("PROBE_BROKEN_MAX");
    int proxyRotMax = cfg_->i("PROXY_ROT_MAX");

    int64_t start = nowSeconds();
    int burned = 0, broken = 0;
    std::string startIp = st_->lastIp;   // rotate() moves lastIp on, keep the IP the hunt left

    for (int i = 1; i <= tries; ++i) {
        if (goal && nowSeconds() - start > (int64_t)minutes * 60) {
            say(log, 2, "the hunt ran out of time.");
            return false;
        }
        say(log, 0, fmt("[%d/%d] rotating...", i, tries));
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
    say(log, 2, "the hunt gave up without a usable IP.");
    return false;
}

void EgressEngine::shutdown() {
    if (st_->mode == Egress::Tor || st_->ourTor) torStop();
    if (bridge_) { bridge_->stop(); bridge_.reset(); }
}

} // namespace oi

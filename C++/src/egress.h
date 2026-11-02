#pragma once
// egress.h - exit-route control: WARP, Tor, free proxy lists, WireGuard (wireproxy), VPN Gate (OpenVPN), direct.
#include <string>
#include <functional>
#include <memory>
#include <set>
#include <vector>

#include "config.h"
#include "torbridge.h"

namespace oi {

enum class Egress { None, Warp, Tor, Proxy, Wireproxy, VpnGate };

const char* egressName(Egress e);
Egress      egressFromName(const std::string& s);

struct EgressState {
    Egress      mode = Egress::None;
    std::string proxyUrl;      // http://127.0.0.1:40000  (empty when direct)
    std::string activeProxy;   // host:port, PROXY mode only
    std::string lastIp;
    std::string lastLoc;
    bool warpFound = false;
    bool torFound = false;
    bool ourTor = false;       // this launcher started Tor
    std::string nodeOptions;   // VPNGATE: IPv4-first for Node children (the .bat sets NODE_OPTIONS)
};

// kind: 0 info, 1 ok, 2 warn, 3 error
using ProgressFn = std::function<void(int kind, const std::string& msg)>;

struct TraceInfo {
    bool ok = false;
    std::string ip;
    std::string loc;
    std::string warp;      // "on" / "plus" / "off"
    std::string raw;
};

class EgressEngine {
public:
    EgressEngine(Config* cfg, EgressState* st);
    ~EgressEngine();

    void detectTools();

    bool setMode(const std::string& name, ProgressFn log);   // WARP/TOR/PROXY/WIREGUARD/VPNGATE/NONE
    bool up(ProgressFn log);                                  // bring the mode up
    bool rotate(ProgressFn log);                              // one new route

    TraceInfo trace(int timeoutSec = 15) const;
    bool  routeOk(const TraceInfo& t) const;
    bool  targetMatch(const std::string& ip, const std::string& loc) const;

    // 0 = usable, 1 = burned (limit answer), 2 = probe itself broken
    int probe(ProgressFn log, const std::string& cli, const std::string& model);

    // Rotate until the target matches and the probe accepts. false = gave up.
    bool hunt(ProgressFn log, const std::string& cli);

    void shutdown();

    std::string torDir() const;
    std::string torLogPath() const;

private:
    bool rotateRoute(ProgressFn log);                        // one mode-specific rotation, unchecked
    bool warpAvailable() const;
    bool warpCall(const std::string& args, int timeoutSec, std::string* out = nullptr) const;
    bool warpUp(ProgressFn log);
    bool warpRotate(ProgressFn log);
    bool warpCheck(std::string* ip) const;

    bool torSocksUp() const;
    bool torStart(ProgressFn log);
    void torStop();
    bool torRotate(ProgressFn log);
    bool torReady(ProgressFn log);
    bool torInstall(ProgressFn log);
    std::string torExePath() const;

    bool proxyPick(ProgressFn log);
    static bool parseProxies(const std::string& text, std::vector<std::string>& out);

    // WireGuard through wireproxy (.bat: OC_VPN_PS). A local HTTP proxy, no adapter, no administrator prompt.
    bool wgSwitch(ProgressFn log);
    void wgStop();
    std::string wpExe(ProgressFn log);
    bool wpStart(const std::string& exe, const std::string& confPath, int port);

    // VPN Gate through OpenVPN (.bat: OC_VGATE_PS). Only OpenCode's hosts are routed into the tunnel.
    bool vgSwitch(ProgressFn log);
    void vgStop();
    std::string ovpnExe(ProgressFn log);
    bool vgTunStart(const std::string& exe, const std::string& cfg, int secs);
    TraceInfo vgTrace() const;
    std::vector<std::string> ocIps() const;

    bool portOpen(uint16_t port, int timeoutMs) const;
    static bool probeClassifyLimit(const std::string& text);

    Config* cfg_;
    EgressState* st_;
    std::unique_ptr<SocksBridge> bridge_;
    uint32_t torPid_ = 0;

    // VPN state. Failures count for this launcher session only (the .bat keeps them in vpn_failed.txt per session).
    std::set<std::string> failedWg_, failedVg_;
    std::string curName_;          // active .conf / VPN Gate host
    uint32_t wpPid_ = 0;  void* wpProc_ = nullptr;  int wpPort_ = 0;
    uint32_t ovPid_ = 0;  void* ovProc_ = nullptr;
    bool vgRoutesSet_ = false;
};

} // namespace oi

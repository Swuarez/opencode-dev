// watcher.cpp
#include "watcher.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace oi {

static const char* kLimitWords[] = {
    "failed to drain session", "free usage limit", "usage limit reached",
    "rate limit", "out of usage", "insufficient credits", "payment required"
};

bool LogWatcher::lineHasFatal(const std::string& line) {
    std::string l = lower(line);
    size_t e = l.find("level=error");
    if (e == std::string::npos) return false;
    std::string after = l.substr(e);
    for (const char* w : kLimitWords) if (after.find(w) != std::string::npos) return true;
    return false;
}

LogWatcher::~LogWatcher() { stop(); }

void LogWatcher::start(const WatchConfig& wc, HitFn onHit, WarnFn onWarn) {
    if (running_) return;
    wc_ = wc;
    onHit_ = onHit;
    onWarn_ = onWarn;
    offset_ = wc.startOffset;
    running_ = true;
    thread_ = std::thread(&LogWatcher::loop, this);
}

void LogWatcher::stop() {
    if (!running_) return;
    running_ = false;
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
}

static bool tcpProbe(const std::string& hostPort, int timeoutMs) {
    std::string hp = hostPort;
    size_t scheme = hp.find("://");
    if (scheme != std::string::npos) hp = hp.substr(scheme + 3);
    size_t colon = hp.rfind(':');
    if (colon == std::string::npos) return false;
    std::string host = hp.substr(0, colon);
    int port = atoi(hp.substr(colon + 1).c_str());
    if (port <= 0) return false;

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons((u_short)port);
    if (inet_pton(AF_INET, host.c_str(), &sa.sin_addr) != 1) { closesocket(s); return false; }
    DWORD tv = timeoutMs;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (char*)&tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (char*)&tv, sizeof(tv));
    bool ok = connect(s, (sockaddr*)&sa, sizeof(sa)) == 0;
    closesocket(s);
    return ok;
}

void LogWatcher::loop() {
    logInfo(fmt("watcher started on %s from offset %lld", wc_.logFile.c_str(), (long long)offset_));
    int tick = 0;
    int proxyFails = 0;

    while (running_) {
        {
            std::unique_lock<std::mutex> lk(mtx_);
            cv_.wait_for(lk, std::chrono::seconds(2), [this] { return !running_.load(); });
        }
        if (!running_) break;

        ++tick;
        if (tick % 30 == 0 && !wc_.probeHostPort.empty()) {
            if (tcpProbe(wc_.probeHostPort, 2500)) proxyFails = 0;
            else if (++proxyFails >= 3) {
                proxyFails = 0;
                if (onWarn_) onWarn_(fmt("the egress proxy stopped answering: %s", wc_.probeHostPort.c_str()));
                logWarn("egress proxy stopped answering");
            }
        }

        std::string delta = readFileFrom(wc_.logFile, offset_);
        if (delta.empty()) continue;
        offset_ += (int64_t)delta.size();
        if (!lineHasFatal(delta)) continue;

        // a fatal line often scrolls past a chat that recovers on its own:
        // settle, then look at what followed the error.
        {
            std::unique_lock<std::mutex> lk(mtx_);
            cv_.wait_for(lk, std::chrono::seconds(4), [this] { return !running_.load(); });
        }
        if (!running_) break;

        std::string after = readFileFrom(wc_.logFile, offset_);
        offset_ += (int64_t)after.size();
        std::string all = delta + after;

        auto lines = split(all, '\n');
        int lastFatal = -1;
        for (size_t i = 0; i < lines.size(); ++i) if (lineHasFatal(lines[i])) lastFatal = (int)i;

        bool recovered = false;
        for (size_t i = (size_t)(lastFatal + 1); i < lines.size(); ++i) {
            std::string l = lower(lines[i]);
            if (l.find("level=info") != std::string::npos || l.find("level=debug") != std::string::npos) {
                recovered = true;
                break;
            }
        }
        if (recovered) {
            logInfo("the limit error was followed by normal activity; leaving the session alone");
            continue;
        }
        logInfo("a stuck limit error was confirmed in the OpenCode log");
        if (onHit_) onHit_();
        break;
    }
    logInfo("watcher stopped");
}

} // namespace oi

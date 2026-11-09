// watcher.cpp
#include "watcher.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <vector>
#include <algorithm>
#include <cstring>
#include <cctype>

#pragma comment(lib, "ws2_32.lib")

namespace oi {

// Same list names as patterns.conf in the .bat/.sh: rotate= rotates alone (usage limit),
// ask= asks the user first (rate limit). Compaction / context length are in neither: no rotation.
static const char* kRotateWords[] = {
    "free usage limit", "usage limit reached",
    "out of usage", "insufficient credits", "payment required"
};
static const char* kAskWords[] = {
    "rate limit", "rate_limit_exceeded", "too many requests", "429"
};

static bool hasWord(const std::string& s, const char* w) {
    size_t n = strlen(w);
    bool digits = std::all_of(w, w + n, [](char c) { return c >= '0' && c <= '9'; });
    for (size_t p = s.find(w); p != std::string::npos; p = s.find(w, p + 1)) {
        if (!digits) return true;
        // a bare status code must not be part of a longer number (pid=14290)
        bool before = p > 0 && isdigit((unsigned char)s[p - 1]);
        bool afterD = p + n < s.size() && isdigit((unsigned char)s[p + n]);
        if (!before && !afterD) return true;
    }
    return false;
}

int LogWatcher::lineKind(const std::string& line, const std::string& sinceUtc) {
    // the OpenCode log is shared by every run: an error stamped before this start is an old one
    if (!sinceUtc.empty()) {
        size_t t = line.find("timestamp=");
        if (t != std::string::npos && line.substr(t + 10, 19) < sinceUtc) return 0;
    }
    std::string l = lower(line);
    size_t e = l.find("level=error");
    if (e == std::string::npos) return 0;
    std::string after = l.substr(e);
    for (const char* w : kRotateWords) if (hasWord(after, w)) return 1;
    for (const char* w : kAskWords) if (hasWord(after, w)) return 2;
    return 0;
}

bool LogWatcher::lineHasFatal(const std::string& line, const std::string& sinceUtc) { return lineKind(line, sinceUtc) != 0; }

LogWatcher::~LogWatcher() { stop(); }

void LogWatcher::start(const WatchConfig& wc, HitFn onHit, HitFn onAsk, WarnFn onWarn) {
    if (running_) return;
    wc_ = wc;
    onHit_ = onHit;
    onAsk_ = onAsk;
    onWarn_ = onWarn;
    offset_ = wc.startOffset;
    running_ = true;
    thread_ = std::thread(&LogWatcher::loop, this);
}

void LogWatcher::stop() {
    if (!running_) return;
    { std::lock_guard<std::mutex> lk(mtx_); running_ = false; }
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
        if (!lineHasFatal(delta, wc_.sinceUtc)) continue;

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
        for (size_t i = 0; i < lines.size(); ++i) if (lineHasFatal(lines[i], wc_.sinceUtc)) lastFatal = (int)i;

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
        bool usage = false;
        for (const auto& l : lines) if (lineKind(l, wc_.sinceUtc) == 1) usage = true;
        if (!usage) {
            // rate limit only: the app asks (at most once per 10 min); keep watching meanwhile
            logInfo("a stuck rate limit error was confirmed in the OpenCode log; asking, not rotating");
            if (onAsk_) onAsk_();
            continue;
        }
        logInfo("a stuck usage limit error was confirmed in the OpenCode log");
        if (onHit_) onHit_();
        break;
    }
    logInfo("watcher stopped");
}

} // namespace oi

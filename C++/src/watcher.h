#pragma once
// watcher.h - tails the OpenCode log while the app runs.
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>

namespace oi {

struct WatchConfig {
    std::string logFile;
    int64_t     startOffset = 0;
    std::string probeHostPort;   // "127.0.0.1:40000"; empty = no egress watchdog
};

class LogWatcher {
public:
    using HitFn = std::function<void()>;
    using WarnFn = std::function<void(const std::string&)>;

    ~LogWatcher();

    // onHit: usage limit (rotate, watcher stops). onAsk: rate limit only (ask, watcher goes on).
    void start(const WatchConfig& wc, HitFn onHit, HitFn onAsk, WarnFn onWarn);
    void stop();
    bool running() const { return running_; }

    // The fatal shape: level=ERROR on the line plus a quota/limit phrase.
    static bool lineHasFatal(const std::string& line);
    // 0 = none, 1 = usage limit (rotate=), 2 = rate limit (ask=).
    static int lineKind(const std::string& line);

private:
    void loop();

    WatchConfig wc_;
    HitFn onHit_;
    HitFn onAsk_;
    WarnFn onWarn_;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::mutex mtx_;
    std::condition_variable cv_;
    int64_t offset_ = 0;
};

} // namespace oi

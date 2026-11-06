#pragma once
// app.h - launcher state and the run / rotate / restart orchestration.
// The UI (ui.cpp) only reads this and calls the action methods; every slow
// step runs on one worker thread so the window never blocks.
#include <string>
#include <vector>
#include <deque>
#include <functional>
#include <memory>
#include <thread>
#include <mutex>
#include <atomic>
#include <condition_variable>
#include <queue>
#include <cstdint>

#include "config.h"
#include "egress.h"
#include "watcher.h"

namespace oi {

extern const char* kLauncherVersion;

enum class Screen {
    Home,        // landing page
    ModePicker,  // ASK: pick the egress for this start
    Menu,        // main menu after a start
    Settings,    // every option, grouped
    Chats,       // deep reset and restore
    Renew,       // renew session confirmation
    Uninstall,   // uninstall confirmation
    Support      // support report + about
};

struct LogLine {
    int         kind = 0;    // 0 info, 1 ok, 2 warn, 3 error
    std::string time;
    std::string text;
};

class App {
public:
    App();
    ~App();

    bool init();
    void shutdown();

    // ------------------------------------------------------------ UI state
    Config&       cfg()       { return cfg_; }
    const Config& cfg() const { return cfg_; }
    EgressState&  egress()    { return est_; }

    Screen screen() const { return screen_; }
    void   setScreen(Screen s);   // entering Settings starts the IP pool worker, leaving it stops the worker

    std::vector<LogLine> logLines() const;
    void  clearLogs();

    bool        busy()   const { return busy_; }
    std::string status() const;

    // copies under the lock: the worker may be rescanning while the UI reads
    std::string appExe()     const { std::lock_guard<std::mutex> lk(mtx_); return appExe_; }
    std::string appVersion() const { std::lock_guard<std::mutex> lk(mtx_); return appVersion_; }
    std::string probeCli()   const { std::lock_guard<std::mutex> lk(mtx_); return probeCli_; }
    const std::string& exeDir()     const { return exeDir_; }

    bool appRunning() const;
    bool configured() const { return configured_; }
    void setConfigured(bool v) { configured_ = v; }
    bool shouldQuit() const { return quit_; }
    void requestQuit() { quit_ = true; }

    // Closed-OpenCode prompt (ON_CLOSE = ask).
    bool closePrompt() const { return closePrompt_; }
    void resolveClosePrompt(char key);   // R = rotate, M = menu, Q = quit

    // ------------------------------------------------------- actions (UI)
    void log(int kind, const std::string& msg);

    void startLaunch();                          // Home: Launch OpenCode
    void pickMode(const std::string& mode);      // ModePicker: chosen
    void connectWith();                          // Home: Connect with opencode
    void renewSession();                         // Home: Renew session
    void doUninstall();                          // Home: Uninstall
    void writeSupport();                         // Home: Support report
    void checkUpdates(bool interactive);         // Home/Support
    void swapLangRefresh();                      // after language change

    void newIpAndStart();                        // Menu 1
    void clearTokensAndStart();                  // Menu 2
    void changeIpTest();                         // Menu 3
    void deepResetNow();                         // Chats
    void refreshArchives();
    const std::vector<std::string>& archives() const { return archives_; }
    void restoreArchive(const std::string& dir);

    void openFolder(const std::string& path);
    void saveCfg();
    void stopNow();                              // Action bar: stop OpenCode (the egress stays up until Exit)
    void startNow();                             // Action bar: start OpenCode on the current connection, no new IP, no picker
    void openCli();                              // Action bar: opencodeinf in a new console window
    void installCommands();                      // More: write opencodeinf and opencode-auto next to the .bat's commands
    void removeCommands();                       // More and Uninstall: remove those two commands
    void reloadConfigIfChanged();                // once per frame, checks config.json at most once a second

    void rescanDesktop();                        // Settings: detect the desktop app again
    void clearCacheNow();                        // Settings: clear the OpenCode cache only
    bool setDesktopPath(const std::string& p);   // Settings, Paths: OC_APP; false = file missing

    // Called once per frame from the UI thread.
    void tick();

private:
    void workerLoop();
    void runAsync(const std::function<void()>& fn);

    void connectAndStart(const std::string& mode);
    void rotateAndRestart();
    void startWatcher();
    void stopWatcher();
    bool     startDesktop();              // launch, keep the process handle, start the watcher
    void     stopApp();                   // stop the watcher and OpenCode, forget the handle
    uint32_t releaseAppHandle();          // close the handle; its exit code (0 = unknown)
    void     crashRetry(uint32_t code);   // same route after a short wait; 3 crashes in 10 min stop
    void     detectDesktop(const std::string& why);   // find the app now, reset the 10 min cache
    void     desktopIfStale();            // detect again when the cached result is older than 10 min
    bool     ensureDesktop();             // v2.60.1: no desktop app: ask first, install only on Yes; true when it is there now
    bool     installDesktop();            // official installer: download, SHA-256 check, then /S
    void     dropTokens(const std::string& why);      // clearTokens + UI log
    bool     autoRestartAllowed(const char* why);     // 3 automatic restarts per 10 min, then ask

    Config cfg_;
    EgressState est_;
    std::unique_ptr<EgressEngine> engine_;
    LogWatcher watcher_;

    std::string exeDir_;
    std::string appExe_;
    std::string appVersion_;
    std::string probeCli_;

    Screen screen_ = Screen::Home;

    mutable std::mutex   mtx_;      // guards uiLog_, status_, archives_
    std::deque<LogLine>  uiLog_;
    std::string          status_;
    std::vector<std::string> archives_;

    std::atomic<bool> busy_{false};
    std::atomic<bool> quit_{false};

    std::thread              worker_;
    // IP pool worker (runs while Settings is open): its own route state and engine, see egress.h poolFillOne
    void startPool();
    void stopPool();
    void poolLoop();
    std::thread                   poolThread_;
    std::unique_ptr<EgressEngine> poolEng_;
    EgressState                   poolSt_;
    std::string                   poolIp_;      // exit IP when the worker started (a snapshot: no shared reads)
    std::atomic<bool>             poolStop_{false};
    std::queue<std::function<void()>> tasks_;
    std::mutex               taskMtx_;
    std::condition_variable  taskCv_;

    std::string runSinceUtc_;                 // UTC start of the current OpenCode run: the watcher ignores older log lines
    int64_t     cfgMtime_     = 0;        // last seen write time of config.json (0 = not read yet)
    int64_t     cfgCheckAt_   = 0;

    bool        configured_   = false;
    bool        closePrompt_  = false;
    bool        appStarted_   = false;
    uint32_t    appPid_       = 0;
    int64_t     appStartTime_ = 0;
    bool        rotateOnExit_ = false;
    std::string lastConnMode_;
    void*       appProc_ = nullptr;       // OpenCode process handle, guarded by mtx_
    int         crashStreak_ = 0;
    int64_t     crashLast_ = 0;
    int64_t     detectAt_ = 0;            // when appExe_ was last detected (worker only)
    int         closeRestarts_ = 0;       // automatic restarts in the current window, guarded by mtx_
    int64_t     closeFirst_ = 0;
    std::atomic<int64_t> rateAskAt_{0};   // last rate limit question (10 min cooldown)
};

} // namespace oi

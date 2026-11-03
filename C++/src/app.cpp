// app.cpp
#include "app.h"

#include "log.h"
#include "lang.h"
#include "util.h"
#include "opencode.h"
#include "updates.h"
#include "support.h"
#include "proc.h"
#include "http.h"

#include <windows.h>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <thread>

namespace oi {

const char* kLauncherVersion = "3.4.1";

App::App() {}
App::~App() { shutdown(); }

// ------------------------------------------------------------------ lifecycle

bool App::init() {
    exeDir_ = exeDir();
    std::string sd = stateDir();
    logInit(sd);
    logInfo("OpenCode Infinite " + std::string(kLauncherVersion) + " starting");

    cfg_.load(sd);
    configured_ = fileExists(cfg_.path());

    // Language: auto follows Windows, otherwise the stored code.
    std::string lc = cfg_.s("OCUI_LANG");
    if (lc.empty() || iequals(lc, "auto")) lc = auto_lang();
    load_lang(sd, lc);

    engine_.reset(new EgressEngine(&cfg_, &est_));
    engine_->detectTools();

    detectDesktop("launcher start");

    std::thread t([this] { workerLoop(); });
    worker_.swap(t);

    refreshArchives();

    log(0, tx("OpenCode Infinite {0} ready.", kLauncherVersion));
    if (appExe_.empty())
        log(2, tx("The OpenCode desktop app was not found. Set the path in Settings, Paths."));
    else if (!appVersion_.empty())
        log(0, tx("OpenCode desktop {0} detected.", appVersion_));

    if (cfg_.b("UPDATE_CHECK") && !cfg_.s("LAUNCHER_UPDATE_URL").empty())
        checkUpdates(false);

    return true;
}

void App::setScreen(Screen s) {
    bool was = screen_ == Screen::Settings;
    screen_ = s;
    if (s == Screen::Settings && !was) startPool();
    else if (was && s != Screen::Settings) stopPool();
}

void App::startPool() {
    if (!poolThread_.joinable()) {
        poolSt_ = est_;                       // route state at the first Settings visit (the mode is not re-read later)
        poolIp_ = est_.lastIp;
        poolEng_.reset(new EgressEngine(&cfg_, &poolSt_));
        poolEng_->asPoolWorker();
        poolThread_ = std::thread([this] { poolLoop(); });
    } else {
        poolEng_->resume();
    }
    poolStop_ = false;
}

// pauses the worker; the current probe or tunnel test finishes on its own (no wait on the UI thread)
void App::stopPool() {
    poolStop_ = true;
    if (poolEng_) poolEng_->cancel();
}

void App::poolLoop() {
    ProgressFn log = [](int kind, const std::string& msg) { if (kind >= 2) logWarn(msg); else logInfo(msg); };
    while (!quit_) {
        if (poolStop_) { std::this_thread::sleep_for(std::chrono::milliseconds(500)); continue; }
        Egress m = poolSt_.mode;
        bool on = cfg_.b("POOL_ENABLE") && (m == Egress::Proxy || m == Egress::Wireproxy || m == Egress::VpnGate);
        // VPN Gate: only while its helper already runs (the pool never asks for administrator), no session, no tunnel
        if (on && m == Egress::VpnGate) on = vgHelperAlive() && !appRunning() && !engine_->tunnelUp();
        if (on) poolEng_->poolFillOne(log, probeCli(), poolIp_, cfg_.b("PROBE"));
        int waitSec = on ? cfg_.i("POOL_INTERVAL") : 2;
        for (int i = 0; i < waitSec * 2 && !poolStop_ && !quit_; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
}

void App::shutdown() {
    if (quit_.exchange(true)) {
        // Already shutting down (or never started).
        if (worker_.joinable()) worker_.join();
        return;
    }
    engine_->cancel();   // a hunt has no attempt cap now: stop it so the worker can finish
    stopPool();
    stopWatcher();
    taskCv_.notify_all();
    if (worker_.joinable()) worker_.join();
    if (poolThread_.joinable()) poolThread_.join();   // the pool worker exits on quit_
    poolEng_.reset();
    engine_->shutdown();
    cfg_.save();
    logInfo("launcher stopped");
}

// ------------------------------------------------------------------- logging

void App::log(int kind, const std::string& msg) {
    {
        std::lock_guard<std::mutex> lk(mtx_);
        LogLine l;
        l.kind = kind;
        std::string stamp = nowStamp();   // YYYYMMDD-HHMMSS
        l.time = stamp.substr(9, 2) + ":" + stamp.substr(11, 2) + ":" + stamp.substr(13, 2);
        l.text = msg;
        uiLog_.push_back(l);
        while (uiLog_.size() > 500) uiLog_.pop_front();
        status_ = msg;
    }
    if (cfg_.b("LOG_ENABLED")) {
        switch (kind) {
            case 3: logError(msg); break;
            case 2: logWarn(msg);  break;
            default: logInfo(msg); break;
        }
    }
}

std::vector<LogLine> App::logLines() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return std::vector<LogLine>(uiLog_.begin(), uiLog_.end());
}

void App::clearLogs() {
    std::lock_guard<std::mutex> lk(mtx_);
    uiLog_.clear();
}

std::string App::status() const {
    std::lock_guard<std::mutex> lk(mtx_);
    return status_;
}

void App::saveCfg() { cfg_.save(); }

// ------------------------------------------------------------ desktop detection

void App::detectDesktop(const std::string& why) {
    std::string exe = findDesktopApp(cfg_);
    std::string ver = exe.empty() ? std::string() : desktopVersion(exe);
    std::string cli = exe.empty() ? std::string() : findProbeCli(exe);
    {
        std::lock_guard<std::mutex> lk(mtx_);
        appExe_ = exe;
        appVersion_ = ver;
        probeCli_ = cli;
    }
    detectAt_ = nowSeconds();
    logInfo("desktop app (" + why + "): " + (exe.empty() ? std::string("(not found)") : exe));
    if (!cli.empty()) logInfo("probe cli: " + cli);
}

// The result is cached 10 minutes; Detect again and Clear cache drop it.
void App::desktopIfStale() {
    if (appExe_.empty() || !fileExists(appExe_) || nowSeconds() - detectAt_ > 600)
        detectDesktop("cache expired or app missing");
}

void App::rescanDesktop() {
    runAsync([this] {
        detectDesktop("detect again");
        if (appExe_.empty()) log(2, tx("The OpenCode desktop app was not found. Set the path in Settings, Paths."));
        else                 log(1, tx("OpenCode desktop found: {0}", appExe_));
    });
}

bool App::setDesktopPath(const std::string& p) {
    std::string v = trim(p);
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"') v = v.substr(1, v.size() - 2);   // "Copy as path"
    if (!v.empty() && !fileExists(v)) {
        log(3, tx("Not saved: the file {0} does not exist.", v));
        return false;
    }
    cfg_.set("OC_APP", v);
    cfg_.save();
    log(1, v.empty() ? tx("Desktop app path cleared; it will be searched automatically.")
                     : tx("Desktop app path saved: {0}", v));
    rescanDesktop();
    return true;
}

void App::clearCacheNow() {
    runAsync([this] {
        if (!dirExists(opencodeCacheDir()))           log(0, tx("There is no OpenCode cache to clear."));
        else if (clearCache("user action: Clear cache")) log(1, tx("OpenCode cache cleared: {0}", opencodeCacheDir()));
        else log(2, tx("Part of the cache is in use. Close OpenCode and try again."));
        detectDesktop("cache cleared");
    });
}

void App::dropTokens(const std::string& why) {
    std::string bak, err;
    if (clearTokens(why, &bak, &err)) log(1, tx("Saved the login file to {0}.", bak));
    else if (!err.empty())            log(3, tx("The login was kept: {0}", err));
    else                              log(0, tx("No saved login was found."));
}

void App::swapLangRefresh() {
    std::string lc = cfg_.s("OCUI_LANG");
    if (lc.empty() || iequals(lc, "auto")) lc = auto_lang();
    load_lang(stateDir(), lc, true);
}

// --------------------------------------------------------------- worker queue

void App::runAsync(const std::function<void()>& fn) {
    {
        std::lock_guard<std::mutex> lk(taskMtx_);
        tasks_.push(fn);
    }
    taskCv_.notify_one();
}

void App::workerLoop() {
    for (;;) {
        std::function<void()> job;
        {
            std::unique_lock<std::mutex> lk(taskMtx_);
            taskCv_.wait(lk, [this] { return quit_ || !tasks_.empty(); });
            if (quit_ && tasks_.empty()) return;
            job = tasks_.front();
            tasks_.pop();
        }
        if (job) {
            busy_ = true;
            job();
            busy_ = false;
        }
    }
}

// ------------------------------------------------------------------- watcher

void App::startWatcher() {
    if (!cfg_.b("WATCH")) return;
    std::string lf = newestLogFile();
    if (lf.empty()) return;
    WatchConfig wc;
    wc.logFile     = lf;
    wc.startOffset = (int64_t)fileSizeOf(lf);
    if (!est_.proxyUrl.empty()) wc.probeHostPort = proxyHostPort(est_.proxyUrl);
    watcher_.start(
        wc,
        [this] {
            log(2, tx("OpenCode reported a usage limit."));
            if (cfg_.b("AUTO_ROTATE")) { if (autoRestartAllowed("usage limit in the OpenCode log")) rotateAndRestart(); }
            else closePrompt_ = true;
        },
        [this] {
            // rate limit: never rotate alone; ask at most once per 10 minutes
            int64_t now = nowSeconds();
            if (now - rateAskAt_ < 600) { logInfo("rate limit seen; already asked in the last 10 minutes, not rotating"); return; }
            rateAskAt_ = now;
            log(2, tx("OpenCode reported a rate limit."));
            std::wstring msg = utf8ToWide(tx("Rate limit detected. Rotate the IP now?"));
            // own thread: a dialog left open must not block the watcher or stopApp (it joins the watcher)
            std::thread([this, msg] {
                int r = MessageBoxW(nullptr, msg.c_str(), L"OpenCode Infinite",
                                    MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND);
                if (r == IDYES && !quit_) { logInfo("restart reason: rate limit, the user chose to rotate"); rotateAndRestart(); }
                else log(0, tx("Rate limit: no rotation."));
            }).detach();
        },
        [this](const std::string& m) { log(2, m); });
}

void App::stopWatcher() { watcher_.stop(); }

bool App::appRunning() const { return appStarted_ && desktopRunning(); }

// ------------------------------------------------------------------- actions

void App::startLaunch() {
    std::string mode = cfg_.s("OC_EGRESS_DEFAULT");
    if (mode.empty() || iequals(mode, "ASK")) { screen_ = Screen::ModePicker; return; }
    connectAndStart(mode);
}

void App::pickMode(const std::string& mode) { connectAndStart(mode); }

void App::connectWith() {
    cfg_.save();
    configured_ = true;
    log(1, tx("Setup complete. The launcher settings were stored."));
    checkUpdates(true);
}

void App::connectAndStart(const std::string& mode) {
    lastConnMode_ = mode;
    runAsync([this, mode] {
        auto lg = [this](int k, const std::string& m) { log(k, m); };
        log(0, tx("Connecting through {0}...", mode));
        if (!engine_->setMode(mode, lg)) {
            log(3, tx("Could not set the connection mode."));
            return;
        }
        if (!engine_->up(lg)) {
            log(3, tx("The connection is not up. Check the mode in Settings."));
            return;
        }
        TraceInfo t = engine_->trace();
        {
            std::lock_guard<std::mutex> lk(mtx_);
            est_.lastIp = t.ip;
            est_.lastLoc = t.loc;
        }
        if (t.ok) log(1, tx("Exit IP {0} ({1}).", t.ip, t.loc));
        else      log(2, tx("Could not read the exit IP."));

        desktopIfStale();
        if (cfg_.b("PROBE") && !probeCli_.empty()) {
            if (!engine_->hunt(lg, probeCli_))
                log(2, tx("The IP hunt ended without a confirmed IP."));
        }

        if (appExe_.empty()) {
            log(3, tx("The OpenCode desktop app was not found."));
            screen_ = Screen::Home;
            return;
        }
        stopApp();
        if (!startDesktop()) {
            log(3, tx("OpenCode did not start."));
            return;
        }
        log(1, tx("OpenCode is running."));
        screen_ = Screen::Menu;
    });
}

void App::rotateAndRestart() {
    if (busy_) return;
    runAsync([this] {
        auto lg = [this](int k, const std::string& m) { log(k, m); };
        log(0, tx("Getting a new IP and restarting OpenCode."));
        stopApp();
        if (!engine_->rotate(lg)) {
            log(3, tx("Could not get a new IP."));
            return;
        }
        TraceInfo t = engine_->trace();
        {
            std::lock_guard<std::mutex> lk(mtx_);
            est_.lastIp = t.ip;
            est_.lastLoc = t.loc;
        }
        if (t.ok) log(1, tx("Exit IP {0} ({1}).", t.ip, t.loc));

        if (cfg_.b("PROBE") && !probeCli_.empty())
            engine_->hunt(lg, probeCli_);

        if (appExe_.empty()) return;
        if (startDesktop()) {
            log(1, tx("OpenCode is running again."));
            screen_ = Screen::Menu;
        } else {
            log(3, tx("OpenCode did not start."));
        }
    });
}

void App::newIpAndStart() {
    if (est_.mode == Egress::None) {
        startLaunch();
    } else {
        rotateAndRestart();
    }
}

void App::changeIpTest() {
    runAsync([this] {
        auto lg = [this](int k, const std::string& m) { log(k, m); };
        bool wasRunning = appRunning();
        if (engine_->rotate(lg)) {
            TraceInfo t = engine_->trace();
            {
                std::lock_guard<std::mutex> lk(mtx_);
                est_.lastIp = t.ip;
                est_.lastLoc = t.loc;
            }
            if (t.ok) log(1, tx("Exit IP {0} ({1}).", t.ip, t.loc));
            else      log(1, tx("New route set."));
            // a running app keeps keep-alive sockets on the old tunnel (ECONNRESET): restart it
            if (wasRunning) {
                stopApp();
                if (startDesktop()) log(1, tx("OpenCode is running again."));
                else                log(3, tx("OpenCode did not start."));
            }
        } else {
            log(3, tx("Could not get a new IP."));
        }
    });
}

void App::clearTokensAndStart() {
    runAsync([this] {
        auto lg = [this](int k, const std::string& m) { log(k, m); };
        stopApp();
        dropTokens("user action: Clear tokens, then start");   // tokens only; the cache has its own action
        engine_->rotate(lg);
        TraceInfo t = engine_->trace();
        {
            std::lock_guard<std::mutex> lk(mtx_);
            est_.lastIp = t.ip;
            est_.lastLoc = t.loc;
        }
        if (appExe_.empty()) return;
        if (startDesktop()) {
            screen_ = Screen::Menu;
        }
    });
}

void App::renewSession() {
    runAsync([this] {
        auto lg = [this](int k, const std::string& m) { log(k, m); };
        log(0, tx("Renewing the session."));
        stopApp();
        dropTokens("user action: Renew session");
        if (engine_->rotate(lg)) {
            TraceInfo t = engine_->trace();
            {
                std::lock_guard<std::mutex> lk(mtx_);
                est_.lastIp = t.ip;
                est_.lastLoc = t.loc;
            }
        }
        log(1, tx("Session renewed. Sign in again if OpenCode asks."));
        screen_ = Screen::Home;
    });
}

void App::doUninstall() {
    runAsync([this] {
        log(0, tx("Removing the launcher settings."));
        stopApp();
        removeFile(cfg_.path());
        cfg_.resetAll();
        cfg_.save();
        detectAt_ = 0;   // OC_APP went back to automatic
        configured_ = false;
        log(1, tx("Settings restored to their defaults."));
        screen_ = Screen::Home;
    });
}

void App::writeSupport() {
    runAsync([this] {
        std::string p = writeSupportReport(cfg_);
        if (!p.empty()) {
            log(1, tx("Support report written: {0}", p));
            openFolder(dirName(p));
        } else {
            log(3, tx("Could not write the support report."));
        }
    });
}

void App::checkUpdates(bool interactive) {
    runAsync([this, interactive] {
        if (cfg_.b("UPDATE_CHECK") && !cfg_.s("LAUNCHER_UPDATE_URL").empty()) {
            LauncherUpdate u = checkLauncherUpdate(cfg_.s("LAUNCHER_UPDATE_URL"), kLauncherVersion);
            if (u.ok && u.available)
                log(1, tx("A newer launcher is available: {0}", u.version));
            else if (interactive)
                log(0, tx("The launcher is up to date."));
        } else if (interactive) {
            log(0, tx("The launcher self-update is off."));
        }

        if (cfg_.s("UPDATE_ASK") == "never" && !interactive) return;
        ReleaseInfo rel = fetchRelease(cfg_.s("OC_API_BASE"), "desktop");
        if (rel.ok) {
            if (versionGreater(rel.version, appVersion_))
                log(1, tx("OpenCode {0} is available (installed: {1}).", rel.version, appVersion_));
            else if (interactive)
                log(0, tx("OpenCode is up to date."));
        } else if (interactive) {
            log(2, tx("Could not read the OpenCode release info."));
        }
    });
}

// ------------------------------------------------------------ chats / reset

void App::refreshArchives() {
    std::string root = joinPath(desktopFolder(), "opencode_chats_archiviate");
    std::vector<std::string> a = listArchives(root);
    std::lock_guard<std::mutex> lk(mtx_);
    archives_ = a;
}

void App::deepResetNow() {
    runAsync([this] {
        log(0, tx("Deep reset: archiving the chats."));
        stopApp();
        std::string desk = desktopFolder();
        std::string err;
        std::string folder = deepReset(joinPath(desk, "opencode_chats_archiviate"), &err);
        if (!folder.empty()) log(1, tx("Chats archived to {0}.", folder));
        else                 log(2, tx("Deep reset: {0}", err.empty() ? std::string(tx("nothing to move")) : err));
        dropTokens("user action: Deep reset");
        clearCache("user action: Deep reset");
        detectAt_ = 0;   // the cache was cleared: detect the app again before the start
        refreshArchives();
        if (!appExe_.empty() && startDesktop()) {
            screen_ = Screen::Menu;
        }
    });
}

void App::restoreArchive(const std::string& dir) {
    runAsync([this, dir] {
        log(0, tx("Restoring chats from {0}.", fileName(dir)));
        stopApp();
        std::string desk = desktopFolder();
        std::string err;
        if (restoreChats(dir, joinPath(desk, "opencode_chats_before_restore"), &err))
            log(1, tx("Chats restored. Sign in again if OpenCode asks."));
        else
            log(3, tx("Restore failed: {0}", err));
        if (!appExe_.empty() && startDesktop()) {
            screen_ = Screen::Menu;
        }
    });
}

void App::openFolder(const std::string& path) {
    std::string p = path;
    if (p.empty()) return;
    spawnDetached(joinPath(envVar("SystemRoot"), "explorer.exe"), quoteArg(p), {}, "", false);
}

// ------------------------------------------------------------ desktop process

bool App::startDesktop() {
    if (tokenGuard()) log(2, tx("auth.json had disappeared; it was restored from the launcher copy. No login needed."));
    releaseAppHandle();
    desktopIfStale();
    // stopApp only kills what this launcher started; a hand-opened OpenCode keeps its old route
    if (desktopRunning())
        log(2, tx("An OpenCode opened outside the launcher is running. Close it so OpenCode uses the new route."));
    void* proc = nullptr;
    if (!launchDesktop(appExe_, est_.proxyUrl, est_.nodeOptions, &appPid_, &proc)) return false;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        appProc_ = proc;
    }
    appStarted_   = true;
    appStartTime_ = nowSeconds();
    startWatcher();
    return true;
}

void App::stopApp() {
    stopWatcher();
    void* proc = nullptr;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        proc = appProc_;
    }
    stopOpenCode(appPid_, proc, "relaunch, rotation or reset requested");
    releaseAppHandle();
    appStarted_ = false;
}

uint32_t App::releaseAppHandle() {
    std::lock_guard<std::mutex> lk(mtx_);
    if (!appProc_) return 0;
    bool exited = false;
    uint32_t code = handleExitCode(appProc_, &exited);
    closeProcHandle(appProc_);
    appProc_ = nullptr;
    return exited ? code : 0;
}

// Same streak rule as the bash launcher: a crash restarts on the same route after 2 s, then 4 s;
// a third crash inside 10 minutes stops and leaves OpenCode closed.
void App::crashRetry(uint32_t code) {
    int64_t now = nowSeconds();
    if (now - crashLast_ > 600) crashStreak_ = 0;
    crashLast_ = now;
    crashStreak_++;
    log(2, tx("OpenCode stopped with code {0} (streak {1}).", fmt("0x%08X", code), std::to_string(crashStreak_)));
    if (crashStreak_ > 2) {
        log(3, tx("OpenCode crashed 3 times in 10 minutes. Stopped so it is not restarted in a loop. Details in the log."));
        screen_ = Screen::Menu;
        return;
    }
    int wait = crashStreak_ * 2;
    log(2, tx("Retry {0} of 2 on the same connection in {1} s.", std::to_string(crashStreak_), std::to_string(wait)));
    runAsync([this, wait] {
        std::this_thread::sleep_for(std::chrono::seconds(wait));
        stopApp();
        if (startDesktop()) {
            log(1, tx("OpenCode is running again."));
            screen_ = Screen::Menu;
        } else {
            log(3, tx("OpenCode did not start."));
        }
    });
}

// ------------------------------------------------------------------ frame tick

// Automatic restarts (clean close, usage limit) must not loop: 3 per 10 minutes, then ask.
bool App::autoRestartAllowed(const char* why) {
    bool ok;
    {
        std::lock_guard<std::mutex> lk(mtx_);   // UI thread (tick) and watcher thread both come here
        int64_t now = nowSeconds();
        if (now - closeFirst_ > 600) { closeFirst_ = now; closeRestarts_ = 0; }
        ok = ++closeRestarts_ <= 3;
    }
    if (ok) { logInfo(std::string("restart reason: ") + why); return true; }
    logWarn(std::string("restart skipped (3 automatic restarts in 10 minutes): ") + why);
    log(2, tx("OpenCode was restarted automatically 3 times in 10 minutes. Automatic restart paused; choose what to do."));
    closePrompt_ = true;
    return false;
}

// 0xC000013A is Ctrl+C; any other nonzero exit is a crash.
static bool isCrashCode(uint32_t c) { return c != 0 && c != 0xC000013A; }

void App::tick() {
    if (closePrompt_) return;
    if (!appStarted_ || busy_) return;
    if (nowSeconds() - appStartTime_ < 3) return;   // start grace
    if (desktopRunning()) return;

    appStarted_ = false;
    stopWatcher();
    uint32_t code = releaseAppHandle();
    logInfo(fmt("opencode pid %u exited, code 0x%08X (0 = clean or unknown)", appPid_, code));
    log(0, tx("OpenCode closed."));
    // A crash restarts on the same route; a clean close follows ON_CLOSE.
    if (cfg_.b("CRASH_RETRY") && isCrashCode(code) && est_.mode != Egress::None) {
        logInfo("restart reason: crash, same route");
        crashRetry(code);
        return;
    }
    if (cfg_.s("ON_CLOSE") == "quit") return;
    if (cfg_.b("AUTO_ROTATE")) {
        if (autoRestartAllowed("OpenCode closed and AUTO_ROTATE is on")) rotateAndRestart();
    }
    else closePrompt_ = true;
}

void App::resolveClosePrompt(char key) {
    char c = (char)std::toupper((unsigned char)key);
    closePrompt_ = false;
    std::string rk = cfg_.s("KEY_ROTATE");
    std::string mk = cfg_.s("KEY_MENU");
    std::string qk = cfg_.s("KEY_QUIT");
    auto up1 = [](const std::string& s) -> char {
        return s.empty() ? '\0' : (char)std::toupper((unsigned char)s[0]);
    };
    if (c == up1(rk) && c != '\0') { rotateAndRestart(); return; }
    if (c == up1(mk) && c != '\0') { screen_ = Screen::Menu; return; }
    if (c == up1(qk) && c != '\0') { quit_ = true; return; }
}

} // namespace oi

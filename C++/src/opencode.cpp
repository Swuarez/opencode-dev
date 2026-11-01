// opencode.cpp
#include "opencode.h"
#include "proc.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <algorithm>

namespace oi {

std::string opencodeDataDir()  { return joinPath(userProfile(), ".local\\share\\opencode"); }
std::string opencodeCacheDir() { return joinPath(userProfile(), ".cache\\opencode"); }
std::string opencodeLogDir()   { return joinPath(opencodeDataDir(), "log"); }

// ---------------------------------------------------------------- discovery

static bool looksLikeDesktopApp(const std::string& exe) {
    // the desktop build ships resources\app.asar next to the exe; the CLI never does
    if (!fileExists(exe)) return false;
    return fileExists(joinPath(dirName(exe), "resources\\app.asar"));
}

std::string findDesktopApp(const Config& cfg) {
    std::string override = cfg.s("OC_APP");
    if (!override.empty() && looksLikeDesktopApp(override)) return override;

    std::string local = localAppData();
    std::string pf = envVar("ProgramFiles");
    std::string pf86 = envVar("ProgramFiles(x86)");
    std::vector<std::string> roots = {
        joinPath(local, "Programs"),
        joinPath(local, "Programs\\@opencode-ai"),
        local,
        pf,
        pf86,
    };
    std::vector<std::string> rels = {
        "OpenCode\\OpenCode.exe",
        "opencode\\OpenCode.exe",
        "opencode-desktop\\OpenCode.exe",
        "ai.opencode.desktop\\OpenCode.exe",
        "Programs\\ai.opencode.desktop\\OpenCode.exe",
        "Programs\\opencode-desktop\\OpenCode.exe",
        "Programs\\opencode\\OpenCode.exe",
        "Programs\\@opencode-ai\\desktop\\OpenCode.exe",
    };
    for (const auto& r : roots) {
        if (r.empty()) continue;
        for (const auto& rel : rels) {
            std::string p = joinPath(r, rel);
            if (looksLikeDesktopApp(p)) return p;
        }
    }
    // a running instance knows its own path
    for (uint32_t pid : pidsByName("OpenCode.exe")) {
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!h) continue;
        wchar_t buf[4096];
        DWORD n = 4096;
        if (QueryFullProcessImageNameW(h, 0, buf, &n) && looksLikeDesktopApp(wideToUtf8(std::wstring(buf, n)))) {
            CloseHandle(h);
            return wideToUtf8(std::wstring(buf, n));
        }
        CloseHandle(h);
    }
    return "";
}

std::string desktopVersion(const std::string& exe) { return fileVersion(exe); }

std::string findProbeCli(const std::string& desktopExe) {
    // The desktop build ships a CLI sidecar; it is the only CLI the probe may use
    // because this launcher deliberately does not manage a separate CLI install.
    if (!desktopExe.empty()) {
        std::string dir = dirName(desktopExe);
        std::vector<std::string> cands = {
            joinPath(dir, "resources\\opencode-cli.exe"),
            joinPath(dir, "resources\\bin\\opencode-cli.exe"),
            joinPath(dir, "resources\\app.asar.unpacked\\opencode-cli.exe"),
        };
        for (const auto& c : cands) if (fileExists(c)) return c;
        for (const auto& sub : listDir(joinPath(dir, "resources"), false)) {
            if (iequals(fileName(sub), "opencode-cli.exe")) return joinPath(joinPath(dir, "resources"), sub);
        }
    }
    return "";
}

bool desktopRunning() { return !pidsByName("OpenCode.exe").empty(); }

void stopOpenCode() {
    killByName("OpenCode.exe");
    killByName("opencode-cli.exe");
    Sleep(1500);
    if (desktopRunning()) {
        killByName("OpenCode.exe");
        Sleep(800);
    }
    logInfo("opencode processes stopped");
}

// ---------------------------------------------------------------- log

std::string newestLogFile() {
    std::string dir = opencodeLogDir();
    std::string best;
    int64_t bestT = 0;
    for (const auto& f : listDir(dir, false)) {
        std::string p = joinPath(dir, f);
        int64_t t = fileMTime(p);
        if (t > bestT) { bestT = t; best = p; }
    }
    return best;
}

// ---------------------------------------------------------------- launch

bool launchDesktop(const std::string& exe, const std::string& proxyUrl, uint32_t* pidOut,
                   void** processOut) {
    if (exe.empty() || !fileExists(exe)) return false;

    // a leftover app or sidecar was born without the proxy and would keep the old route
    stopOpenCode();

    EnvList env;
    if (!proxyUrl.empty()) {
        env.push_back({"HTTP_PROXY", proxyUrl});
        env.push_back({"HTTPS_PROXY", proxyUrl});
        env.push_back({"http_proxy", proxyUrl});
        env.push_back({"https_proxy", proxyUrl});
        env.push_back({"NO_PROXY", ""});
    } else {
        env.push_back({"HTTP_PROXY", ""});
        env.push_back({"HTTPS_PROXY", ""});
        env.push_back({"http_proxy", ""});
        env.push_back({"https_proxy", ""});
    }
    Spawned sp = spawnDetached(exe, "", env, dirName(exe), false, processOut != nullptr);
    if (!sp.ok) return false;
    if (pidOut) *pidOut = sp.pid;
    if (processOut) *processOut = sp.process;
    logInfo(fmt("launched %s with proxy '%s' (pid %u)", exe.c_str(),
                proxyUrl.empty() ? "direct" : proxyUrl.c_str(), sp.pid));
    return true;
}

// ---------------------------------------------------------------- token guard
static std::string tokenSnapshotFile() { return joinPath(joinPath(stateDir(), "auth_snapshot"), "auth.json"); }

bool tokenGuard() {
    std::string auth = joinPath(opencodeDataDir(), "auth.json");
    std::string snap = tokenSnapshotFile();
    if (fileExists(auth)) {
        if (fileSizeOf(auth) >= 3) copyFileTo(auth, snap);   // a tiny file is not a login
        return false;
    }
    if (!fileExists(snap)) return false;
    if (!copyFileTo(snap, auth)) return false;
    logWarn("tokens: auth.json was missing, restored from the launcher snapshot");
    return true;
}

void tokenDropSnapshot() { removeFile(tokenSnapshotFile()); }

// ---------------------------------------------------------------- tokens

bool clearTokens(const std::string& destDir) {
    tokenDropSnapshot();   // an explicit reset: the copy must not bring the tokens back
    std::string auth = joinPath(opencodeDataDir(), "auth.json");
    // the cache goes either way
    std::string cache = opencodeCacheDir();
    if (dirExists(cache)) {
        runShell(fmt("rmdir /s /q %s", quoteArg(cache).c_str()), 60000);
    }
    if (!fileExists(auth)) return false;

    if (!destDir.empty()) {
        makeDirs(destDir);
        std::string dst = joinPath(destDir, "auth.json");
        if (copyFileTo(auth, dst) && fileSizeOf(dst) == fileSizeOf(auth)) removeFile(auth);
        else removeFile(dst);
    } else {
        removeFile(auth);
    }
    logInfo("saved tokens cleared");
    return true;
}

// ---------------------------------------------------------------- deep reset

static void moveIfExists(const std::string& from, const std::string& to, bool* moved) {
    if (!fileExists(from) && !dirExists(from)) return;
    if (moveFileTo(from, to)) *moved = true;
}

std::string deepReset(const std::string& archiveRoot, std::string* errOut) {
    std::string stamp = nowStamp();
    std::string target = joinPath(archiveRoot, stamp);
    makeDirs(target);

    bool moved = false;
    std::string data = opencodeDataDir();
    for (const char* f : {"opencode.db", "opencode.db-wal", "opencode.db-shm"}) {
        moveIfExists(joinPath(data, f), joinPath(target, f), &moved);
    }
    std::string storage = joinPath(data, "storage");
    if (dirExists(storage) && moveTree(storage, joinPath(target, "storage"))) moved = true;

    if (!moved) {
        removeEmptyDir(target);
        if (errOut) *errOut = "there was nothing to archive.";
        return "";
    }
    logInfo(fmt("chats archived to %s", target.c_str()));
    return target;
}

std::vector<std::string> listArchives(const std::string& archiveRoot) {
    std::vector<std::string> out = listDir(archiveRoot, true);
    std::sort(out.rbegin(), out.rend());   // newest first (stamps sort lexically)
    return out;
}

bool restoreChats(const std::string& archiveDir, const std::string& keepAsideRoot, std::string* errOut) {
    std::string data = opencodeDataDir();
    std::string aside = joinPath(keepAsideRoot, nowStamp() + "-" + randToken(4));

    bool moved = false;
    for (const char* f : {"opencode.db", "opencode.db-wal", "opencode.db-shm"}) {
        moveIfExists(joinPath(data, f), joinPath(aside, f), &moved);
    }
    if (dirExists(joinPath(data, "storage"))) {
        if (moveTree(joinPath(data, "storage"), joinPath(aside, "storage"))) moved = true;
    }

    bool ok = true;
    for (const char* f : {"opencode.db", "opencode.db-wal", "opencode.db-shm"}) {
        std::string src = joinPath(archiveDir, f);
        if (fileExists(src)) ok = copyFileTo(src, joinPath(data, f)) && ok;
    }
    std::string srcStorage = joinPath(archiveDir, "storage");
    if (dirExists(srcStorage)) ok = copyTree(srcStorage, joinPath(data, "storage")) && ok;

    if (!ok && errOut) *errOut = "some files could not be copied back.";
    logInfo(fmt("chats restored from %s", archiveDir.c_str()));
    return ok;
}

} // namespace oi

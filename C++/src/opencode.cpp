// opencode.cpp
#include "opencode.h"
#include "proc.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <wincrypt.h>
#include <algorithm>

#pragma comment(lib, "crypt32.lib")

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
    // a path the user set is trusted as is; app.asar only tells Desktop from the CLI in the search
    if (!override.empty() && fileExists(override)) return override;

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
        "@opencode-ai\\desktop\\OpenCode.exe",   // ProgramFiles\@opencode-ai\desktop (the .bat checks it)
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

// Only the tree this launcher started; an OpenCode opened by hand is never touched.
void stopOpenCode(uint32_t pid, void* process, const std::string& reason) {
    if (!pid || !process) return;   // without our open handle the pid may belong to someone else now
    uint32_t n = killTree(pid);     // the sidecar opencode-cli is a child, so it goes too
    WaitForSingleObject((HANDLE)process, 5000);
    logInfo(fmt("opencode pid %u stopped (%u processes), reason: %s", pid, n, reason.c_str()));
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

    // the caller stopped its own previous copy (App::stopApp); others are not ours to kill
    EnvList env;
    if (!proxyUrl.empty()) {
        env.push_back({"HTTP_PROXY", proxyUrl});
        env.push_back({"HTTPS_PROXY", proxyUrl});
        env.push_back({"http_proxy", proxyUrl});
        env.push_back({"https_proxy", proxyUrl});
        // an empty value is dropped by buildEnvBlock; the sidecar must reach localhost directly
        env.push_back({"NO_PROXY", "localhost,127.0.0.1,::1"});
        env.push_back({"no_proxy", "localhost,127.0.0.1,::1"});
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
    // a proxy URL may carry user:pass; the log keeps only scheme and host
    std::string shown = proxyUrl.empty() ? std::string("direct") : proxyUrl;
    size_t at = shown.rfind('@'), sch = shown.find("://");
    if (at != std::string::npos) shown = shown.substr(0, sch == std::string::npos ? 0 : sch + 3) + "***" + shown.substr(at);
    logInfo(fmt("launched pid %u: \"%s\" (no arguments), proxy '%s'", sp.pid, exe.c_str(), shown.c_str()));
    return true;
}

// ---------------------------------------------------------------- token guard
static std::string tokenSnapshotDir()  { return joinPath(stateDir(), "auth_snapshot"); }
static std::string tokenSnapshotFile() { return joinPath(tokenSnapshotDir(), "auth.dpapi"); }

bool dpapiCrypt(const std::string& in, std::string* out, bool protect) {
    DATA_BLOB src{(DWORD)in.size(), (BYTE*)in.data()}, dst{};
    BOOL ok = protect
        ? CryptProtectData(&src, L"opencode-infinite auth", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &dst)
        : CryptUnprotectData(&src, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &dst);
    if (!ok) return false;
    out->assign((const char*)dst.pbData, dst.cbData);
    LocalFree(dst.pbData);
    return true;
}

bool tokenGuard() {
    std::string auth = joinPath(opencodeDataDir(), "auth.json");
    std::string snap = tokenSnapshotFile();
    if (fileExists(auth)) {
        std::string blob;
        // a tiny file is not a login; the copy is DPAPI-encrypted so only this Windows user can read it
        if (fileSizeOf(auth) >= 3 && dpapiCrypt(readFileText(auth), &blob, true) && writeFileText(snap, blob)) {
            std::string legacy = joinPath(tokenSnapshotDir(), "auth.json");   // plaintext copy of older builds
            if (fileExists(legacy) && removeFile(legacy))
                logInfo("tokens: deleted " + legacy + ", reason: replaced by the encrypted snapshot");
        }
        return false;
    }
    if (!fileExists(snap)) return false;
    std::string plain;
    if (!dpapiCrypt(readFileText(snap), &plain, false)) {
        logWarn("tokens: auth.json is missing and the snapshot could not be decrypted; nothing restored");
        return false;
    }
    if (!writeFileText(auth, plain)) return false;
    logWarn("tokens: auth.json was missing, restored from the launcher snapshot");
    return true;
}

void tokenDropSnapshot(const std::string& reason) {
    std::string snap = tokenSnapshotFile();
    if (fileExists(snap) && removeFile(snap))
        logInfo("tokens: deleted the snapshot " + snap + ", reason: " + reason);
}

// ---------------------------------------------------------------- tokens

bool clearTokens(const std::string& reason, std::string* backupOut, std::string* errOut) {
    std::string auth = joinPath(opencodeDataDir(), "auth.json");
    if (!fileExists(auth)) {
        tokenDropSnapshot(reason);   // an explicit reset: the copy must not bring the tokens back
        return false;
    }
    std::string dst = joinPath(joinPath(joinPath(localAppData(), "opencode-infinite\\backup\\auth"), nowStamp()), "auth.json");
    makeDirs(dirName(dst));
    if (!copyFileTo(auth, dst) || fileSizeOf(dst) != fileSizeOf(auth)) {
        // no verified backup, no delete
        logError("tokens: backup to " + dst + " failed; " + auth + " kept");
        if (errOut) *errOut = "the backup copy failed, auth.json was not deleted.";
        return false;
    }
    tokenDropSnapshot(reason);
    if (!removeFile(auth)) {
        if (errOut) *errOut = "auth.json could not be deleted.";
        return false;
    }
    logInfo("tokens: deleted " + auth + ", reason: " + reason + ", backup: " + dst);
    if (backupOut) *backupOut = dst;
    return true;
}

bool clearCache(const std::string& reason) {
    std::string cache = opencodeCacheDir();   // %USERPROFILE%\.cache\opencode; auth.json lives elsewhere
    if (!dirExists(cache)) return false;
    runShell(fmt("rmdir /s /q %s", quoteArg(cache).c_str()), 60000);
    bool gone = !dirExists(cache);
    logInfo("cache: deleted " + cache + (gone ? "" : " (partly: some files in use)") + ", reason: " + reason);
    return gone;
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

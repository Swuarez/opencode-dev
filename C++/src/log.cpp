// log.cpp
#include "log.h"
#include "util.h"

#include <windows.h>

#include <mutex>
#include <ctime>

namespace oi {

static std::mutex g_mtx;
static std::string g_path;
static int g_maxKb = 1024;
static bool g_enabled = true;

void logInit(const std::string& stateDir) {
    std::lock_guard<std::mutex> lk(g_mtx);
    g_path = joinPath(stateDir, "launcher.log");
    makeDirs(stateDir);
}

void logTrim(int maxKb) { g_maxKb = maxKb > 0 ? maxKb : 1024; }

std::string logPath() { return g_path; }

static const char* levelName(LogLevel l) {
    switch (l) {
        case LogLevel::Debug: return "DEBUG";
        case LogLevel::Info: return "INFO";
        case LogLevel::Warn: return "WARN";
        case LogLevel::Error: return "ERROR";
    }
    return "INFO";
}

void logWrite(LogLevel lvl, const std::string& msg) {
    if (!g_enabled || g_path.empty()) return;
    std::lock_guard<std::mutex> lk(g_mtx);

    time_t t = time(nullptr);
    struct tm tmv;
    localtime_s(&tmv, &t);
    std::string line = fmt("[%04d-%02d-%02d %02d:%02d:%02d] [%s] %s\n",
                           tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                           tmv.tm_hour, tmv.tm_min, tmv.tm_sec, levelName(lvl), msg.c_str());

    // rotate: keep the file under maxKb by rewriting the tail
    if ((int64_t)fileSizeOf(g_path) > (int64_t)g_maxKb * 1024) {
        std::string tail = readFileTail(g_path, g_maxKb * 1024 / 2);
        size_t nl = tail.find('\n');
        if (nl != std::string::npos) tail = tail.substr(nl + 1);
        writeFileText(g_path, tail);
    }

    HANDLE h = CreateFileW(utf8ToWide(g_path).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD wr = 0;
        WriteFile(h, line.data(), (DWORD)line.size(), &wr, nullptr);
        CloseHandle(h);
    }
}

void logDebug(const std::string& m) { logWrite(LogLevel::Debug, m); }
void logInfo(const std::string& m) { logWrite(LogLevel::Info, m); }
void logWarn(const std::string& m) { logWrite(LogLevel::Warn, m); }
void logError(const std::string& m) { logWrite(LogLevel::Error, m); }

std::string logTail(int maxBytes) { return readFileTail(g_path, maxBytes); }

} // namespace oi

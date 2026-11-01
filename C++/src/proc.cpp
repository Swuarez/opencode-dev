// process.cpp
#include "proc.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <tlhelp32.h>
#include <thread>
#include <atomic>
#include <algorithm>
#include <map>

#pragma comment(lib, "version.lib")

namespace oi {

namespace {

std::string buildEnvBlock(const EnvList& envSet) {
    std::map<std::string, std::string> env;
    LPWCH cur = GetEnvironmentStringsW();
    if (cur) {
        for (LPWCH p = cur; *p; p += wcslen(p) + 1) {
            std::string e = wideToUtf8(p);
            size_t eq = e.find('=');
            if (eq == std::string::npos || eq == 0) continue;   // skip "=C:" style
            env[e.substr(0, eq)] = e.substr(eq + 1);
        }
        FreeEnvironmentStringsW(cur);
    }
    for (const auto& kv : envSet) {
        if (kv.second.empty()) env.erase(kv.first);
        else env[kv.first] = kv.second;
    }
    std::string block;
    for (const auto& kv : env) { block += kv.first; block += '='; block += kv.second; block += '\0'; }
    block += '\0';
    return block;
}

std::string quote(const std::string& a) {
    std::string out = "\"";
    for (char c : a) { if (c == '"') out += "\\\""; else out.push_back(c); }
    out += "\"";
    return out;
}

struct ProcInfo { uint32_t pid; uint32_t ppid; };

std::vector<ProcInfo> snapshot() {
    std::vector<ProcInfo> v;
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h == INVALID_HANDLE_VALUE) return v;
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(h, &pe)) {
        do { v.push_back({(uint32_t)pe.th32ProcessID, (uint32_t)pe.th32ParentProcessID}); }
        while (Process32NextW(h, &pe));
    }
    CloseHandle(h);
    return v;
}

void collectDescendants(uint32_t pid, const std::vector<ProcInfo>& all, std::vector<uint32_t>& out) {
    for (const auto& p : all) {
        if (p.ppid == pid) {
            collectDescendants(p.pid, all, out);
            out.push_back(p.pid);
        }
    }
}

HANDLE openProc(uint32_t pid) {
    return OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE |
                       PROCESS_SET_QUOTA, FALSE, pid);
}

void drainPipe(HANDLE h, std::string* out, std::atomic<bool>* stop) {
    char buf[8192];
    DWORD rd = 0;
    while (ReadFile(h, buf, sizeof(buf), &rd, nullptr) && rd > 0) {
        if (out && out->size() < 4 * 1024 * 1024) out->append(buf, rd);
    }
    (void)stop;
}

} // namespace

RunResult runCapture(const std::string& exe, const std::string& args, const EnvList& envSet,
                     int timeoutMs, const std::string& cwd, bool hidden) {
    RunResult r;
    std::string envBlock = buildEnvBlock(envSet);

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE outRd = nullptr, outWr = nullptr, errRd = nullptr, errWr = nullptr;
    CreatePipe(&outRd, &outWr, &sa, 0);
    CreatePipe(&errRd, &errWr, &sa, 0);
    SetHandleInformation(outRd, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errRd, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = outWr;
    si.hStdError = errWr;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    if (hidden) { si.dwFlags |= STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; }

    PROCESS_INFORMATION pi{};
    std::string cmd = quote(exe) + (args.empty() ? "" : " " + args);
    DWORD flags = CREATE_NO_WINDOW;
    BOOL ok = CreateProcessA(nullptr, &cmd[0], nullptr, nullptr, TRUE, flags,
                             &envBlock[0], cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
    CloseHandle(outWr);
    CloseHandle(errWr);
    if (!ok) {
        if (outRd) CloseHandle(outRd);
        if (errRd) CloseHandle(errRd);
        r.err = fmt("CreateProcess failed %lu for %s", GetLastError(), exe.c_str());
        return r;
    }
    r.started = true;

    std::atomic<bool> stop{false};
    std::thread tOut(drainPipe, outRd, &r.out, &stop);
    std::thread tErr(drainPipe, errRd, &r.err, &stop);

    DWORD w = WaitForSingleObject(pi.hProcess, timeoutMs > 0 ? (DWORD)timeoutMs : INFINITE);
    if (w == WAIT_TIMEOUT) {
        r.timedOut = true;
        killTree((uint32_t)pi.dwProcessId);
        WaitForSingleObject(pi.hProcess, 5000);
    }
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    r.exitCode = r.timedOut ? 124 : (int)code;

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    tOut.join();
    tErr.join();
    if (outRd) CloseHandle(outRd);
    if (errRd) CloseHandle(errRd);
    return r;
}

RunResult runShell(const std::string& cmdline, int timeoutMs, const std::string& cwd) {
    std::string comspec = envVar("ComSpec");
    if (comspec.empty()) comspec = "C:\\Windows\\System32\\cmd.exe";
    return runCapture(comspec, "/s /c " + cmdline, {}, timeoutMs, cwd, true);
}

Spawned spawnDetached(const std::string& exe, const std::string& args, const EnvList& envSet,
                      const std::string& cwd, bool hidden, bool keepHandle) {
    Spawned s;
    std::string envBlock = buildEnvBlock(envSet);
    STARTUPINFOA si{};
    si.cb = sizeof(si);
    if (hidden) { si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; }
    PROCESS_INFORMATION pi{};
    std::string cmd = quote(exe) + (args.empty() ? "" : " " + args);
    DWORD flags = CREATE_NO_WINDOW;
    if (CreateProcessA(nullptr, &cmd[0], nullptr, nullptr, FALSE, flags, &envBlock[0],
                       cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
        s.ok = true;
        s.pid = (uint32_t)pi.dwProcessId;
        if (keepHandle) s.process = pi.hProcess;
        else CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    } else {
        logError(fmt("spawnDetached failed %lu: %s", GetLastError(), exe.c_str()));
    }
    return s;
}

uint32_t handleExitCode(void* process, bool* exited) {
    DWORD code = 0;
    *exited = process && GetExitCodeProcess((HANDLE)process, &code) && code != STILL_ACTIVE;
    return (uint32_t)code;
}

void closeProcHandle(void* process) {
    if (process) CloseHandle((HANDLE)process);
}

bool isAlive(uint32_t pid) {
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return false;
    DWORD code = 0;
    bool alive = GetExitCodeProcess(h, &code) && code == STILL_ACTIVE;
    CloseHandle(h);
    return alive;
}

bool waitPid(uint32_t pid, int timeoutMs) {
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!h) return true;
    DWORD w = WaitForSingleObject(h, timeoutMs > 0 ? (DWORD)timeoutMs : INFINITE);
    CloseHandle(h);
    return w == WAIT_OBJECT_0;
}

uint32_t killTree(uint32_t pid) {
    std::vector<ProcInfo> all = snapshot();
    std::vector<uint32_t> victims;
    collectDescendants(pid, all, victims);
    victims.push_back(pid);
    uint32_t killed = 0;
    for (uint32_t p : victims) {
        HANDLE h = openProc(p);
        if (h) {
            if (TerminateProcess(h, 1)) ++killed;
            CloseHandle(h);
        }
    }
    return killed;
}

std::vector<uint32_t> pidsByName(const std::string& exeName) {
    std::vector<uint32_t> out;
    std::string want = lower(exeName);
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h == INVALID_HANDLE_VALUE) return out;
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(h, &pe)) {
        do {
            if (lower(wideToUtf8(pe.szExeFile)) == want) out.push_back((uint32_t)pe.th32ProcessID);
        } while (Process32NextW(h, &pe));
    }
    CloseHandle(h);
    return out;
}

int killByName(const std::string& exeName) {
    int n = 0;
    for (uint32_t pid : pidsByName(exeName)) n += (int)killTree(pid);
    return n;
}

uint32_t pidByName(const std::string& exeName) {
    auto v = pidsByName(exeName);
    return v.empty() ? 0 : v[0];
}

std::string findOnPath(const std::string& exeName) {
    wchar_t buf[32768];
    DWORD n = SearchPathW(nullptr, utf8ToWide(exeName).c_str(), nullptr, 32768, buf, nullptr);
    if (n == 0 || n >= 32768) return "";
    return wideToUtf8(std::wstring(buf, n));
}

std::string fileVersion(const std::string& path) {
    DWORD dummy = 0;
    DWORD size = GetFileVersionInfoSizeW(utf8ToWide(path).c_str(), &dummy);
    if (!size) return "";
    std::vector<char> data(size);
    if (!GetFileVersionInfoW(utf8ToWide(path).c_str(), 0, size, data.data())) return "";
    VS_FIXEDFILEINFO* ffi = nullptr;
    UINT len = 0;
    if (!VerQueryValueW(data.data(), L"\\", (LPVOID*)&ffi, &len) || !ffi) return "";
    return fmt("%d.%d.%d.%d",
               HIWORD(ffi->dwFileVersionMS), LOWORD(ffi->dwFileVersionMS),
               HIWORD(ffi->dwFileVersionLS), LOWORD(ffi->dwFileVersionLS));
}

bool isElevated() {
    BOOL admin = FALSE;
    PSID grp = nullptr;
    SID_IDENTIFIER_AUTHORITY auth = SECURITY_NT_AUTHORITY;
    if (AllocateAndInitializeSid(&auth, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
                                 0, 0, 0, 0, 0, 0, &grp)) {
        CheckTokenMembership(nullptr, grp, &admin);
        FreeSid(grp);
    }
    return admin != FALSE;
}

} // namespace oi

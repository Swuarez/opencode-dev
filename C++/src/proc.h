#pragma once
// process.h - create, capture, track and kill processes on Windows.
#include <string>
#include <vector>
#include <utility>
#include <cstdint>

namespace oi {

using EnvList = std::vector<std::pair<std::string, std::string>>;

struct RunResult {
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
    std::string out;
    std::string err;
};

// Runs a program with redirected stdout/stderr and waits up to timeoutMs.
RunResult runCapture(const std::string& exe, const std::string& args, const EnvList& envSet,
                     int timeoutMs, const std::string& cwd = "", bool hidden = true);

// Runs a command line through cmd.exe /c (use sparingly).
RunResult runShell(const std::string& cmdline, int timeoutMs, const std::string& cwd = "");

struct Spawned { bool ok = false; uint32_t pid = 0; void* process = nullptr; };

// Starts a process and returns immediately. keepHandle: the handle comes back in
// Spawned::process (close it with closeProcHandle), otherwise it is closed here.
Spawned spawnDetached(const std::string& exe, const std::string& args, const EnvList& envSet,
                      const std::string& cwd = "", bool hidden = true, bool keepHandle = false);
// Exit code of a kept process; exited = false while it still runs.
uint32_t handleExitCode(void* process, bool* exited);
void     closeProcHandle(void* process);

bool isAlive(uint32_t pid);
bool waitPid(uint32_t pid, int timeoutMs);
uint32_t killTree(uint32_t pid);
int killByName(const std::string& exeName);
std::vector<uint32_t> pidsByName(const std::string& exeName);
uint32_t pidByName(const std::string& exeName);

std::string findOnPath(const std::string& exeName);
std::string fileVersion(const std::string& path);
bool isElevated();

} // namespace oi

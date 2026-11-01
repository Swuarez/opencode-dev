#pragma once
// updates.h - release metadata, version compare, hash check, silent install.
#include <string>
#include <map>
#include <functional>
#include <cstdint>

namespace oi {

struct ReleaseFile {
    std::string url;
    std::string sha256;
    uint64_t size = 0;
};

struct ReleaseInfo {
    bool ok = false;
    std::string version;
    std::map<std::string, ReleaseFile> files;
};

// kind is "desktop" for the OpenCode desktop app.
ReleaseInfo fetchRelease(const std::string& apiBase, const std::string& kind);

bool versionGreater(const std::string& a, const std::string& b);
std::string sha256File(const std::string& path);

struct LauncherUpdate {
    bool ok = false;
    bool available = false;
    std::string version;
    std::string url;
};

// Reads { "version": "...", "url": "..." } from LAUNCHER_UPDATE_URL.
LauncherUpdate checkLauncherUpdate(const std::string& url, const std::string& currentVersion);

// Downloads the desktop installer, verifies size and SHA-256, then runs it silently.
bool installDesktopFromRelease(const ReleaseInfo& rel, const std::string& fileName,
                               std::string* errOut);

} // namespace oi

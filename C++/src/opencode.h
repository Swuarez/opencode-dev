#pragma once
// opencode.h - the OpenCode desktop app: find, start, stop, data folders.
#include <string>
#include <vector>

#include "config.h"

namespace oi {

std::string opencodeDataDir();      // %USERPROFILE%\.local\share\opencode
std::string opencodeCacheDir();     // %USERPROFILE%\.cache\opencode
std::string opencodeLogDir();       // <data>\log

std::string findDesktopApp(const Config& cfg);
std::string desktopVersion(const std::string& exe);
std::string findProbeCli(const std::string& desktopExe);

bool desktopRunning();
void stopOpenCode();

// Newest log file in the OpenCode log folder, "" when there is none.
std::string newestLogFile();

// Starts the desktop app with the given proxy (empty = direct). false = it did not start.
bool launchDesktop(const std::string& exe, const std::string& proxyUrl, uint32_t* pidOut,
                   void** processOut = nullptr);

// Archives auth.json into destDir, then removes it. Returns false when there is none.
bool clearTokens(const std::string& destDir);

// Keeps a copy of auth.json at every start and puts it back when it vanished.
// Returns true when it restored the file.
bool tokenGuard();
// Forgets the copy. Every reset calls it, so the tokens do not come back.
void tokenDropSnapshot();

// Moves the database and storage into <archiveRoot>\<stamp>. Returns the folder used.
std::string deepReset(const std::string& archiveRoot, std::string* errOut);

std::vector<std::string> listArchives(const std::string& archiveRoot);

// Moves the chats in place aside, then copies the archive back. false on failure.
bool restoreChats(const std::string& archiveDir, const std::string& keepAsideRoot, std::string* errOut);

} // namespace oi

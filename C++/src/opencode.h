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
// Kills only the tree of a process this launcher started (pid + its kept handle).
void stopOpenCode(uint32_t pid, void* process, const std::string& reason);

// Newest log file in the OpenCode log folder, "" when there is none.
std::string newestLogFile();

// Starts the desktop app with the given proxy (empty = direct). false = it did not start.
bool launchDesktop(const std::string& exe, const std::string& proxyUrl, uint32_t* pidOut,
                   void** processOut = nullptr);

// Copies auth.json to %LOCALAPPDATA%\opencode-infinite\backup\auth\<stamp>\ and only then
// deletes it. false = nothing deleted (errOut set when the backup failed). Never touches the cache.
bool clearTokens(const std::string& reason, std::string* backupOut, std::string* errOut);
// Deletes the OpenCode cache folder only. Never touches auth.json. true = the folder is gone.
bool clearCache(const std::string& reason);

// Keeps a DPAPI-encrypted copy of auth.json at every start and puts it back when it vanished.
// Returns true when it restored the file.
bool tokenGuard();
// Forgets the copy. Every reset calls it, so the tokens do not come back.
void tokenDropSnapshot(const std::string& reason);
// DPAPI, current-user scope. protect = encrypt, else decrypt. false = failed.
bool dpapiCrypt(const std::string& in, std::string* out, bool protect);

// Moves the database and storage into <archiveRoot>\<stamp>. Returns the folder used.
std::string deepReset(const std::string& archiveRoot, std::string* errOut);

std::vector<std::string> listArchives(const std::string& archiveRoot);

// Moves the chats in place aside, then copies the archive back. false on failure.
bool restoreChats(const std::string& archiveDir, const std::string& keepAsideRoot, std::string* errOut);

} // namespace oi

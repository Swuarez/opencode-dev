#pragma once
// log.h - launcher log file, one line per event.
#include <string>

namespace oi {

enum class LogLevel { Debug, Info, Warn, Error };

void        logInit(const std::string& stateDir);
void        logWrite(LogLevel lvl, const std::string& msg);
void        logDebug(const std::string& m);
void        logInfo(const std::string& m);
void        logWarn(const std::string& m);
void        logError(const std::string& m);
std::string logPath();
std::string logTail(int maxBytes);
void        logTrim(int maxKb);

} // namespace oi

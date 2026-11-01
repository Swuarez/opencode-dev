#pragma once
// util.h - strings, paths, files, environment, time.
#include <string>
#include <vector>
#include <cstdint>

namespace oi {

std::string  narrow(const std::wstring& w);
std::wstring widen(const std::string& s);

std::string  trim(const std::string& s);
std::string  lower(std::string s);
std::string  upper(std::string s);
bool         icontains(const std::string& hay, const std::string& needle);
bool         iequals(const std::string& a, const std::string& b);
bool         startsWith(const std::string& s, const std::string& p);
std::vector<std::string> split(const std::string& s, char sep);
std::string  replaceAll(std::string s, const std::string& from, const std::string& to);
std::string  fmt(const char* f, ...);

std::string  joinPath(const std::string& a, const std::string& b);
std::string  fileName(const std::string& p);
std::string  dirName(const std::string& p);

bool         fileExists(const std::string& p);
bool         dirExists(const std::string& p);
bool         makeDirs(const std::string& p);
bool         removeFile(const std::string& p);
bool         removeEmptyDir(const std::string& p);
bool         copyFileTo(const std::string& from, const std::string& to);
bool         moveFileTo(const std::string& from, const std::string& to);
bool         copyTree(const std::string& from, const std::string& to);
bool         moveTree(const std::string& from, const std::string& to);
uint64_t     fileSizeOf(const std::string& p);
int64_t      fileMTime(const std::string& p);
std::string  readFileText(const std::string& p);
bool         writeFileText(const std::string& p, const std::string& data);
std::vector<std::string> listDir(const std::string& p, bool wantDirs);
std::string  readFileTail(const std::string& p, int maxBytes);
std::string  readFileFrom(const std::string& p, int64_t offset);

std::string  envVar(const std::string& name);
std::string  localAppData();
std::string  userProfile();
std::string  tempDir();
std::string  desktopFolder();
std::string  exeDir();
std::string  stateDir();
std::string  pathFromExe(const std::string& rel);

std::string  nowStamp();
std::string  nowStampMs();
int64_t      nowSeconds();
std::string  randToken(int len);
std::string  quoteArg(const std::string& a);
std::string  winLocaleCode();      // 2-letter code of the current UI language

std::string  base64Encode(const std::string& in);

// UTF-8 <-> UTF-16 helpers for the Win32 wide APIs.
std::wstring utf8ToWide(const std::string& s);
std::string  wideToUtf8(const std::wstring& w);

} // namespace oi

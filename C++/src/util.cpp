// util.cpp
#include "util.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <cstdarg>
#include <cstdio>
#include <ctime>
#include <random>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "ws2_32.lib")

namespace oi {

// inet_pton expands "::", so compressed and full IPv6 forms compare alike.
// IPv6 counts as the same exit when the /64 matches (WARP varies the host part).
bool sameIp(const std::string& a, const std::string& b) {
    in6_addr a6, b6;
    if (inet_pton(AF_INET6, a.c_str(), &a6) == 1 && inet_pton(AF_INET6, b.c_str(), &b6) == 1)
        return memcmp(&a6, &b6, 8) == 0;
    in_addr a4, b4;
    if (inet_pton(AF_INET, a.c_str(), &a4) == 1 && inet_pton(AF_INET, b.c_str(), &b4) == 1)
        return memcmp(&a4, &b4, 4) == 0;
    return false;   // empty, unparsable or mixed families: not a known same IP
}

std::string narrow(const std::wstring& w) { return wideToUtf8(w); }
std::wstring widen(const std::string& s) { return utf8ToWide(s); }

std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring out((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], n);
    return out;
}

std::string wideToUtf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], n, nullptr, nullptr);
    return out;
}

std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    return s;
}

std::string upper(std::string s) {
    for (char& c : s) if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
    return s;
}

bool icontains(const std::string& hay, const std::string& needle) {
    if (needle.empty()) return true;
    return lower(hay).find(lower(needle)) != std::string::npos;
}

bool iequals(const std::string& a, const std::string& b) {
    return lower(a) == lower(b);
}

bool startsWith(const std::string& s, const std::string& p) {
    return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == sep) { out.push_back(cur); cur.clear(); }
        else cur.push_back(c);
    }
    out.push_back(cur);
    return out;
}

std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
    if (from.empty()) return s;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != std::string::npos) {
        s.replace(pos, from.size(), to);
        pos += to.size();
    }
    return s;
}

std::string fmt(const char* f, ...) {
    char buf[4096];
    va_list ap;
    va_start(ap, f);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, f, ap);
    va_end(ap);
    return std::string(buf);
}

std::string joinPath(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    std::string r = a;
    if (r.back() != '\\' && r.back() != '/') r += '\\';
    if (b.front() == '\\' || b.front() == '/') r += b.substr(1);
    else r += b;
    return r;
}

std::string fileName(const std::string& p) {
    size_t i = p.find_last_of("\\/");
    return i == std::string::npos ? p : p.substr(i + 1);
}

std::string dirName(const std::string& p) {
    size_t i = p.find_last_of("\\/");
    return i == std::string::npos ? std::string() : p.substr(0, i);
}

bool fileExists(const std::string& p) {
    DWORD a = GetFileAttributesW(utf8ToWide(p).c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool dirExists(const std::string& p) {
    DWORD a = GetFileAttributesW(utf8ToWide(p).c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

bool makeDirs(const std::string& p) {
    if (p.empty() || dirExists(p)) return true;
    std::string parent = dirName(p);
    if (!parent.empty() && parent != p) makeDirs(parent);
    return CreateDirectoryW(utf8ToWide(p).c_str(), nullptr) != 0 || dirExists(p);
}

bool removeFile(const std::string& p) {
    return DeleteFileW(utf8ToWide(p).c_str()) != 0;
}

bool removeEmptyDir(const std::string& p) {
    return RemoveDirectoryW(utf8ToWide(p).c_str()) != 0;
}

bool copyFileTo(const std::string& from, const std::string& to) {
    makeDirs(dirName(to));
    return CopyFileW(utf8ToWide(from).c_str(), utf8ToWide(to).c_str(), FALSE) != 0;
}

bool moveFileTo(const std::string& from, const std::string& to) {
    makeDirs(dirName(to));
    if (MoveFileW(utf8ToWide(from).c_str(), utf8ToWide(to).c_str())) return true;
    // cross-volume: copy then delete
    if (!copyFileTo(from, to)) return false;
    if (fileSizeOf(to) != fileSizeOf(from)) return false;
    return removeFile(from);
}

bool copyTree(const std::string& from, const std::string& to) {
    if (!dirExists(from)) return false;
    makeDirs(to);
    WIN32_FIND_DATAW fd;
    std::wstring pat = utf8ToWide(from + "\\*");
    HANDLE h = FindFirstFileW(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return true;
    bool ok = true;
    do {
        std::string name = wideToUtf8(fd.cFileName);
        if (name == "." || name == "..") continue;
        std::string s = joinPath(from, name), d = joinPath(to, name);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ok = copyTree(s, d) && ok;
        else ok = copyFileTo(s, d) && ok;
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return ok;
}

bool moveTree(const std::string& from, const std::string& to) {
    if (!dirExists(from)) return false;
    makeDirs(dirName(to));
    if (MoveFileW(utf8ToWide(from).c_str(), utf8ToWide(to).c_str())) return true;
    if (!copyTree(from, to)) return false;
    // remove source tree
    std::string cmd = "cmd.exe /c rmdir /s /q \"" + from + "\"";
    STARTUPINFOA si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::string c = cmd;
    if (CreateProcessA(nullptr, &c[0], nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 120000);
        CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    }
    return true;
}

uint64_t fileSizeOf(const std::string& p) {
    WIN32_FILE_ATTRIBUTE_DATA d;
    if (!GetFileAttributesExW(utf8ToWide(p).c_str(), GetFileExInfoStandard, &d)) return 0;
    return ((uint64_t)d.nFileSizeHigh << 32) | d.nFileSizeLow;
}

int64_t fileMTime(const std::string& p) {
    WIN32_FILE_ATTRIBUTE_DATA d;
    if (!GetFileAttributesExW(utf8ToWide(p).c_str(), GetFileExInfoStandard, &d)) return 0;
    ULARGE_INTEGER u;
    u.LowPart = d.ftLastWriteTime.dwLowDateTime;
    u.HighPart = d.ftLastWriteTime.dwHighDateTime;
    return (int64_t)(u.QuadPart / 10000000ULL) - 11644473600LL;
}

std::string readFileText(const std::string& p) {
    HANDLE h = CreateFileW(utf8ToWide(p).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return "";
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    std::string out;
    out.resize((size_t)sz.QuadPart);
    DWORD rd = 0;
    if (!out.empty()) ReadFile(h, &out[0], (DWORD)out.size(), &rd, nullptr);
    out.resize(rd);
    CloseHandle(h);
    return out;
}

bool writeFileText(const std::string& p, const std::string& data) {
    makeDirs(dirName(p));
    HANDLE h = CreateFileW(utf8ToWide(p).c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD wr = 0;
    bool ok = data.empty() || WriteFile(h, data.data(), (DWORD)data.size(), &wr, nullptr);
    CloseHandle(h);
    return ok && wr == data.size();
}

std::vector<std::string> listDir(const std::string& p, bool wantDirs) {
    std::vector<std::string> out;
    WIN32_FIND_DATAW fd;
    std::wstring pat = utf8ToWide(joinPath(p, "*"));
    HANDLE h = FindFirstFileW(pat.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return out;
    do {
        std::string name = wideToUtf8(fd.cFileName);
        if (name == "." || name == "..") continue;
        bool isDir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (isDir == wantDirs) out.push_back(name);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return out;
}

std::string readFileTail(const std::string& p, int maxBytes) {
    HANDLE h = CreateFileW(utf8ToWide(p).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return "";
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    int64_t start = sz.QuadPart > maxBytes ? sz.QuadPart - maxBytes : 0;
    LARGE_INTEGER off{}; off.QuadPart = start;
    SetFilePointerEx(h, off, nullptr, FILE_BEGIN);
    std::string out;
    out.resize((size_t)(sz.QuadPart - start));
    DWORD rd = 0;
    if (!out.empty()) ReadFile(h, &out[0], (DWORD)out.size(), &rd, nullptr);
    out.resize(rd);
    CloseHandle(h);
    return out;
}

std::string readFileFrom(const std::string& p, int64_t offset) {
    HANDLE h = CreateFileW(utf8ToWide(p).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return "";
    LARGE_INTEGER sz{};
    GetFileSizeEx(h, &sz);
    if (sz.QuadPart < offset) { CloseHandle(h); return ""; }
    LARGE_INTEGER off{}; off.QuadPart = offset;
    SetFilePointerEx(h, off, nullptr, FILE_BEGIN);
    std::string out;
    out.resize((size_t)(sz.QuadPart - offset));
    DWORD rd = 0;
    if (!out.empty()) ReadFile(h, &out[0], (DWORD)out.size(), &rd, nullptr);
    out.resize(rd);
    CloseHandle(h);
    return out;
}

std::string envVar(const std::string& name) {
    wchar_t buf[32768];
    DWORD n = GetEnvironmentVariableW(utf8ToWide(name).c_str(), buf, 32768);
    if (n == 0 || n >= 32768) return "";
    return wideToUtf8(std::wstring(buf, n));
}

std::string localAppData() {
    PWSTR p = nullptr;
    std::string out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)) && p) out = wideToUtf8(p);
    if (p) CoTaskMemFree(p);
    if (out.empty()) out = envVar("LOCALAPPDATA");
    return out;
}

std::string userProfile() {
    PWSTR p = nullptr;
    std::string out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &p)) && p) out = wideToUtf8(p);
    if (p) CoTaskMemFree(p);
    if (out.empty()) out = envVar("USERPROFILE");
    return out;
}

std::string tempDir() {
    wchar_t buf[MAX_PATH + 1];
    DWORD n = GetTempPathW(MAX_PATH, buf);
    return n ? wideToUtf8(std::wstring(buf, n)) : envVar("TEMP");
}

std::string desktopFolder() {
    PWSTR p = nullptr;
    std::string out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Desktop, 0, nullptr, &p)) && p) out = wideToUtf8(p);
    if (p) CoTaskMemFree(p);
    if (!out.empty() && dirExists(out)) return out;
    std::string up = userProfile();
    if (dirExists(joinPath(up, "OneDrive\\Desktop"))) return joinPath(up, "OneDrive\\Desktop");
    if (dirExists(joinPath(up, "Desktop"))) return joinPath(up, "Desktop");
    return up;
}

std::string exeDir() {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH * 4);
    if (!n) return "";
    return dirName(wideToUtf8(std::wstring(buf, n)));
}

std::string stateDir() {
    // OCIN_STATE lets a portable copy keep its state next to the exe.
    std::string over = envVar("OCIN_STATE");
    if (!over.empty()) return over;
    return joinPath(localAppData(), "opencode-infinite");
}

std::string pathFromExe(const std::string& rel) {
    return joinPath(exeDir(), rel);
}

std::string nowStamp() {
    time_t t = time(nullptr);
    struct tm tmv;
    localtime_s(&tmv, &t);
    return fmt("%04d%02d%02d-%02d%02d%02d", tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
               tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
}

std::string nowStampMs() {
    SYSTEMTIME st;
    GetLocalTime(&st);
    return fmt("%04d%02d%02d%02d%02d%02d%03d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
}

int64_t nowSeconds() { return (int64_t)time(nullptr); }

std::string randToken(int len) {
    static const char* cs = "abcdefghijklmnopqrstuvwxyz0123456789";
    static std::mt19937 rng((unsigned)GetTickCount64() ^ (unsigned)time(nullptr));
    std::uniform_int_distribution<int> d(0, 35);
    std::string s;
    for (int i = 0; i < len; ++i) s.push_back(cs[d(rng)]);
    return s;
}

std::string quoteArg(const std::string& a) {
    std::string out = "\"";
    for (char c : a) { if (c == '"') out += "\\\""; else out.push_back(c); }
    out += "\"";
    return out;
}

std::string winLocaleCode() {
    wchar_t buf[LOCALE_NAME_MAX_LENGTH];
    if (GetUserDefaultLocaleName(buf, LOCALE_NAME_MAX_LENGTH) > 0) {
        std::string s = wideToUtf8(buf);
        size_t i = s.find('-');
        return lower(i == std::string::npos ? s : s.substr(0, i));
    }
    return "en";
}

std::string base64Encode(const std::string& in) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) { out.push_back(t[(val >> bits) & 0x3F]); bits -= 6; }
    }
    if (bits > -6) out.push_back(t[((val << 8) >> (bits + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

} // namespace oi

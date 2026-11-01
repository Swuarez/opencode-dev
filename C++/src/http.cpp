// http.cpp
#include "http.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <winhttp.h>
#include <vector>

namespace oi {

std::string proxyHostPort(const std::string& proxyUrl) {
    std::string s = trim(proxyUrl);
    size_t p = s.find("://");
    if (p != std::string::npos) s = s.substr(p + 3);
    while (!s.empty() && s.back() == '/') s.pop_back();
    return s;
}

namespace {

struct UrlParts {
    bool https = false;
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port = 0;
};

bool splitUrl(const std::string& url, UrlParts& u) {
    std::string s = trim(url);
    if (s.empty()) return false;
    if (s.compare(0, 8, "https://") == 0) { u.https = true; s = s.substr(8); }
    else if (s.compare(0, 7, "http://") == 0) { u.https = false; s = s.substr(7); }
    else return false;

    size_t slash = s.find('/');
    std::string hostport = slash == std::string::npos ? s : s.substr(0, slash);
    std::string path = slash == std::string::npos ? "/" : s.substr(slash);

    std::string host = hostport;
    size_t colon = hostport.find(':');
    if (colon != std::string::npos) {
        host = hostport.substr(0, colon);
        u.port = (INTERNET_PORT)atoi(hostport.substr(colon + 1).c_str());
    } else {
        u.port = u.https ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
    }
    u.host = utf8ToWide(host);
    u.path = utf8ToWide(path);
    return !u.host.empty();
}

struct Handle {
    HINTERNET h = nullptr;
    ~Handle() { if (h) WinHttpCloseHandle(h); }
};

} // namespace

HttpResult httpGet(const std::string& url, const std::string& proxyArg, int timeoutSec) {
    HttpResult r;
    UrlParts u;
    if (!splitUrl(url, u)) { r.error = "bad url"; return r; }

    std::wstring proxyW;
    std::string ph = proxyHostPort(proxyArg);
    if (!ph.empty()) proxyW = utf8ToWide(ph);

    Handle sess;
    sess.h = WinHttpOpen(L"OpenCodeInfinite/3.0",
                         proxyW.empty() ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_NAMED_PROXY,
                         proxyW.empty() ? WINHTTP_NO_PROXY_NAME : proxyW.c_str(),
                         WINHTTP_NO_PROXY_BYPASS, 0);
    if (!sess.h) { r.error = fmt("WinHttpOpen %lu", GetLastError()); return r; }

    int ms = timeoutSec > 0 ? timeoutSec * 1000 : 20000;
    WinHttpSetTimeouts(sess.h, ms, ms, ms, ms);

    Handle conn;
    conn.h = WinHttpConnect(sess.h, u.host.c_str(), u.port, 0);
    if (!conn.h) { r.error = fmt("connect %lu", GetLastError()); return r; }

    DWORD flags = u.https ? WINHTTP_FLAG_SECURE : 0;
    Handle req;
    req.h = WinHttpOpenRequest(conn.h, L"GET", u.path.c_str(), nullptr,
                               WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!req.h) { r.error = fmt("openreq %lu", GetLastError()); return r; }

    DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(req.h, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof(policy));
    // Modern TLS stacks only; fall back silently on older Windows.
    DWORD sec = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    WinHttpSetOption(req.h, WINHTTP_OPTION_SECURE_PROTOCOLS, &sec, sizeof(sec));

    if (!WinHttpSendRequest(req.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
        r.error = fmt("send %lu", GetLastError());
        return r;
    }
    if (!WinHttpReceiveResponse(req.h, nullptr)) {
        r.error = fmt("recv %lu", GetLastError());
        return r;
    }

    DWORD status = 0, len = sizeof(status);
    WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
    r.status = (int)status;

    // Cap the body so a hostile endpoint cannot exhaust memory.
    const size_t kMaxBody = 8 * 1024 * 1024;
    std::string body;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0) break;
        size_t want = avail;
        if (body.size() + want > kMaxBody) want = kMaxBody - body.size();
        if (want == 0) break;
        size_t old = body.size();
        body.resize(old + want);
        DWORD rd = 0;
        if (!WinHttpReadData(req.h, &body[old], (DWORD)want, &rd)) { body.resize(old); break; }
        body.resize(old + rd);
        if (rd == 0) break;
    }
    r.body = std::move(body);
    r.ok = (r.status >= 200 && r.status < 400);
    if (!r.ok && r.error.empty()) r.error = fmt("HTTP %d", r.status);
    return r;
}

bool httpDownload(const std::string& url, const std::string& outPath, const std::string& proxyArg,
                  int timeoutSec, uint64_t* sizeOut) {
    UrlParts u;
    if (!splitUrl(url, u)) return false;

    std::wstring proxyW;
    std::string ph = proxyHostPort(proxyArg);
    if (!ph.empty()) proxyW = utf8ToWide(ph);

    Handle sess;
    sess.h = WinHttpOpen(L"OpenCodeInfinite/3.0",
                         proxyW.empty() ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_NAMED_PROXY,
                         proxyW.empty() ? WINHTTP_NO_PROXY_NAME : proxyW.c_str(),
                         WINHTTP_NO_PROXY_BYPASS, 0);
    if (!sess.h) return false;
    int ms = timeoutSec > 0 ? timeoutSec * 1000 : 600000;
    WinHttpSetTimeouts(sess.h, ms, ms, ms, ms);

    Handle conn;
    conn.h = WinHttpConnect(sess.h, u.host.c_str(), u.port, 0);
    if (!conn.h) return false;

    Handle req;
    req.h = WinHttpOpenRequest(conn.h, L"GET", u.path.c_str(), nullptr, WINHTTP_NO_REFERER,
                               WINHTTP_DEFAULT_ACCEPT_TYPES, u.https ? WINHTTP_FLAG_SECURE : 0);
    if (!req.h) return false;
    DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(req.h, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof(policy));
    DWORD sec = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    WinHttpSetOption(req.h, WINHTTP_OPTION_SECURE_PROTOCOLS, &sec, sizeof(sec));

    if (!WinHttpSendRequest(req.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) return false;
    if (!WinHttpReceiveResponse(req.h, nullptr)) return false;

    DWORD status = 0, len = sizeof(status);
    WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
    if (status < 200 || status >= 400) return false;

    makeDirs(dirName(outPath));
    HANDLE f = CreateFileW(utf8ToWide(outPath).c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return false;

    uint64_t total = 0;
    std::vector<char> buf(65536);
    bool ok = true;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.h, &avail)) { ok = false; break; }
        if (avail == 0) break;
        DWORD want = avail > buf.size() ? (DWORD)buf.size() : avail;
        DWORD rd = 0;
        if (!WinHttpReadData(req.h, buf.data(), want, &rd)) { ok = false; break; }
        if (rd == 0) break;
        DWORD wr = 0;
        if (!WriteFile(f, buf.data(), rd, &wr, nullptr) || wr != rd) { ok = false; break; }
        total += rd;
    }
    CloseHandle(f);
    if (sizeOut) *sizeOut = total;
    if (!ok) removeFile(outPath);
    return ok && total > 0;
}

} // namespace oi

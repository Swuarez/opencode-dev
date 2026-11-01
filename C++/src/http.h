#pragma once
// http.h - tiny WinHTTP client (proxy-aware, TLS, redirects).
#include <string>
#include <cstdint>

namespace oi {

struct HttpResult {
    bool ok = false;
    int status = 0;
    std::string body;
    std::string error;
};

// proxyHostPort: "host:port" or "http://host:port"; empty = direct connection.
HttpResult httpGet(const std::string& url, const std::string& proxyHostPort, int timeoutSec);

// Streams a URL to a file, direct egress. Returns true when the file is written.
bool httpDownload(const std::string& url, const std::string& outPath, const std::string& proxyHostPort,
                  int timeoutSec, uint64_t* sizeOut = nullptr);

// "http://host:port" -> "host:port"
std::string proxyHostPort(const std::string& proxyUrl);

} // namespace oi

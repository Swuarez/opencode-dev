// torbridge.cpp
#include "torbridge.h"
#include "util.h"
#include "log.h"

#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace oi {

namespace {

bool winsockReady() {
    static bool init = [] {
        WSADATA d;
        return WSAStartup(MAKEWORD(2, 2), &d) == 0;
    }();
    return init;
}

bool sendAll(SOCKET s, const char* data, int len) {
    int sent = 0;
    while (sent < len) {
        int n = send(s, data + sent, len - sent, 0);
        if (n <= 0) return false;
        sent += n;
    }
    return true;
}

// SOCKS5 greeting + CONNECT with a domain name (no local DNS leak).
SOCKET socksConnect(const std::string& host, uint16_t port, uint16_t socksPort) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return INVALID_SOCKET;

    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(socksPort);
    inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
    if (connect(s, (sockaddr*)&sa, sizeof(sa)) != 0) { closesocket(s); return INVALID_SOCKET; }

    char greet[3] = {0x05, 0x01, 0x00};
    if (!sendAll(s, greet, 3)) { closesocket(s); return INVALID_SOCKET; }
    char resp[2] = {0, 0};
    if (recv(s, resp, 2, 0) != 2 || resp[0] != 0x05 || resp[1] != 0x00) { closesocket(s); return INVALID_SOCKET; }

    std::vector<char> req;
    req.push_back(0x05); req.push_back(0x01); req.push_back(0x00); req.push_back(0x03);
    req.push_back((char)host.size());
    req.insert(req.end(), host.begin(), host.end());
    req.push_back((char)(port >> 8));
    req.push_back((char)(port & 0xFF));
    if (!sendAll(s, req.data(), (int)req.size())) { closesocket(s); return INVALID_SOCKET; }

    char rep[4] = {0, 0, 0, 0};
    if (recv(s, rep, 4, 0) != 4 || rep[1] != 0x00) { closesocket(s); return INVALID_SOCKET; }
    int addrLen = rep[3] == 0x01 ? 4 : (rep[3] == 0x04 ? 16 : 0);
    if (addrLen == 0) {
        unsigned char n = 0;
        if (recv(s, (char*)&n, 1, 0) != 1) { closesocket(s); return INVALID_SOCKET; }
        addrLen = n;
    }
    char sink[264];
    int need = addrLen + 2;
    int got = 0;
    while (got < need) {
        int n = recv(s, sink + got, need - got, 0);
        if (n <= 0) { closesocket(s); return INVALID_SOCKET; }
        got += n;
    }
    return s;
}

void relay(SOCKET a, SOCKET b) {
    char buf[16384];
    for (;;) {
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(a, &rd);
        FD_SET(b, &rd);
        timeval tv{1, 0};
        int n = select(0, &rd, nullptr, nullptr, &tv);
        if (n <= 0) {
            if (n == 0) continue;
            break;
        }
        SOCKET src = FD_ISSET(a, &rd) ? a : b;
        SOCKET dst = src == a ? b : a;
        int r = recv(src, buf, sizeof(buf), 0);
        if (r <= 0) break;
        if (!sendAll(dst, buf, r)) break;
    }
}

std::string readHeaders(SOCKET s, std::string& rest) {
    std::string hdr;
    char c;
    while (hdr.size() < 32768) {
        int n = recv(s, &c, 1, 0);
        if (n <= 0) break;
        hdr.push_back(c);
        if (hdr.size() >= 4 && hdr.compare(hdr.size() - 4, 4, "\r\n\r\n") == 0) break;
    }
    rest = hdr;
    return hdr;
}

} // namespace

SocksBridge::~SocksBridge() { stop(); }

bool SocksBridge::start(uint16_t listenPort, uint16_t socksPort) {
    if (running_) return true;
    if (!winsockReady()) { logError("WSAStartup failed"); return false; }

    SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (ls == INVALID_SOCKET) return false;
    BOOL yes = TRUE;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, (char*)&yes, sizeof(yes));
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(listenPort);
    inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
    if (bind(ls, (sockaddr*)&sa, sizeof(sa)) != 0 || listen(ls, 32) != 0) {
        closesocket(ls);
        logError(fmt("tor bridge: cannot listen on 127.0.0.1:%u", listenPort));
        return false;
    }
    listener_ = (uintptr_t)ls;
    listenPort_ = listenPort;
    socksPort_ = socksPort;
    running_ = true;
    acceptThread_ = std::thread(&SocksBridge::acceptLoop, this);
    logInfo(fmt("tor bridge listening on 127.0.0.1:%u -> socks 127.0.0.1:%u", listenPort, socksPort));
    return true;
}

void SocksBridge::stop() {
    if (!running_) return;
    running_ = false;
    if (listener_ != (uintptr_t)-1) {
        closesocket((SOCKET)listener_);
        listener_ = (uintptr_t)-1;
    }
    if (acceptThread_.joinable()) acceptThread_.join();
    logInfo("tor bridge stopped");
}

void SocksBridge::acceptLoop() {
    while (running_) {
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET((SOCKET)listener_, &rd);
        timeval tv{1, 0};
        int n = select(0, &rd, nullptr, nullptr, &tv);
        if (n <= 0) continue;
        SOCKET c = accept((SOCKET)listener_, nullptr, nullptr);
        if (c == INVALID_SOCKET) continue;
        std::thread(&SocksBridge::handleClient, this, (uintptr_t)c).detach();
    }
}

void SocksBridge::handleClient(uintptr_t clientArg) {
    SOCKET client = (SOCKET)clientArg;
    int timeoutMs = 15000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (char*)&timeoutMs, sizeof(timeoutMs));

    std::string hdr = readHeaders(client, hdr);
    size_t eol = hdr.find("\r\n");
    if (eol == std::string::npos) { closesocket(client); return; }
    std::string reqLine = hdr.substr(0, eol);
    size_t s1 = reqLine.find(' ');
    size_t s2 = s1 == std::string::npos ? std::string::npos : reqLine.find(' ', s1 + 1);
    if (s1 == std::string::npos || s2 == std::string::npos) { closesocket(client); return; }

    std::string method = reqLine.substr(0, s1);
    std::string target = reqLine.substr(s1 + 1, s2 - s1 - 1);
    std::string version = reqLine.substr(s2 + 1);
    std::string rest = hdr.substr(eol + 2);

    std::string host;
    uint16_t port = 0;
    std::string originPath;

    if (iequals(method, "CONNECT")) {
        size_t colon = target.rfind(':');
        if (colon == std::string::npos) { closesocket(client); return; }
        host = target.substr(0, colon);
        port = (uint16_t)atoi(target.substr(colon + 1).c_str());
    } else {
        // absolute-URI form: http://host:port/path
        if (target.compare(0, 7, "http://") != 0) {
            const char* bad = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
            sendAll(client, bad, (int)strlen(bad));
            closesocket(client);
            return;
        }
        std::string r = target.substr(7);
        size_t slash = r.find('/');
        std::string hp = slash == std::string::npos ? r : r.substr(0, slash);
        originPath = slash == std::string::npos ? "/" : r.substr(slash);
        size_t colon = hp.rfind(':');
        if (colon != std::string::npos) { host = hp.substr(0, colon); port = (uint16_t)atoi(hp.substr(colon + 1).c_str()); }
        else { host = hp; port = 80; }
    }
    if (host.empty() || port == 0) { closesocket(client); return; }

    SOCKET remote = socksConnect(host, port, socksPort_);
    if (remote == INVALID_SOCKET) {
        const char* bad = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n";
        sendAll(client, bad, (int)strlen(bad));
        closesocket(client);
        return;
    }

    if (iequals(method, "CONNECT")) {
        const char* ok = "HTTP/1.1 200 Connection established\r\n\r\n";
        if (!sendAll(client, ok, (int)strlen(ok))) {
            closesocket(remote); closesocket(client); return;
        }
    } else {
        std::string out = method + " " + originPath + " " + version + "\r\n" + rest;
        if (!sendAll(client, out.data(), (int)out.size())) {
            closesocket(remote); closesocket(client); return;
        }
    }

    relay(client, remote);
    closesocket(remote);
    closesocket(client);
}

} // namespace oi

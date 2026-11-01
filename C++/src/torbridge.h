#pragma once
// torbridge.h - HTTP proxy on 127.0.0.1 that forwards through a SOCKS5 port.
// Windows Tor ships no HTTP bridge, so the launcher provides its own
// (the batch version did the same with an embedded PowerShell script).
#include <string>
#include <cstdint>
#include <thread>
#include <atomic>

namespace oi {

class SocksBridge {
public:
    ~SocksBridge();

    bool start(uint16_t listenPort, uint16_t socksPort);
    void stop();
    bool running() const { return running_; }
    uint16_t listenPort() const { return listenPort_; }

private:
    void acceptLoop();
    void handleClient(uintptr_t clientSock);

    std::atomic<bool> running_{false};
    uintptr_t listener_ = (uintptr_t)-1;
    uint16_t listenPort_ = 0;
    uint16_t socksPort_ = 0;
    std::thread acceptThread_;
};

} // namespace oi

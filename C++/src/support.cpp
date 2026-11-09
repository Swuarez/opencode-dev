// support.cpp
#include "support.h"
#include "util.h"
#include "log.h"
#include "proc.h"
#include "opencode.h"
#include "egress.h"

namespace oi {

static std::string maskIps(const std::string& text) {
    std::string out;
    size_t i = 0;
    while (i < text.size()) {
        if (isdigit((unsigned char)text[i])) {
            size_t j = i;
            int dots = 0;
            while (j < text.size() && (isdigit((unsigned char)text[j]) || text[j] == '.')) {
                if (text[j] == '.') ++dots;
                ++j;
            }
            std::string tok = text.substr(i, j - i);
            if (dots == 3 && tok.find("..") == std::string::npos) out += "x.x.x.x";
            else out += tok;
            i = j;
        } else {
            out.push_back(text[i++]);
        }
    }
    return out;
}

std::string writeSupportReport(const Config& cfg) {
    std::string dir = joinPath(cfg.dir(), "reports");
    makeDirs(dir);
    std::string path = joinPath(dir, "report-" + nowStamp() + ".txt");

    std::string r;
    r += "OpenCode Infinite - support report\n";
    r += "generated: " + nowStamp() + "\n";
    r += "launcher:  3.4.7 (C++ / ImGui)\n";
    r += "windows:   " + envVar("OS") + "\n";
    r += "arch:      " + envVar("PROCESSOR_ARCHITECTURE") + "\n";
    r += "elevated:  " + std::string(isElevated() ? "yes" : "no") + "\n";
    r += "\n[paths]\n";
    r += "state:     " + cfg.dir() + "\n";
    r += "opencode:  " + opencodeDataDir() + "\n";

    std::string warp = findOnPath("warp-cli.exe");
    if (warp.empty()) warp = joinPath(envVar("ProgramFiles"), "Cloudflare\\Cloudflare WARP\\warp-cli.exe");
    r += "warp-cli:  " + (fileExists(warp) ? warp : std::string("(not found)")) + "\n";

    std::string desktop = findDesktopApp(cfg);
    r += "desktop:   " + (desktop.empty() ? std::string("(not found)") : desktop) + "\n";
    if (!desktop.empty()) r += "desktop ver: " + desktopVersion(desktop) + "\n";

    r += "\n[settings]\n";
    for (const auto& d : Config::defs()) {
        r += fmt("%-24s = %s\n", d.key.c_str(), cfg.get(d.key).c_str());
    }

    r += "\n[log tail]\n";
    std::string tail = logTail(64 * 1024);
    if (cfg.b("LOG_MASK_IP")) tail = maskIps(tail);
    r += tail;
    r += "\n";

    if (!writeFileText(path, r)) return "";
    logInfo(fmt("support report written to %s", path.c_str()));
    return path;
}

} // namespace oi

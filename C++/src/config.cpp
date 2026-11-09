// config.cpp
#include "config.h"
#include "util.h"
#include "json.h"
#include "log.h"

#include <algorithm>
#include <cstdlib>

namespace oi {

static SettingDef S(const char* key, const char* group, const char* label, const char* desc,
                    SettingKind kind, const char* def,
                    std::vector<std::string> choices = {}, int mn = 0, int mx = 0) {
    SettingDef d;
    d.key = key; d.group = group; d.label = label; d.desc = desc;
    d.kind = kind; d.def = def; d.choices = std::move(choices);
    d.minv = mn; d.maxv = mx;
    return d;
}

const std::vector<SettingDef>& Config::defs() {
    static const std::string kProxyScrape =
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text";
    static const std::vector<SettingDef> v = {
        // Connection -------------------------------------------------------
        S("OC_EGRESS_DEFAULT", "Connection", "Connection method",
          "Egress used for opencode. ASK shows the picker at every start.",
          SettingKind::EnumK, "ASK", {"ASK", "WARP", "TOR", "PROXY", "WIREGUARD", "VPNGATE", "NONE"}),
        S("PROXY_PORT", "Connection", "WARP proxy port",
          "Local port of the WARP proxy.", SettingKind::NumK, "40000", {}, 1, 65535),
        S("WARP_WAIT", "Connection", "WARP wait (s)",
          "Seconds to wait after (re)connecting WARP.", SettingKind::NumK, "6", {}, 1, 60),
        S("WARP_CALL_TIMEOUT", "Connection", "warp-cli timeout (s)",
          "Seconds a single warp-cli call may take.", SettingKind::NumK, "15", {}, 5, 300),
        // Tor --------------------------------------------------------------
        S("TOR_SOCKS_PORT", "Tor", "Tor SOCKS port",
          "SOCKS port of the Tor the launcher starts.", SettingKind::NumK, "9050", {}, 1, 65535),
        S("TOR_HTTP_PORT", "Tor", "Tor HTTP bridge port",
          "HTTP port of the built-in bridge opencode uses.", SettingKind::NumK, "8118", {}, 1, 65535),
        S("TOR_AUTO_INSTALL", "Tor", "Install Tor automatically",
          "Download the portable Tor bundle when nothing answers.", SettingKind::BoolK, "1"),
        S("TOR_BOOTSTRAP_WAIT", "Tor", "Tor bootstrap wait (s)",
          "Seconds to wait for Tor to finish bootstrapping.", SettingKind::NumK, "120", {}, 30, 900),
        // WireGuard / VPN Gate (same keys as the .bat) ---------------------
        S("WG_DIR", "Egress", "WireGuard folder",
          "Folder with the WireGuard .conf files. Type - to use the default folder inside the launcher state folder.",
          SettingKind::TextK, ""),
        S("VPN_TIMEOUT", "Egress", "Seconds per attempt",
          "Seconds a tunnel gets to show a new exit IP before the next one is tried.", SettingKind::NumK, "45", {}, 10, 300),
        S("VPNGATE_COUNTRY", "Egress", "VPN Gate country",
          "Two-letter country code of the VPN Gate servers, for example JP. Type - for any country.",
          SettingKind::TextK, ""),
        S("VPNGATE_MAX", "Egress", "VPN Gate servers per start",
          "How many VPN Gate servers are tried, best score first, before the start gives up.",
          SettingKind::NumK, "8", {}, 1, 30),
        // Proxy list -------------------------------------------------------
        S("PROXY_LIST_URL", "Proxy list", "Proxy list source",
          "URL or local file, any format (plain, CSV, JSON, XML, HTML).",
          SettingKind::TextK, kProxyScrape.c_str()),
        S("PROXY_FIXED", "Proxy list", "Your own proxy",
          "host:port of a proxy you own. If set, it is used instead of the list. Empty = use the list.",
          SettingKind::TextK, ""),
        S("PROXY_LIST_MIN_BYTES", "Proxy list", "Minimum list size (bytes)",
          "A downloaded list smaller than this is rejected. 0 = off.",
          SettingKind::NumK, "20", {}, 0, 100000000),
        S("PROXY_TRY_MAX", "Proxy list", "Proxies tried per pick",
          "How many proxies to test before giving up.", SettingKind::NumK, "12", {}, 1, 500),
        S("PROXY_PROBE_TIMEOUT", "Proxy list", "Proxy test timeout (s)",
          "Seconds a single proxy test may take.", SettingKind::NumK, "8", {}, 1, 120),
        S("PROXY_ROT_MAX", "Proxy list", "Burned proxies before a warning",
          "Burned proxies in a row before a warning and a counter reset.", SettingKind::NumK, "10", {}, 1, 200),
        S("PROXY_API_CHECK", "Proxy list", "Check the API host",
          "A proxy must also reach the opencode API host.", SettingKind::BoolK, "0"),
        S("PROXY_API_CHECK_URL", "Proxy list", "API check URL",
          "Host used by the API check.", SettingKind::TextK, "https://api.opencode.ai/"),
        // Rotation ---------------------------------------------------------
        S("ROTATE_TRIES_MAX", "Rotation", "Rotation attempts",
          "Attempts per round when the tunnel is not up.", SettingKind::NumK, "4", {}, 1, 20),
        S("ROTATE_COOLDOWN", "Rotation", "Cooldown between attempts (s)",
          "Cloudflare throttles rapid registrations.", SettingKind::NumK, "10", {}, 0, 300),
        S("ON_CLOSE", "Rotation", "After opencode closes",
          "ask = R, M or Q: R gets a new IP and restarts the app, M opens the menu, Q quits. quit = leave the launcher at once.",
          SettingKind::EnumK, "ask", {"ask", "quit"}),
        S("IP_FIND_MAX", "Rotation", "Burned IPs allowed",
          "IPs the probe may reject before giving up. 0 = no limit.", SettingKind::NumK, "0", {}, 0, 10000),
        S("AUTO_ROTATE", "Rotation", "Automatic rotation",
          "On: a limit or a closed opencode gets a new IP and the app restarts. Off: the menu decides.",
          SettingKind::BoolK, "1"),
        S("TARGET_COUNTRY", "Rotation", "Target country",
          "Keep asking for IPs until one is in this country, e.g. DE. Empty = any new IP.",
          SettingKind::TextK, ""),
        S("TARGET_PREFIX", "Rotation", "Target IP prefix",
          "Keep asking until the IP starts with this, e.g. 104.28. Empty = not used.",
          SettingKind::TextK, ""),
        S("TARGET_INTERVAL", "Rotation", "Seconds between attempts",
          "Pause between two attempts, so Cloudflare is not hit too fast.", SettingKind::NumK, "15", {}, 0, 300),
        S("TARGET_TRIES", "Rotation", "Max attempts per hunt",
          "New IPs requested in one hunt. The hunt stops at this count.", SettingKind::NumK, "5", {}, 1, 100),
        S("TARGET_MINUTES", "Rotation", "Max minutes per hunt",
          "The hunt stops after this many minutes.", SettingKind::NumK, "15", {}, 1, 240),
        // IP pool (PROXY, WIREGUARD, VPNGATE) ------------------------------
        S("POOL_ENABLE", "Rotation", "Keep a pool of IPs",
          "While Settings is open, look for working IPs in the background (PROXY, WIREGUARD, VPNGATE) and keep them for the next rotation.",
          SettingKind::BoolK, "1"),
        S("POOL_MAX", "Rotation", "Saved IPs per mode",
          "How many working IPs the pool keeps for each mode. The oldest is dropped first.", SettingKind::NumK, "5", {}, 1, 50),
        S("POOL_INTERVAL", "Rotation", "Seconds between pool searches",
          "Pause between two background searches.", SettingKind::NumK, "60", {}, 5, 3600),
        // Watcher ----------------------------------------------------------
        S("CRASH_RETRY", "Watcher", "Retry after a crash",
          "A crash restarts OpenCode on the same connection after a short wait. More than 2 crashes in 10 minutes stop it.",
          SettingKind::BoolK, "1"),
        S("WATCH", "Watcher", "Watch the log",
          "Rotate when a fatal error appears while opencode runs. Off by default since 2.60.3.", SettingKind::BoolK, "0"),
        // Probe ------------------------------------------------------------
        S("PROBE", "Probe", "Test every new IP",
          "Send one cheap message through each candidate IP. Off by default: each probe uses the free quota; the session it creates is deleted afterwards.", SettingKind::BoolK, "0"),
        S("PROBE_MODEL", "Probe", "Probe model",
          "Model used by the IP probe (empty = the chat model).", SettingKind::TextK, ""),
        S("PROBE_BROKEN_MAX", "Probe", "Probe failures tolerated",
          "Non-limit probe failures before the hunt stops.", SettingKind::NumK, "3", {}, 1, 50),
        // Paths ------------------------------------------------------------
        S("OC_APP", "Paths", "Desktop app path",
          "Full path of OpenCode.exe. Empty = search automatically.", SettingKind::TextK, ""),
        S("OC_API_BASE", "Paths", "Release metadata URL",
          "Where versions and checksums are read from.", SettingKind::TextK,
          "https://opencode.ai/update/api/latest"),
        // Updates ----------------------------------------------------------
        S("UPDATE_CHECK", "Updates", "Launcher self-update",
          "Check your release URL for a newer launcher.", SettingKind::BoolK, "1"),
        S("LAUNCHER_UPDATE_URL", "Updates", "Launcher release URL",
          "JSON endpoint of your own launcher releases. Empty = no self-update check.",
          SettingKind::TextK, ""),
        S("UPDATE_ASK", "Updates", "Update prompts",
          "ask = offer newer versions at start. never = no update checks and no prompts.",
          SettingKind::EnumK, "ask", {"ask", "never"}),
        // Appearance -------------------------------------------------------
        S("OCUI_THEME", "Appearance", "Color theme",
          "Accent colors of the interface.", SettingKind::EnumK, "black",
          {"black", "ocean", "forest", "sunset", "mono"}),
        S("OCUI_LANG", "Appearance", "Language",
          "Language of the menus and descriptions. auto follows Windows. Logs and the support report stay in English.",
          SettingKind::EnumK, "auto", {"auto", "en", "es", "fr", "de", "pt", "it", "tr"}),
        S("OCUI_FONT", "Appearance", "Font",
          "Typeface of the window. The text size is always the same.",
          SettingKind::EnumK, "segoe", {"segoe", "tahoma", "arial", "consolas"}),
        // Shortcuts --------------------------------------------------------
        S("KEY_ROTATE", "Shortcuts", "Rotate key",
          "Closed-opencode prompt: new IP and restart the app.", SettingKind::TextK, "R"),
        S("KEY_MENU", "Shortcuts", "Menu key",
          "Closed-opencode prompt: open the menu.", SettingKind::TextK, "M"),
        S("KEY_QUIT", "Shortcuts", "Quit key",
          "Closed-opencode prompt: quit.", SettingKind::TextK, "Q"),
        // Support ----------------------------------------------------------
        S("LOG_ENABLED", "Support", "Activity log",
          "Record what the launcher does in launcher.log so a problem can be diagnosed.",
          SettingKind::BoolK, "1"),
        S("LOG_MAX_KB", "Support", "Log size limit (KB)",
          "The log is cut to its newest part when it grows past this.", SettingKind::NumK, "1024", {}, 64, 10240),
        S("LOG_MASK_IP", "Support", "Hide IPs in reports",
          "Public IP addresses are masked in the support report.", SettingKind::BoolK, "1"),
    };
    return v;
}

const SettingDef* Config::findDef(const std::string& key) {
    for (const auto& d : defs()) if (d.key == key) return &d;
    return nullptr;
}

std::vector<std::string> Config::groups() {
    std::vector<std::string> out;
    for (const auto& d : defs()) {
        if (std::find(out.begin(), out.end(), d.group) == out.end()) out.push_back(d.group);
    }
    return out;
}

void Config::load(const std::string& stateDir) {
    dir_ = stateDir;
    makeDirs(dir_);
    vals_.clear();
    std::string p = path();
    if (!fileExists(p)) return;
    std::string err;
    Json j = Json::parse(readFileText(p), &err);
    if (!j.isObject()) { removeFile(p + ".bad"); if (!moveFileTo(p, p + ".bad")) logWarn("config.json is not valid and could not be moved aside"); return; }  // keep the unreadable file; save() must not overwrite it silently
    raw_ = j;   // keeps keys this build does not know (the .bat's own settings)
    // The .bat keeps its values under "settings"; older builds of this exe wrote them at the top level.
    const Json& src = j.has("settings") && j["settings"].isObject() ? j["settings"] : j;
    for (const auto& k : src.keys()) {
        const Json& v = src[k];
        if (v.isString()) vals_[k] = v.asString();
        else if (v.isBool()) vals_[k] = v.asBool() ? "1" : "0";
        else if (v.isNumber()) vals_[k] = fmt("%lld", v.asInt());
    }
}

// Same files as the .bat: config.json is { version, settings, setup, font } where settings
// holds only the values that differ from the default (booleans 0/1, numbers as numbers);
// config.env (KEY=value, read by opencode-infinite.sh) holds every value. Keys this build does
// not know are kept, so a setting changed by another launcher is not lost.
void Config::save() const {
    Json st = Json::object();
    const Json& prev = raw_.has("settings") && raw_["settings"].isObject() ? raw_["settings"] : raw_;
    for (const auto& k : prev.keys()) if (!findDef(k)) st.set(k, prev[k]);
    for (const auto& d : defs()) {
        auto it = vals_.find(d.key);
        std::string v = it != vals_.end() ? it->second : d.def;
        if (v == d.def) continue;
        if (d.kind == SettingKind::BoolK) st.set(d.key, Json(v == "1" || lower(v) == "true" ? 1 : 0));
        else if (d.kind == SettingKind::NumK) st.set(d.key, Json((int)atoll(v.c_str())));
        else st.set(d.key, Json(v));
    }
    Json root = Json::object();
    root.set("version", Json(1));
    root.set("settings", st);
    root.set("setup", raw_.has("setup") ? raw_["setup"] : Json::object());
    root.set("font", raw_.has("font") ? raw_["font"] : Json::object());
    if (!writeFileText(path(), root.dump(2) + "\n")) logWarn("config.json could not be written");

    std::string env;
    for (const auto& d : defs()) {
        std::string v = get(d.key);
        if (d.kind == SettingKind::BoolK) v = (v == "1" || lower(v) == "true") ? "1" : "0";
        else if (d.kind == SettingKind::NumK) v = std::to_string(atoll(v.c_str()));
        env += d.key + "=" + v + "\n";
    }
    for (const auto& k : st.keys()) {
        if (findDef(k)) continue;
        const Json& v = st[k];
        if (v.isBool()) env += k + "=" + (v.asBool() ? "1" : "0") + "\n";
        else if (v.isNumber()) env += k + "=" + fmt("%lld", v.asInt()) + "\n";
        else if (v.isString()) env += k + "=" + v.asString() + "\n";
    }
    writeFileText(joinPath(dir_, "config.env"), env);
}

std::string Config::path() const { return joinPath(dir_, "config.json"); }

const std::string& Config::get(const std::string& key) const {
    auto it = vals_.find(key);
    if (it != vals_.end()) return it->second;
    const SettingDef* d = findDef(key);
    if (d) return d->def;
    static const std::string empty;
    return empty;
}

void Config::set(const std::string& key, const std::string& val) {
    vals_[key] = val;
}

bool Config::b(const std::string& key) const {
    std::string v = lower(trim(get(key)));
    return v == "1" || v == "true" || v == "on" || v == "yes";
}

int Config::i(const std::string& key) const { return atoi(get(key).c_str()); }

std::string Config::s(const std::string& key) const { return get(key); }

bool Config::isDefault(const std::string& key) const {
    const SettingDef* d = findDef(key);
    if (!d) return true;
    return get(key) == d->def;
}

void Config::resetAll() { vals_.clear(); }

std::string Config::exportJson() const {
    Json j = Json::object();
    for (const auto& d : defs()) j.set(d.key, Json(get(d.key)));
    return j.dump(2);
}

bool Config::importJson(const std::string& text) {
    std::string err;
    Json j = Json::parse(text, &err);
    if (!j.isObject()) return false;
    int taken = 0;
    for (const auto& k : j.keys()) {
        const SettingDef* d = findDef(k);
        if (!d) continue;
        const Json& v = j[k];
        std::string val = v.isString() ? v.asString()
                        : v.isBool() ? (v.asBool() ? "1" : "0")
                        : v.isNumber() ? fmt("%lld", v.asInt()) : "";
        if (val.empty() && !v.isString()) continue;
        if (d->kind == SettingKind::EnumK && !d->choices.empty()) {
            bool ok = false;
            for (const auto& c : d->choices) if (iequals(c, val)) { val = c; ok = true; }
            if (!ok) continue;
        }
        if (d->kind == SettingKind::NumK && d->maxv > d->minv && (atoll(val.c_str()) < d->minv || atoll(val.c_str()) > d->maxv)) continue;
        vals_[k] = val;
        ++taken;
    }
    return taken > 0;
}

} // namespace oi

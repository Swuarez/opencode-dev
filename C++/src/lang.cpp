// lang.cpp
#include "lang.h"
#include "util.h"
#include "json.h"
#include "http.h"
#include "log.h"

#include <map>

namespace oi {

// Same logic as the bash launcher: load_lang() fills the table, tx() looks a key up
// and returns the English text when the language has no entry.
static std::map<std::string, std::string> g_map;

const std::vector<LangInfo>& langs() {
    static const std::vector<LangInfo> v = {
        {"en", "English"},
        {"es", "Espanol"},
        {"fr", "Francais"},
        {"de", "Deutsch"},
        {"pt", "Portugues"},
        {"it", "Italiano"},
        {"tr", "Turkce"},
    };
    return v;
}

std::string auto_lang() {
    std::string code = winLocaleCode();
    for (const auto& l : langs()) if (code == l.code) return code;
    return "en";
}

// Same folder and source as the .bat: stateDir\lang\<code>.json, downloaded from the repo.
void load_lang(const std::string& stateDir, const std::string& langCode, bool fetch) {
    g_map.clear();
    std::string code = langCode;
    if (code.empty() || code == "auto") code = auto_lang();
    if (code == "en") return; // English is the identity

    std::string dir = joinPath(stateDir, "lang");
    std::string file = joinPath(dir, code + ".json");
    if (fetch || !fileExists(file)) {
        HttpResult r = httpGet("https://gitlab.com/jekooo/opencode-infinite/-/raw/main/langs/" + code + ".json", "", 8);
        std::string err;
        if (r.ok && Json::parse(r.body, &err).isObject()) {
            makeDirs(dir);
            writeFileText(file, r.body);
        } else {
            logWarn("language " + code + " not downloaded: " + (r.error.empty() ? std::string("bad file") : r.error));
        }
    }
    if (!fileExists(file)) return;
    std::string err;
    Json j = Json::parse(readFileText(file), &err);
    if (!j.isObject()) return;
    for (const auto& k : j.keys()) g_map[k] = j[k].asString();
}

std::string tx(const std::string& key) {
    auto it = g_map.find(key);
    return it != g_map.end() ? it->second : key;
}

static std::string substitute(const std::string& s, const std::vector<std::string>& args) {
    std::string out = s;
    for (size_t i = 0; i < args.size(); ++i) {
        out = replaceAll(out, fmt("{%d}", (int)i), args[i]);
    }
    return out;
}

std::string tx(const std::string& key, const std::vector<std::string>& args) {
    return substitute(tx(key), args);
}

std::string tx(const std::string& key, const std::string& a0) {
    return substitute(tx(key), {a0});
}

std::string tx(const std::string& key, const std::string& a0, const std::string& a1) {
    return substitute(tx(key), {a0, a1});
}

} // namespace oi

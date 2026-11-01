#pragma once
// config.h - every launcher setting, saved to config.json in the state folder.
#include <string>
#include <vector>
#include <map>

#include "json.h"

namespace oi {

enum class SettingKind { BoolK, NumK, TextK, EnumK };

struct SettingDef {
    std::string key;
    std::string group;
    std::string label;      // English text, also the lang key
    std::string desc;       // English text, also the lang key
    SettingKind kind = SettingKind::TextK;
    std::string def;
    std::vector<std::string> choices;   // EnumK only
    int minv = 0, maxv = 0;             // NumK bounds (0,0 = unbounded)
};

class Config {
public:
    void load(const std::string& stateDir);
    void save() const;

    const std::string& get(const std::string& key) const;
    void set(const std::string& key, const std::string& val);
    bool b(const std::string& key) const;
    int  i(const std::string& key) const;
    std::string s(const std::string& key) const;

    bool isDefault(const std::string& key) const;
    void resetAll();

    std::string dir() const { return dir_; }
    std::string path() const;
    std::string exportJson() const;
    bool importJson(const std::string& text);

    static const std::vector<SettingDef>& defs();
    static const SettingDef* findDef(const std::string& key);
    static std::vector<std::string> groups();

private:
    std::string dir_;
    std::map<std::string, std::string> vals_;
    Json raw_;   // the whole config.json as read, unknown keys included
};

} // namespace oi

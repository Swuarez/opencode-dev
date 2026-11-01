#pragma once
// lang.h - translations from <stateDir>\lang\<code>.json, downloaded from the repo.
// Same names as the bash launcher: load_lang() reads the table, tx() translates.
// The keys are the English texts, so a missing key shows English.
#include <string>
#include <vector>

namespace oi {

struct LangInfo { const char* code; const char* english; };

const std::vector<LangInfo>& langs();
std::string auto_lang();                                    // language of the Windows UI
void        load_lang(const std::string& stateDir, const std::string& langCode, bool fetch = false);
std::string tx(const std::string& key);
std::string tx(const std::string& key, const std::string& a0);
std::string tx(const std::string& key, const std::string& a0, const std::string& a1);
std::string tx(const std::string& key, const std::vector<std::string>& args);

} // namespace oi

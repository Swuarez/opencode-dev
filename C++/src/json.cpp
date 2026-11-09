// json.cpp
#include "json.h"
#include "util.h"

#include <cstdio>
#include <cstdlib>

namespace oi {

static const Json& nullJson() { static Json n; return n; }

const Json& Json::at(size_t i) const {
    if (t_ != Type::Array || i >= arr_.size()) return nullJson();
    return arr_[i];
}

const Json& Json::operator[](const std::string& k) const {
    if (t_ != Type::Object) return nullJson();
    auto it = obj_.find(k);
    return it == obj_.end() ? nullJson() : it->second;
}

Json& Json::operator[](const std::string& k) {
    if (t_ != Type::Object) { t_ = Type::Object; }
    auto it = obj_.find(k);
    if (it == obj_.end()) { keys_.push_back(k); obj_[k] = Json(); return obj_[k]; }
    return it->second;
}

void Json::set(const std::string& k, const Json& v) { (*this)[k] = v; }

namespace {

struct Parser {
    const std::string& s;
    size_t i = 0;
    std::string err;

    explicit Parser(const std::string& in) : s(in) {}

    void ws() {
        while (i < s.size()) {
            char c = s[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++i; continue; }
            if (c == '/' && i + 1 < s.size() && s[i + 1] == '/') { while (i < s.size() && s[i] != '\n') ++i; continue; }
            if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
                i += 2;
                while (i + 1 < s.size() && !(s[i] == '*' && s[i + 1] == '/')) ++i;
                i = (i + 1 < s.size()) ? i + 2 : s.size();
                continue;
            }
            if ((unsigned char)c == 0xEF && i + 2 < s.size() && (unsigned char)s[i + 1] == 0xBB && (unsigned char)s[i + 2] == 0xBF) { i += 3; continue; }
            break;
        }
    }

    int depth = 0;  // nesting of arrays and objects, capped so a deeply nested reply cannot overflow the stack
    bool fail(const std::string& m) { if (err.empty()) err = m; return false; }

    bool parseValue(Json& out) {
        ws();
        if (i >= s.size()) return fail("unexpected end");
        char c = s[i];
        if (c == '{' || c == '[') {
            if (++depth > 200) return fail("too deep");
            bool ok = c == '{' ? parseObject(out) : parseArray(out);
            --depth;
            return ok;
        }
        if (c == '"') { std::string str; if (!parseString(str)) return false; out = Json(str); return true; }
        if (c == 't') { if (s.compare(i, 4, "true") == 0) { i += 4; out = Json(true); return true; } return fail("bad literal"); }
        if (c == 'f') { if (s.compare(i, 5, "false") == 0) { i += 5; out = Json(false); return true; } return fail("bad literal"); }
        if (c == 'n') { if (s.compare(i, 4, "null") == 0) { i += 4; out = Json(); return true; } return fail("bad literal"); }
        return parseNumber(out);
    }

    bool parseNumber(Json& out) {
        size_t start = i;
        if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
        while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) ++i;
        if (i == start) return fail("bad number");
        out = Json(strtod(s.substr(start, i - start).c_str(), nullptr));
        return true;
    }

    bool parseString(std::string& out) {
        if (s[i] != '"') return fail("expected string");
        ++i;
        out.clear();
        while (i < s.size()) {
            char c = s[i++];
            if (c == '"') return true;
            if (c == '\\') {
                if (i >= s.size()) return fail("bad escape");
                char e = s[i++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        if (i + 4 > s.size()) return fail("bad unicode");
                        unsigned cp = (unsigned)strtoul(s.substr(i, 4).c_str(), nullptr, 16);
                        i += 4;
                        if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                            unsigned lo = (unsigned)strtoul(s.substr(i + 2, 4).c_str(), nullptr, 16);
                            if (lo < 0xDC00 || lo > 0xDFFF) return fail("bad unicode");
                            i += 6;
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        }
                        // UTF-8 encode
                        if (cp < 0x80) out.push_back((char)cp);
                        else if (cp < 0x800) { out.push_back((char)(0xC0 | (cp >> 6))); out.push_back((char)(0x80 | (cp & 0x3F))); }
                        else if (cp < 0x10000) { out.push_back((char)(0xE0 | (cp >> 12))); out.push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out.push_back((char)(0x80 | (cp & 0x3F))); }
                        else { out.push_back((char)(0xF0 | (cp >> 18))); out.push_back((char)(0x80 | ((cp >> 12) & 0x3F))); out.push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out.push_back((char)(0x80 | (cp & 0x3F))); }
                        break;
                    }
                    default: out.push_back(e); break;
                }
            } else {
                out.push_back(c);
            }
        }
        return fail("unterminated string");
    }

    bool parseArray(Json& out) {
        ++i; // [
        out = Json::array();
        ws();
        if (i < s.size() && s[i] == ']') { ++i; return true; }
        while (true) {
            Json v;
            if (!parseValue(v)) return false;
            out.push(v);
            ws();
            if (i >= s.size()) return fail("unterminated array");
            if (s[i] == ',') { ++i; continue; }
            if (s[i] == ']') { ++i; return true; }
            return fail("expected , or ]");
        }
    }

    bool parseObject(Json& out) {
        ++i; // {
        out = Json::object();
        ws();
        if (i < s.size() && s[i] == '}') { ++i; return true; }
        while (true) {
            ws();
            std::string key;
            if (!parseString(key)) return false;
            ws();
            if (i >= s.size() || s[i] != ':') return fail("expected :");
            ++i;
            Json v;
            if (!parseValue(v)) return false;
            out.set(key, v);
            ws();
            if (i >= s.size()) return fail("unterminated object");
            if (s[i] == ',') { ++i; continue; }
            if (s[i] == '}') { ++i; return true; }
            return fail("expected , or }");
        }
    }
};

void escapeTo(std::string& out, const std::string& s) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); out += b; }
                else out.push_back((char)c);
        }
    }
    out.push_back('"');
}

} // namespace

Json Json::parse(const std::string& text, std::string* err) {
    Parser p(text);
    Json out;
    if (!p.parseValue(out)) { if (err) *err = p.err; return Json(); }
    if (err) err->clear();
    return out;
}

void Json::dumpTo(std::string& out, int indent, int level) const {
    std::string pad(indent * level, ' ');
    std::string padIn(indent * (level + 1), ' ');
    switch (t_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += b_ ? "true" : "false"; break;
        case Type::Number: {
            char b[64];
            if (n_ == (double)(long long)n_) sprintf_s(b, "%lld", (long long)n_);
            else sprintf_s(b, "%.6g", n_);
            out += b;
            break;
        }
        case Type::String: escapeTo(out, s_); break;
        case Type::Array: {
            if (arr_.empty()) { out += "[]"; break; }
            out += "[\n";
            for (size_t k = 0; k < arr_.size(); ++k) {
                out += padIn;
                arr_[k].dumpTo(out, indent, level + 1);
                if (k + 1 < arr_.size()) out += ",";
                out += "\n";
            }
            out += pad + "]";
            break;
        }
        case Type::Object: {
            if (keys_.empty()) { out += "{}"; break; }
            out += "{\n";
            for (size_t k = 0; k < keys_.size(); ++k) {
                out += padIn;
                escapeTo(out, keys_[k]);
                out += ": ";
                auto it = obj_.find(keys_[k]);
                if (it != obj_.end()) it->second.dumpTo(out, indent, level + 1);
                else out += "null";
                if (k + 1 < keys_.size()) out += ",";
                out += "\n";
            }
            out += pad + "}";
            break;
        }
    }
}

std::string Json::dump(int indent) const {
    std::string out;
    dumpTo(out, indent, 0);
    return out;
}

} // namespace oi

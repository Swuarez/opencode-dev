#pragma once
// json.h - small self-contained JSON value / parser / writer.
#include <string>
#include <vector>
#include <map>

namespace oi {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() : t_(Type::Null) {}
    Json(bool b) : t_(Type::Bool), b_(b) {}
    Json(double n) : t_(Type::Number), n_(n) {}
    Json(int n) : t_(Type::Number), n_((double)n) {}
    Json(const std::string& s) : t_(Type::String), s_(s) {}
    Json(const char* s) : t_(Type::String), s_(s ? s : "") {}

    static Json array() { Json j; j.t_ = Type::Array; return j; }
    static Json object() { Json j; j.t_ = Type::Object; return j; }
    static Json parse(const std::string& text, std::string* err = nullptr);

    Type type() const { return t_; }
    bool isNull() const { return t_ == Type::Null; }
    bool isBool() const { return t_ == Type::Bool; }
    bool isNumber() const { return t_ == Type::Number; }
    bool isString() const { return t_ == Type::String; }
    bool isArray() const { return t_ == Type::Array; }
    bool isObject() const { return t_ == Type::Object; }

    bool asBool(bool def = false) const { return t_ == Type::Bool ? b_ : def; }
    double asNumber(double def = 0) const { return t_ == Type::Number ? n_ : def; }
    long long asInt(long long def = 0) const { return t_ == Type::Number ? (long long)n_ : def; }
    std::string asString(const std::string& def = "") const { return t_ == Type::String ? s_ : def; }

    size_t size() const { return t_ == Type::Array ? arr_.size() : (t_ == Type::Object ? keys_.size() : 0); }
    const Json& at(size_t i) const;
    const Json& operator[](const std::string& k) const;
    Json& operator[](const std::string& k);
    bool has(const std::string& k) const { return t_ == Type::Object && obj_.count(k) > 0; }
    const std::vector<std::string>& keys() const { return keys_; }

    void push(const Json& v) { if (t_ != Type::Array) { t_ = Type::Array; } arr_.push_back(v); }
    void set(const std::string& k, const Json& v);

    std::string dump(int indent = 2) const;

private:
    void dumpTo(std::string& out, int indent, int level) const;
    Type t_;
    bool b_ = false;
    double n_ = 0;
    std::string s_;
    std::vector<Json> arr_;
    std::vector<std::string> keys_;
    std::map<std::string, Json> obj_;
};

} // namespace oi

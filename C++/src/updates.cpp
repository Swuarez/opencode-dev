// updates.cpp
#include "updates.h"
#include "http.h"
#include "json.h"
#include "util.h"
#include "proc.h"
#include "log.h"
#include "opencode.h"

#include <windows.h>
#include <bcrypt.h>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace oi {

ReleaseInfo fetchRelease(const std::string& apiBase, const std::string& kind) {
    ReleaseInfo ri;
    std::string url = apiBase;
    while (!url.empty() && url.back() == '/') url.pop_back();
    url += "/" + kind + "/opencode/";

    HttpResult r = httpGet(url, "", 20);
    if (!r.ok) { logWarn(fmt("release check failed: %s", r.error.c_str())); return ri; }
    std::string err;
    Json j = Json::parse(r.body, &err);
    if (!j.isObject()) return ri;

    ri.version = j["version"].asString();
    const Json& files = j["metadata"]["files"];
    if (files.isObject()) {
        for (const auto& name : files.keys()) {
            const Json& f = files[name];
            ReleaseFile rf;
            rf.url = f["url"].asString();
            rf.sha256 = f["sha256"].asString();
            rf.size = (uint64_t)f["size"].asInt();
            ri.files[name] = rf;
        }
    }
    ri.ok = !ri.version.empty();
    return ri;
}

static std::vector<long long> versionParts(const std::string& v) {
    std::vector<long long> out;
    std::string cur;
    for (char c : v) {
        if (isdigit((unsigned char)c)) cur.push_back(c);
        else if (c == '.') { out.push_back(cur.empty() ? 0 : atoll(cur.c_str())); cur.clear(); }
        else if (!cur.empty()) { out.push_back(atoll(cur.c_str())); cur.clear(); }
    }
    out.push_back(cur.empty() ? 0 : atoll(cur.c_str()));
    return out;
}

bool versionGreater(const std::string& a, const std::string& b) {
    auto va = versionParts(a), vb = versionParts(b);
    size_t n = va.size() > vb.size() ? va.size() : vb.size();
    for (size_t i = 0; i < n; ++i) {
        long long x = i < va.size() ? va[i] : 0;
        long long y = i < vb.size() ? vb[i] : 0;
        if (x != y) return x > y;
    }
    return false;
}

std::string sha256File(const std::string& path) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return "";
    DWORD objLen = 0, cb = 0;
    BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objLen, sizeof(objLen), &cb, 0);
    std::vector<BYTE> obj(objLen);
    BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptCreateHash(alg, &hash, obj.data(), objLen, nullptr, 0, 0) != 0) {
        BCryptCloseAlgorithmProvider(alg, 0);
        return "";
    }
    HANDLE f = CreateFileW(utf8ToWide(path).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) {
        BCryptDestroyHash(hash);
        BCryptCloseAlgorithmProvider(alg, 0);
        return "";
    }
    std::vector<BYTE> buf(65536);
    DWORD rd = 0;
    while (ReadFile(f, buf.data(), (DWORD)buf.size(), &rd, nullptr) && rd > 0) {
        BCryptHashData(hash, buf.data(), rd, 0);
    }
    CloseHandle(f);
    BYTE digest[32];
    std::string out;
    if (BCryptFinishHash(hash, digest, 32, 0) == 0) {
        for (BYTE b : digest) out += fmt("%02x", b);
    }
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);
    return out;
}

LauncherUpdate checkLauncherUpdate(const std::string& url, const std::string& currentVersion) {
    LauncherUpdate lu;
    if (url.empty()) return lu;
    HttpResult r = httpGet(url, "", 20);
    if (!r.ok) return lu;
    std::string err;
    Json j = Json::parse(r.body, &err);
    if (!j.isObject()) return lu;
    lu.ok = true;
    lu.version = j["version"].asString();
    lu.url = j["url"].asString();
    if (lu.url.empty()) lu.url = j["download_url"].asString();
    lu.available = !lu.version.empty() && versionGreater(lu.version, currentVersion);
    return lu;
}

bool installDesktopFromRelease(const ReleaseInfo& rel, const std::string& fileName, std::string* errOut) {
    auto it = rel.files.find(fileName);
    if (it == rel.files.end()) {
        if (errOut) *errOut = fmt("the release does not list %s", fileName.c_str());
        return false;
    }
    const ReleaseFile& f = it->second;
    std::string setup = joinPath(tempDir(), "opencode-desktop-setup.exe");
    removeFile(setup);

    uint64_t got = 0;
    if (!httpDownload(f.url, setup, "", 900, &got)) {
        if (errOut) *errOut = "the installer download failed.";
        return false;
    }
    if (f.size > 0 && got < f.size / 2) {
        removeFile(setup);
        if (errOut) *errOut = "the installer download is far smaller than announced.";
        return false;
    }
    if (!f.sha256.empty()) {
        std::string have = sha256File(setup);
        if (!iequals(have, f.sha256)) {
            removeFile(setup);
            if (errOut) *errOut = "the installer checksum does not match the published one.";
            return false;
        }
    }
    // the caller stops its own OpenCode first (App::stopApp); one opened by hand is not killed here
    RunResult r = runCapture(setup, "/S", {}, 600000);
    removeFile(setup);
    if (!r.started) {
        if (errOut) *errOut = "the installer could not be started.";
        return false;
    }
    logInfo(fmt("desktop installer exit code %d", r.exitCode));
    return true;
}

} // namespace oi

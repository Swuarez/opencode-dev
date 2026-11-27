"use strict";
const core = (function () {
  try {
    const rotateCore = (function (module, exports) {
"use strict";
// WARP egress rotation core. WARP stays in local proxy mode on 127.0.0.1:40000,
// so only the app that is pointed at that proxy leaves through it; the rest of
// the machine keeps its own route. Plain CJS with no Electron imports so it can
// be tested standalone. Windows and macOS share this file.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const PROXY_PORT = 40000;
const PROXY_URL = "http://127.0.0.1:" + PROXY_PORT;
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const NO_PROXY = "localhost,127.0.0.1,0.0.0.0,::1,[::1]";
const MAX_CYCLES = 3;
const CONNECT_WAIT_MS = 45000;
const TRACE_WAIT_MS = 20000;

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const WIN_WARP_CLI = "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe";
const MAC_WARP_CLI = [
  "/usr/local/bin/warp-cli",
  "/opt/homebrew/bin/warp-cli",
  "/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli",
];

function resolveWarpCli() {
  if (!IS_MAC) return WIN_WARP_CLI;
  for (let i = 0; i < MAC_WARP_CLI.length; i++) {
    if (fs.existsSync(MAC_WARP_CLI[i])) return MAC_WARP_CLI[i];
  }
  return MAC_WARP_CLI[0];
}

const WARP_CLI = resolveWarpCli();
const CURL = IS_WIN ? "C:\\Windows\\System32\\curl.exe" : "/usr/bin/curl";
const OSASCRIPT = "/usr/bin/osascript";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateDir() {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
    return path.join(base, "opencode-infinite-desktop");
  }
  if (IS_MAC) {
    return path.join(os.homedir(), "Library", "Application Support", "opencode-infinite-desktop");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode-infinite-desktop");
}

function exec(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      if (!error) return resolve({ code: 0, out });
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: out || String(error.message || "") });
    });
  });
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function appleLiteral(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// warp-cli on macOS talks to a root daemon. Settings reads work for anyone;
// registration changes may not. The first permission error flips this process
// to the osascript path, which runs the same command with one admin prompt.
let macAdmin = null;

function adminFlagFile() {
  return path.join(stateDir(), "warp-admin.json");
}

function macAdminWanted() {
  if (macAdmin !== null) return macAdmin;
  try {
    const raw = JSON.parse(fs.readFileSync(adminFlagFile(), "utf8"));
    macAdmin = raw && raw.admin === true;
  } catch (error) {
    macAdmin = false;
  }
  return macAdmin;
}

function rememberMacAdmin(value) {
  macAdmin = value;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(adminFlagFile(), JSON.stringify({ admin: value === true }) + "\n", "utf8");
  } catch (error) {
  }
}

function permissionDenied(text) {
  return /permission denied|operation not permitted|access denied|must be run as root|not authorized|authorization denied|try sudo|run with sudo|EPERM/i.test(
    String(text || "")
  );
}

function adminWarp(args) {
  const line = [WARP_CLI, "--accept-tos"].concat(args).map(shellQuote).join(" ");
  const script = "do shell script " + appleLiteral(line + " 2>&1") + " with administrator privileges";
  return exec(OSASCRIPT, ["-e", script], 180000);
}

// One osascript call for a whole list of warp-cli commands: macOS asks for the
// admin password once per osascript, not once per command.
function adminSteps(steps) {
  const parts = steps.map((args) => {
    const line = [WARP_CLI, "--accept-tos"].concat(args).map(shellQuote).join(" ");
    return line + ' 2>&1 || echo "FAILED ' + args.join(" ") + '"';
  });
  const script = "do shell script " + appleLiteral(parts.join("; ") + "; true") + " with administrator privileges";
  return exec(OSASCRIPT, ["-e", script], 240000).then((r) => {
    const aborted = r.code !== 0 && r.out.indexOf("FAILED ") < 0;
    const out = r.out || "";
    return steps.map((args) => {
      const failed = aborted || out.indexOf("FAILED " + args.join(" ")) >= 0;
      return { args, code: failed ? 1 : 0, out: out };
    });
  });
}

async function runSteps(steps, escalate) {
  if (IS_WIN) {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      results.push(Object.assign({ args: steps[i] }, await exec(WARP_CLI, ["--accept-tos", ...steps[i]], 90000)));
    }
    return results;
  }
  if (macAdminWanted()) return adminSteps(steps);
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(Object.assign({ args: steps[i] }, await exec(WARP_CLI, ["--accept-tos", ...steps[i]], 90000)));
  }
  const denied = results.some((r) => r.code !== 0 && permissionDenied(r.out));
  if (denied && escalate) {
    rememberMacAdmin(true);
    return adminSteps(steps);
  }
  return results;
}

async function warp(args) {
  if (IS_WIN) return exec(WARP_CLI, ["--accept-tos", ...args], 90000);
  if (macAdminWanted()) return adminWarp(args);
  return exec(WARP_CLI, ["--accept-tos", ...args], 90000);
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return line ? line.slice(0, 200) : "no output";
}

function isConnected(text) {
  return /Status update:\s*Connected/i.test(text);
}

function isProxyMode(text) {
  return /Mode:\s*(WarpProxy|Proxy)\b/i.test(text);
}

function parseTrace(text) {
  const ip = /^ip=(.+)$/m.exec(text || "");
  return { ip: ip ? ip[1].trim() : "", warp: /^warp=on$/m.test(text || "") };
}

// The trace goes through the local WARP proxy, which is exactly the path the
// app takes. A warp=on answer means the app's egress is the WARP exit.
async function traceProxied() {
  const r = await exec(CURL, ["-s", "--max-time", "12", "--proxy", PROXY_URL, TRACE_URL], 20000);
  if (r.code !== 0) return { ip: "", warp: false, error: firstLine(r.out) || "curl exit " + r.code };
  const t = parseTrace(r.out);
  return t.ip ? { ip: t.ip, warp: t.warp, error: "" } : { ip: "", warp: false, error: "trace returned no address" };
}

async function warpStatus() {
  const st = await warp(["status"]);
  return { connected: isConnected(st.out), text: firstLine(st.out) };
}

async function waitConnected(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await warpStatus()).connected) return true;
    await sleep(750);
  }
  return false;
}

async function waitTrace(ms) {
  const end = Date.now() + ms;
  let last = { ip: "", warp: false, error: "no answer" };
  while (Date.now() < end) {
    last = await traceProxied();
    if (last.ip) return last;
    await sleep(750);
  }
  return last;
}

// Proxy mode on the fixed port, connected. A full-tunnel mode left behind by an
// older build is switched back, otherwise every process on the machine would be
// on the WARP exit instead of just the app pointed at the proxy.
async function ensureProxy(log, options) {
  const opts = options || {};
  if (!fs.existsSync(WARP_CLI)) {
    return {
      ok: false,
      detail:
        IS_WIN
          ? "Cloudflare WARP is not installed; run the setup once with --install-warp"
          : "Cloudflare WARP is not installed; run the installer once more and accept the WARP install",
    };
  }
  const settings = await warp(["settings"]);
  if (!isProxyMode(settings.out)) {
    const set = await runSteps([["mode", "proxy"]], opts.escalate === true);
    if (set[0].code !== 0) {
      return { ok: false, detail: "could not switch WARP to proxy mode: " + firstLine(set[0].out) };
    }
    log("info", "infinite warp mode", { to: "proxy", port: PROXY_PORT });
    await sleep(1200);
  }
  // In macOS admin mode every runSteps call is a password prompt, and the port
  // is set again by the rotation itself, so it is skipped when it would prompt.
  if (!(IS_MAC && macAdminWanted())) {
    const port = await runSteps([["proxy", "port", String(PROXY_PORT)]], opts.escalate === true);
    if (port[0].code !== 0) log("warn", "infinite proxy port", { detail: firstLine(port[0].out) });
  }
  const st = await warpStatus();
  if (!st.connected) {
    const con = await runSteps([["connect"]], opts.escalate === true);
    if (con[0].code !== 0) log("warn", "infinite connect retry", { detail: firstLine(con[0].out) });
    if (!(await waitConnected(20000))) {
      return { ok: false, detail: "WARP did not reach Connected" };
    }
  }
  return { ok: true, detail: "WARP proxy on 127.0.0.1:" + PROXY_PORT + " connected" };
}

async function readRoute() {
  if (!fs.existsSync(WARP_CLI)) {
    return { phase: "direct", exit: "", detail: "Cloudflare WARP is not installed" };
  }
  // Reads never prompt: an app start must not ask for an admin password.
  const fixed = await ensureProxy(() => {}, { escalate: false });
  if (!fixed.ok) return { phase: "direct", exit: "", detail: fixed.detail + "; traffic goes direct" };
  const t = await traceProxied();
  if (!t.ip) return { phase: "direct", exit: "", detail: "proxy is up but the trace did not answer: " + firstLine(t.error) };
  if (!t.warp) return { phase: "direct", exit: t.ip, detail: "proxy exit " + t.ip + " but warp=off on the trace" };
  return { phase: "warp", exit: t.ip, detail: "WARP proxy exit " + t.ip };
}

function writeRoute(ip) {
  const record = {
    mode: "proxy",
    proxy: PROXY_URL,
    port: PROXY_PORT,
    ip,
    warp: true,
    updated: new Date().toISOString(),
    app: process.execPath,
  };
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), "route.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (e) {
  }
  return record;
}

// One full registration cycle: keep proxy mode -> drop device -> register ->
// connect -> read the proxied exit. On macOS the whole list goes through a
// single admin prompt.
async function cycle(log) {
  const steps = [
    ["mode", "proxy"],
    ["proxy", "port", String(PROXY_PORT)],
    ["disconnect"],
    ["registration", "delete"],
    ["registration", "new"],
    ["connect"],
  ];
  const res = await runSteps(steps, true);
  const modeR = res[0];
  const delR = res[3];
  const newR = res[4];
  const conR = res[5];
  if (modeR.code !== 0) return { ok: false, detail: "could not set proxy mode: " + firstLine(modeR.out) };
  if (delR.code !== 0) log("warn", "infinite registration delete", { detail: firstLine(delR.out) });
  if (newR.code !== 0) return { ok: false, detail: "could not register a new device: " + firstLine(newR.out) };
  if (conR.code !== 0) log("warn", "infinite connect retry", { detail: firstLine(conR.out) });
  if (!(await waitConnected(CONNECT_WAIT_MS))) {
    await runSteps([["connect"]], true);
    if (!(await waitConnected(20000))) return { ok: false, detail: "WARP did not reach Connected" };
  }
  const trace = await waitTrace(TRACE_WAIT_MS);
  if (!trace.ip) return { ok: false, detail: "trace did not answer after reconnect: " + firstLine(trace.error) };
  return { ok: true, exit: trace.ip, warp: trace.warp };
}

async function rotateEgress(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const up = await ensureProxy(log);
  if (!up.ok) return { ok: false, detail: up.detail, exit: "" };
  const before = await traceProxied();
  log("info", "infinite rotate start", { exit: before.ip || "(none)", mode: "proxy" });
  let lastDetail = "rotation did not run";
  for (let attempt = 1; attempt <= MAX_CYCLES; attempt++) {
    const r = await cycle(log);
    if (!r.ok) {
      lastDetail = r.detail;
      log("warn", "infinite rotate cycle failed", { attempt, detail: r.detail });
      await sleep(1500);
      continue;
    }
    if (!before.ip || r.exit !== before.ip) {
      writeRoute(r.exit);
      return { ok: true, detail: "new exit " + r.exit, exit: r.exit };
    }
    lastDetail = "exit unchanged at " + r.exit + "; the edge reused the address";
    log("warn", "infinite rotate same exit", { attempt, exit: r.exit });
    await sleep(1500);
  }
  await warp(["connect"]);
  await waitConnected(15000);
  return { ok: false, detail: lastDetail, exit: "" };
}

// The CLI server inside the app is what calls the model API, so the proxy goes
// in the app process environment. Chromium stays direct, which keeps the
// renderer's loopback event stream off the proxy.
function proxyEnv() {
  return {
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    ALL_PROXY: PROXY_URL,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    all_proxy: PROXY_URL,
    NO_PROXY: NO_PROXY,
    no_proxy: NO_PROXY,
  };
}

function proxyEnvLines() {
  const env = proxyEnv();
  return Object.keys(env).map((key) => 'set "' + key + "=" + env[key] + '"');
}

function winRelaunchScript(appPath, cliPath) {
  const lines = [
    "@echo off",
    "setlocal",
    'set "STATE=%LOCALAPPDATA%\\opencode-infinite-desktop"',
    'set "DESKTOP_STATE=%STATE%\\state"',
    'set "LOG=%STATE%\\relaunch.log"',
    "if not exist \"%STATE%\" mkdir \"%STATE%\"",
    "if not exist \"%DESKTOP_STATE%\\opencode\" mkdir \"%DESKTOP_STATE%\\opencode\"",
    'echo [%DATE% %TIME%] relaunch requested >> "%LOG%"',
    "ping -n 3 127.0.0.1 >nul",
  ];
  if (!cliPath || cliPath.length === 0) {
    cliPath = path.join(path.dirname(appPath || ""), "resources", "opencode-cli.exe");
  }
  lines.push('if exist "' + cliPath + '" "' + cliPath + '" service stop >nul 2>&1');
  lines.push("ping -n 2 127.0.0.1 >nul");
  lines.push(...proxyEnvLines());
  lines.push('echo [%DATE% %TIME%] starting with local WARP proxy env >> "%LOG%"');
  lines.push('start "" "' + appPath + '"');
  lines.push("goto :eof");
  return lines.join("\r\n") + "\r\n";
}

function macRelaunchScript(appPath, cliPath) {
  const lines = [
    "#!/bin/bash",
    "# Written by the infinite plugin. Restarts the desktop with the local WARP",
    "# proxy in its environment so the CLI server inside it leaves via WARP.",
    "set -u",
    'STATE="$HOME/Library/Application Support/opencode-infinite-desktop"',
    'LOG="$STATE/relaunch.log"',
    'mkdir -p "$STATE"',
    'printf "%s relaunch requested\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"',
    "sleep 1",
  ];
  if (cliPath && cliPath.length > 0) {
    lines.push(shellQuote(cliPath) + ' service stop >>"$LOG" 2>&1');
    lines.push("sleep 1");
  }
  const env = proxyEnv();
  Object.keys(env).forEach((key) => {
    lines.push("export " + key + "=" + shellQuote(env[key]));
  });
  lines.push("unset ELECTRON_RUN_AS_NODE");
  lines.push('printf "%s starting with local WARP proxy env\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"');
  lines.push("nohup " + shellQuote(appPath) + " >/dev/null 2>&1 &");
  lines.push("disown >/dev/null 2>&1 || true");
  return lines.join("\n") + "\n";
}

function relaunchScript(appPath, cliPath) {
  if (IS_WIN) return winRelaunchScript(appPath, cliPath);
  return macRelaunchScript(appPath, cliPath);
}

function scheduleRelaunch(appPath, cliPath) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    fs.mkdirSync(path.join(dir, "state", "opencode"), { recursive: true });
    const cmd = path.join(dir, "relaunch.cmd");
    fs.writeFileSync(cmd, relaunchScript(appPath, cliPath), "utf8");
    spawn("cmd.exe", ["/d", "/c", "call", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return cmd;
  }
  const script = path.join(dir, "relaunch.sh");
  fs.writeFileSync(script, relaunchScript(appPath, cliPath), "utf8");
  fs.chmodSync(script, 0o755);
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  return script;
}

// ---------------------------------------------------------------------------
// Free-pool probe.
//
// The free tier is one server-side bucket shared by every free model id, and it
// is not keyed on the egress address: a freshly registered WARP device resolved
// to a different exit and still reported the same Retry-After to the second.
// What the client can actually know is the refill instant, so that is what gets
// recorded and shown. A probe is a real one-token completion, so it only runs
// when asked; while the pool is dry it costs nothing because the server answers
// before generating.
// ---------------------------------------------------------------------------

const POOL_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
const POOL_TIMEOUT_MS = 30000;
const POOL_OPEN_TTL_MS = 5 * 60 * 1000;

// Shared bucket members, most capable first.
const FREE_MODELS = [
  "deepseek-v4.1-flash-free",
  "big-pickle",
  "inkling-2-small-free",
  "longcat-2.5-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "mimo-v2.6-flash-free",
  "hy4-flash-free",
  "beam-free",
  "flint-40b-free",
  "iceman-free",
];

function poolFile() {
  return path.join(stateDir(), "pool.json");
}

// Direct egress on purpose: node:https ignores the proxy variables, which is
// what we want because the answer describes the credential, not the route.
function httpsPost(url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      return resolve({ status: 0, headers: {}, body: String(error.message || error) });
    }
    const data = Buffer.from(body, "utf8");
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.request({
      method: "POST",
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": String(data.length) }, headers),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        if (size < 8192) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      res.on("end", () => {
        done({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8").slice(0, 8192),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", (error) => done({ status: 0, headers: {}, body: String((error && error.message) || error) }));
    req.write(data);
    req.end();
  });
}

function parseRetryAfter(headers) {
  const raw = headers && (headers["retry-after"] || headers["Retry-After"]);
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return 0;
}

function readPoolRecord() {
  try {
    const raw = JSON.parse(fs.readFileSync(poolFile(), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (error) {
    return null;
  }
}

function writePoolRecord(record) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(poolFile(), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (error) {
  }
  return record;
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
  if (minutes > 0) return minutes + "m " + String(seconds).padStart(2, "0") + "s";
  return seconds + "s";
}

// Reads the stored probe and ages it, so the pill can count down without
// spending a completion on every repaint.
function poolSnapshot() {
  const record = readPoolRecord();
  if (!record) {
    return { state: "unknown", model: "", refillAt: "", remainingMs: 0, detail: "free pool not checked yet" };
  }
  const now = Date.now();
  if (record.state === "open") {
    const age = now - Date.parse(record.checkedAt || "");
    if (Number.isFinite(age) && age < POOL_OPEN_TTL_MS) {
      return {
        state: "open",
        model: record.model || "",
        refillAt: "",
        remainingMs: 0,
        detail: "free pool answers now" + (record.model ? " (" + record.model + ")" : ""),
      };
    }
    return { state: "unknown", model: record.model || "", refillAt: "", remainingMs: 0, detail: "free pool state is stale" };
  }
  const refillAt = Date.parse(record.refillAt || "");
  const remaining = Number.isFinite(refillAt) ? Math.max(0, refillAt - now) : 0;
  if (record.state === "empty") {
    if (remaining <= 0) {
      return {
        state: "ready",
        model: record.model || "",
        refillAt: record.refillAt || "",
        remainingMs: 0,
        detail: "free pool refill time has passed; send again",
      };
    }
    return {
      state: "empty",
      model: record.model || "",
      refillAt: record.refillAt || "",
      remainingMs: remaining,
      detail: "free pool empty, refills in " + formatRemaining(remaining),
    };
  }
  return { state: "unknown", model: record.model || "", refillAt: "", remainingMs: 0, detail: record.detail || "free pool state unknown" };
}

async function probePool(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const model = opts.model && String(opts.model).length > 0 ? String(opts.model) : FREE_MODELS[0];
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
  const result = await httpsPost(POOL_URL, body, { Authorization: "Bearer public" }, POOL_TIMEOUT_MS);
  const checkedAt = new Date().toISOString();
  log("info", "infinite pool probe", { model, status: result.status });

  if (result.status === 200 || result.status === 201) {
    writePoolRecord({ state: "open", model, checkedAt, refillAt: "" });
    return { state: "open", model, refillAt: "", remainingMs: 0, detail: "free pool answers now (" + model + ")" };
  }
  if (result.status === 429) {
    const delayMs = parseRetryAfter(result.headers) || 60 * 60 * 1000;
    const refillAt = new Date(Date.now() + delayMs).toISOString();
    writePoolRecord({ state: "empty", model, checkedAt, refillAt, retryAfterMs: delayMs });
    return {
      state: "empty",
      model,
      refillAt,
      remainingMs: delayMs,
      detail: "free pool empty, refills in " + formatRemaining(delayMs) + " (" + model + ")",
    };
  }
  if (result.status === 0) {
    return { state: "unknown", model, refillAt: "", remainingMs: 0, detail: "no answer: " + String(result.body || "").slice(0, 160) };
  }
  const text = String(result.body || "").replace(/\s+/g, " ").slice(0, 200);
  return { state: "unknown", model, refillAt: "", remainingMs: 0, detail: "HTTP " + result.status + ": " + text };
}

module.exports = {
  WARP_CLI,
  PROXY_PORT,
  PROXY_URL,
  NO_PROXY,
  FREE_MODELS,
  proxyEnv,
  readRoute,
  traceProxied,
  rotateEgress,
  scheduleRelaunch,
  relaunchScript,
  writeRoute,
  probePool,
  poolSnapshot,
  formatRemaining,
};

      return module.exports;
    })({ exports: {} }, {});
    const localCore = (function (module, exports) {
"use strict";
// Local inference core: downloads a llama.cpp server build and one GGUF model,
// runs the server on loopback, and registers it as an OpenCode provider.
//
// Nothing here talks to a quota server. The model runs on the machine it is
// installed on, so the free-tier bucket, the egress address and the credential
// are all irrelevant. Plain CJS, node built-ins only, so it can be tested
// without Electron.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const IS_WIN = process.platform === "win32";

// Pinned engine build. The asset list for a tag is stable, so an install that
// worked yesterday still resolves to the same binary today.
const ENGINE_TAG = "b12528";
const ENGINE_CPU = {
  file: "llama-" + ENGINE_TAG + "-bin-win-cpu-x64.zip",
  size: 25670675,
};
const ENGINE_VULKAN = {
  file: "llama-" + ENGINE_TAG + "-bin-win-vulkan-x64.zip",
  size: 38878452,
};

function engineUrl(asset) {
  return "https://github.com/ggml-org/llama.cpp/releases/download/" + ENGINE_TAG + "/" + asset.file;
}

// Two sizes. Anything under 8 GB of RAM gets the 1.7B; it leaves room for the
// OS, the context cache and whatever else the machine is doing.
const LOCAL_MODELS = {
  small: {
    id: "qwen2.5-coder-1.5b",
    alias: "qwen2.5-coder-1.5b",
    name: "Qwen2.5 Coder 1.5B (local)",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    size: 1117320768,
    context: 8192,
    output: 2048,
    minRam: 0,
  },
  standard: {
    id: "qwen3-4b",
    alias: "qwen3-4b-instruct",
    name: "Qwen3 4B Instruct (local)",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    size: 2497281120,
    context: 16384,
    output: 4096,
    minRam: 8 * 1024 * 1024 * 1024,
  },
};

const HEALTH_WAIT_MS = 120000;
const DOWNLOAD_IDLE_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateDir() {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
    return path.join(base, "opencode-infinite-desktop");
  }
  return path.join(os.homedir(), "Library", "Application Support", "opencode-infinite-desktop");
}

function llmDir() {
  return path.join(stateDir(), "llm");
}

function engineDir() {
  return path.join(llmDir(), "engine");
}

function modelsDir() {
  return path.join(llmDir(), "models");
}

function serverFile() {
  return path.join(llmDir(), "server.json");
}

function engineExe() {
  return path.join(engineDir(), "llama-server.exe");
}

function configPath() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, ".config", "opencode", "opencode.json");
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return line ? line.slice(0, 240) : "no output";
}

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// HTTP: manual redirects (Hugging Face bounces to a CDN host), Range resume,
// and a hard idle timeout so a stalled socket cannot hang the setup forever.
// ---------------------------------------------------------------------------

function httpGet(url, options, onResponse, redirects) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      return resolve({ ok: false, detail: "bad url: " + String(error && error.message) });
    }
    const req = https.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: Object.assign({ "User-Agent": "opencode-infinite-desktop", "Accept-Encoding": "identity" }, options.headers || {}),
        timeout: DOWNLOAD_IDLE_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const hops = (redirects || 0) + 1;
          res.resume();
          if (hops > 8) return resolve({ ok: false, detail: "too many redirects" });
          const next = new URL(res.headers.location, url).toString();
          return resolve(httpGet(next, options, onResponse, hops));
        }
        resolve(onResponse(res, status));
      }
    );
    req.on("timeout", () => req.destroy(new Error("download stalled")));
    req.on("error", (error) => resolve({ ok: false, detail: firstLine(error && error.message) }));
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error("cancelled"));
      } else {
        options.signal.addEventListener("abort", () => req.destroy(new Error("cancelled")), { once: true });
      }
    }
    req.end();
  });
}

function headSize(url, signal) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      return resolve({ ok: false, detail: "bad url" });
    }
    const req = https.request(
      {
        method: "HEAD",
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers: { "User-Agent": "opencode-infinite-desktop" },
        timeout: 20000,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve(headSize(new URL(res.headers.location, url).toString(), signal));
        }
        const length = Number(res.headers["x-linked-size"] || res.headers["content-length"] || 0);
        res.resume();
        resolve({ ok: status === 200, status, size: Number.isFinite(length) ? length : 0 });
      }
    );
    req.on("timeout", () => req.destroy(new Error("head timed out")));
    req.on("error", (error) => resolve({ ok: false, detail: firstLine(error && error.message) }));
    if (signal) {
      if (signal.aborted) req.destroy(new Error("cancelled"));
      else signal.addEventListener("abort", () => req.destroy(new Error("cancelled")), { once: true });
    }
    req.end();
  });
}

// Downloads to `<file>.part` and only renames when the byte count matches the
// length the server reported, so an interrupted run never looks installed.
async function download(url, dest, expected, onProgress, signal) {
  mkdir(path.dirname(dest));
  const part = dest + ".part";
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch (error) {
    have = 0;
  }
  if (have > 0 && expected > 0 && have > expected) {
    fs.unlinkSync(part);
    have = 0;
  }
  if (have > 0 && expected > 0 && have === expected) {
    fs.renameSync(part, dest);
    return { ok: true, bytes: have, resumed: true };
  }

  const headers = {};
  if (have > 0) headers.Range = "bytes=" + have + "-";

  let writing = true;
  const result = await httpGet(
    url,
    { headers, signal },
    (res, status) => {
      return new Promise((resolve) => {
        if (status !== 200 && status !== 206) {
          res.resume();
          return resolve({ ok: false, detail: "HTTP " + status });
        }
        // A server that ignores Range answers 200 with the whole body.
        if (status === 200 && have > 0) {
          have = 0;
        }
        const total = expected > 0 ? expected : Number(res.headers["content-length"] || 0) + have;
        const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
        let written = have;
        let lastTick = 0;
        res.on("data", (chunk) => {
          if (!writing) return;
          written += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 400) {
            lastTick = now;
            onProgress({ bytes: written, total, percent: total > 0 ? Math.min(100, Math.floor((written / total) * 100)) : 0 });
          }
        });
        res.on("error", (error) => {
          writing = false;
          out.end(() => resolve({ ok: false, detail: firstLine(error && error.message) }));
        });
        res.pipe(out);
        out.on("finish", () => {
          writing = false;
          const size = fs.statSync(part).size;
          if (total > 0 && size !== total) {
            return resolve({ ok: false, detail: "size mismatch: have " + size + " of " + total });
          }
          fs.renameSync(part, dest);
          resolve({ ok: true, bytes: size, resumed: have > 0 });
        });
        out.on("error", (error) => {
          writing = false;
          resolve({ ok: false, detail: firstLine(error && error.message) });
        });
      });
    }
  );
  return result;
}

// ---------------------------------------------------------------------------
// Engine install
// ---------------------------------------------------------------------------

function extractZip(zip, dir) {
  return new Promise((resolve) => {
    mkdir(dir);
    // bsdtar ships with Windows 10 1803+ and is the only extractor that is
    // guaranteed to exist without loading a PowerShell profile.
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    execFile(tar, ["-xf", zip, "-C", dir], { timeout: 180000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, detail: "extracted" });
      resolve({ ok: false, detail: firstLine(String(stderr || stdout || (error && error.message))) });
    });
  });
}

function hasVulkan() {
  if (!IS_WIN) return false;
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"));
  } catch (error) {
    return false;
  }
}

function engineReady() {
  try {
    return fs.statSync(engineExe()).size > 0;
  } catch (error) {
    return false;
  }
}

async function installEngine(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  if (engineReady()) return { ok: true, detail: "engine already installed", path: engineExe() };
  const asset = hasVulkan() ? ENGINE_VULKAN : ENGINE_CPU;
  mkdir(llmDir());
  const zip = path.join(llmDir(), asset.file);
  log("info", "infinite local engine download", { asset: asset.file, size: asset.size });
  const got = await download(engineUrl(asset), zip, asset.size, opts.onProgress, opts.signal);
  if (!got.ok) return { ok: false, detail: "engine download failed: " + got.detail };
  const ex = await extractZip(zip, engineDir());
  if (!ex.ok) return { ok: false, detail: "engine extract failed: " + ex.detail };
  try {
    fs.unlinkSync(zip);
  } catch (error) {
  }
  if (!engineReady()) return { ok: false, detail: "engine zip did not contain llama-server.exe" };
  return { ok: true, detail: "engine installed (" + asset.file + ")", path: engineExe() };
}

// ---------------------------------------------------------------------------
// Model install
// ---------------------------------------------------------------------------

function pickModel() {
  const ram = os.totalmem();
  return ram >= LOCAL_MODELS.standard.minRam ? LOCAL_MODELS.standard : LOCAL_MODELS.small;
}

function modelPath(model) {
  return path.join(modelsDir(), model.file);
}

function modelReady(model) {
  try {
    return fs.statSync(modelPath(model)).size === model.size;
  } catch (error) {
    return false;
  }
}

async function installModel(model, options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  if (modelReady(model)) return { ok: true, detail: "model already installed", path: modelPath(model) };
  log("info", "infinite local model download", { model: model.id, size: model.size });
  mkdir(modelsDir());
  const got = await download(model.url, modelPath(model), model.size, opts.onProgress, opts.signal);
  if (!got.ok) return { ok: false, detail: "model download failed: " + got.detail };
  return { ok: true, detail: "model installed (" + model.file + ")", path: modelPath(model) };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on("error", () => resolve(0));
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function readServer() {
  try {
    return JSON.parse(fs.readFileSync(serverFile(), "utf8"));
  } catch (error) {
    return null;
  }
}

function writeServer(record) {
  try {
    mkdir(llmDir());
    fs.writeFileSync(serverFile(), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (error) {
  }
  return record;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function health(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        method: "GET",
        hostname: "127.0.0.1",
        port,
        path: "/health",
        timeout: timeoutMs || 2000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let ok = res.statusCode === 200;
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.status && parsed.status !== "ok") ok = false;
          } catch (error) {
          }
          resolve({ ok, status: res.statusCode || 0, body: body.slice(0, 200) });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("health timed out")));
    req.on("error", (error) => resolve({ ok: false, status: 0, body: firstLine(error && error.message) }));
    req.end();
  });
}

async function waitHealth(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = await health(port, 2500);
    if (h.ok) return true;
    await sleep(700);
  }
  return false;
}

let child = null;
let childPort = 0;

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
  }
}

async function stopLocalServer() {
  const record = readServer();
  if (child) {
    try {
      child.kill();
    } catch (error) {
    }
    child = null;
  }
  if (record && record.pid) killTree(record.pid);
  try {
    fs.unlinkSync(serverFile());
  } catch (error) {
  }
  childPort = 0;
  return { ok: true, detail: "local server stopped" };
}

function serverArgs(model, modelFile, port, context, gpuLayers, apiKey) {
  const args = [
    "--model", modelFile,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", String(context),
    "--n-gpu-layers", String(gpuLayers),
    "--parallel", "1",
    "--no-webui",
    "--alias", model.alias,
    "--api-key", apiKey,
    "--jinja",
  ];
  const threads = Math.max(2, Math.min(8, (os.cpus() || []).length - 1));
  args.push("--threads", String(threads));
  return args;
}

async function startLocalServer(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const model = opts.model || pickModel();
  if (!engineReady()) return { ok: false, detail: "engine is not installed" };
  if (!modelReady(model)) return { ok: false, detail: "model is not installed" };
  const existing = readServer();
  if (existing && existing.pid && alive(existing.pid) && existing.port) {
    const h = await health(existing.port, 2500);
    if (h.ok) {
      childPort = existing.port;
      return { ok: true, port: existing.port, alias: existing.alias, detail: "local server already running", reused: true };
    }
  }
  if (existing && existing.pid) killTree(existing.pid);

  const port = opts.port || (await freePort());
  if (!port) return { ok: false, detail: "no free loopback port" };
  const apiKey = opts.apiKey || ("local-" + Math.floor(Math.random() * 1e12).toString(36));
  const context = model.context;
  const wantsGpu = hasVulkan() && opts.cpuOnly !== true;

  const launch = (gpuLayers) => {
    const proc = spawn(engineExe(), serverArgs(model, modelPath(model), port, context, gpuLayers, apiKey), {
      cwd: engineDir(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + String(chunk)).slice(-4000);
    };
    if (proc.stdout) proc.stdout.on("data", keep);
    if (proc.stderr) proc.stderr.on("data", keep);
    return { proc, tail: () => tail };
  };

  let run = launch(wantsGpu ? 99 : 0);
  child = run.proc;
  log("info", "infinite local server start", { port, model: model.id, gpuLayers: wantsGpu ? 99 : 0 });
  let up = await waitHealth(port, HEALTH_WAIT_MS);
  if (!up && wantsGpu) {
    // A Vulkan loader with no usable device fails at load. Retry pure CPU with
    // the same binary before declaring the install broken.
    log("warn", "infinite local server gpu retry", { tail: firstLine(run.tail()) });
    try {
      run.proc.kill();
    } catch (error) {
    }
    run = launch(0);
    child = run.proc;
    up = await waitHealth(port, HEALTH_WAIT_MS);
  }
  if (!up) {
    const detail = firstLine(run.tail());
    try {
      run.proc.kill();
    } catch (error) {
    }
    child = null;
    return { ok: false, detail: "local server did not answer /health: " + detail };
  }
  childPort = port;
  writeServer({ pid: run.proc.pid, port, model: model.id, alias: model.alias, apiKey, startedAt: new Date().toISOString() });
  return { ok: true, port, alias: model.alias, detail: "local server listening on 127.0.0.1:" + port, reused: false };
}

async function ensureLocalServer(options) {
  const opts = options || {};
  const model = opts.model || pickModel();
  if (!engineReady() || !modelReady(model)) {
    return { ok: false, detail: "local model is not installed", installed: false };
  }
  const r = await startLocalServer({ model, log: opts.log });
  return Object.assign({ installed: true }, r);
}

// ---------------------------------------------------------------------------
// OpenCode provider registration
// ---------------------------------------------------------------------------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch (error) {
    return null;
  }
}

function writeConfig(config) {
  const file = configPath();
  mkdir(path.dirname(file));
  if (!fs.existsSync(file + ".bak")) {
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch (error) {
    }
  }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function providerEntry(port, model, apiKey) {
  const entry = {
    name: "Local (llama.cpp)",
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: "http://127.0.0.1:" + port + "/v1",
      apiKey,
      timeout: false,
    },
  };
  entry.models = {};
  entry.models[model.alias] = {
    name: model.name,
    tool_call: true,
    temperature: true,
    attachment: false,
    reasoning: false,
    limit: { context: model.context, output: model.output },
  };
  return entry;
}

// Merges a single provider key and points the default model at it. Everything
// else in the file is preserved byte-for-byte in meaning: no field is dropped,
// no other provider is touched.
function writeLocalProvider(options) {
  const opts = options || {};
  const model = opts.model || pickModel();
  const port = opts.port;
  const apiKey = opts.apiKey || "local";
  if (!port) return { ok: false, detail: "no port to register" };
  const config = readConfig() || {};
  config.providers = config.providers && typeof config.providers === "object" ? config.providers : {};
  config.providers.local = providerEntry(port, model, apiKey);
  if (opts.makeDefault !== false) config.model = "local/" + model.alias;
  const file = writeConfig(config);
  return { ok: true, detail: "provider local/" + model.alias + " written", path: file };
}

function localStatus() {
  const model = pickModel();
  const record = readServer();
  const installed = engineReady() && modelReady(model);
  return {
    engine: engineReady(),
    model: modelReady(model),
    installed,
    modelId: model.id,
    modelName: model.name,
    modelBytes: model.size,
    port: record && record.port ? record.port : 0,
    running: !!(record && record.pid && alive(record.pid) && record.port),
    detail: installed ? "local model installed (" + model.name + ")" : "local model not installed",
  };
}

// ---------------------------------------------------------------------------
// Neutral restart: unlike the WARP relaunch this one adds no proxy variables,
// because a local model on loopback must never be routed through anything.
// ---------------------------------------------------------------------------

function restartScript(appPath, cliPath) {
  if (IS_WIN) {
    const lines = [
      "@echo off",
      "setlocal",
      'set "STATE=%LOCALAPPDATA%\\opencode-infinite-desktop"',
      "if not exist \"%STATE%\" mkdir \"%STATE%\"",
      'echo [%DATE% %TIME%] restart for local provider >> "%STATE%\\relaunch.log"',
      "ping -n 3 127.0.0.1 >nul",
    ];
    if (cliPath && cliPath.length > 0) {
      lines.push('if exist "' + cliPath + '" "' + cliPath + '" service stop >nul 2>&1');
      lines.push("ping -n 2 127.0.0.1 >nul");
    }
    lines.push('start "" "' + appPath + '"');
    return lines.join("\r\n") + "\r\n";
  }
  const lines = ["#!/bin/bash", "set -u"];
  if (cliPath && cliPath.length > 0) lines.push('"' + cliPath + '" service stop >/dev/null 2>&1 || true');
  lines.push("sleep 1");
  lines.push('nohup "' + appPath + '" >/dev/null 2>&1 &');
  return lines.join("\n") + "\n";
}

function scheduleRestart(appPath, cliPath) {
  const dir = stateDir();
  mkdir(dir);
  if (IS_WIN) {
    const cmd = path.join(dir, "restart-local.cmd");
    fs.writeFileSync(cmd, restartScript(appPath, cliPath), "utf8");
    spawn("cmd.exe", ["/d", "/c", "call", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return cmd;
  }
  const sh = path.join(dir, "restart-local.sh");
  fs.writeFileSync(sh, restartScript(appPath, cliPath), "utf8");
  fs.chmodSync(sh, 0o755);
  spawn("/bin/sh", [sh], { detached: true, stdio: "ignore" }).unref();
  return sh;
}

// One call that does the whole install in order, with progress pushed as
// {phase, percent, detail} so the UI never has to poll anything.
async function setupLocal(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : function () {};
  const progress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
  const model = opts.model || pickModel();
  const signal = opts.signal;

  progress({ phase: "engine", percent: 0, detail: "downloading llama.cpp " + ENGINE_TAG });
  const engine = await installEngine({ log, signal, onProgress: (p) => progress({ phase: "engine", percent: p.percent, detail: "llama.cpp " + p.percent + "%" }) });
  if (!engine.ok) return { ok: false, phase: "engine", detail: engine.detail };

  progress({ phase: "model", percent: 0, detail: "downloading " + model.name });
  const installed = await installModel(model, {
    log,
    signal,
    onProgress: (p) => progress({ phase: "model", percent: p.percent, detail: model.name + " " + p.percent + "%" }),
  });
  if (!installed.ok) return { ok: false, phase: "model", detail: installed.detail };

  progress({ phase: "server", percent: 100, detail: "starting " + model.name });
  const server = await startLocalServer({ model, log });
  if (!server.ok) return { ok: false, phase: "server", detail: server.detail };

  progress({ phase: "config", percent: 100, detail: "registering provider" });
  const record = readServer();
  const written = writeLocalProvider({
    port: server.port,
    model,
    apiKey: record && record.apiKey ? record.apiKey : "local",
    makeDefault: opts.makeDefault !== false,
  });
  if (!written.ok) return { ok: false, phase: "config", detail: written.detail };

  progress({ phase: "ready", percent: 100, detail: "local model ready" });
  return {
    ok: true,
    phase: "ready",
    detail: "local model ready on 127.0.0.1:" + server.port,
    provider: "local",
    model: model.alias,
    port: server.port,
    configPath: written.path,
  };
}

module.exports = {
  ENGINE_TAG,
  LOCAL_MODELS,
  engineReady,
  engineExe,
  engineDir,
  llmDir,
  modelsDir,
  modelPath,
  modelReady,
  pickModel,
  localStatus,
  installEngine,
  installModel,
  startLocalServer,
  stopLocalServer,
  ensureLocalServer,
  readServer,
  writeLocalProvider,
  writeConfig,
  readConfig,
  configPath,
  setupLocal,
  scheduleRestart,
  restartScript,
  freePort,
  health,
  hasVulkan,
  download,
  headSize,
};

      return module.exports;
    })({ exports: {} }, {});
    return Object.assign({}, rotateCore, localCore);
  } catch (error) {
    // Renderer: no node built-ins. Only the pure formatters are used here.
    return {
      formatRemaining: function (ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
        if (minutes > 0) return minutes + "m " + String(seconds).padStart(2, "0") + "s";
        return seconds + "s";
      },
    };
  }
})();
﻿"use strict";
const { app } = require("electron");
const { createSignal } = require("solid-js");
const gui = require("@opencode/plugin/gui");
const { Schema } = require("effect");

const PoolState = Schema.Struct({
  state: Schema.String,
  model: Schema.String,
  refillAt: Schema.String,
  remainingMs: Schema.Number,
  detail: Schema.String,
});

const RouteState = Schema.Struct({
  phase: Schema.String,
  exit: Schema.String,
  detail: Schema.String,
});

// phase: idle | engine | model | server | config | ready | error | stopped
const LocalState = Schema.Struct({
  phase: Schema.String,
  percent: Schema.Number,
  detail: Schema.String,
  port: Schema.Number,
  model: Schema.String,
  installed: Schema.Boolean,
  running: Schema.Boolean,
});

const State = Schema.Struct({
  pool: PoolState,
  route: RouteState,
  local: LocalState,
});

// One service for both halves: provide() is a single registration per plugin.
const ipc = gui.Ipc.define({
  id: "infinite.state",
  state: State,
  methods: {
    refresh: { output: State },
    probe: { output: PoolState },
    rotate: {
      output: Schema.Struct({ ok: Schema.Boolean, detail: Schema.String, exit: Schema.String }),
    },
    localSetup: {
      output: Schema.Struct({ ok: Schema.Boolean, detail: Schema.String, phase: Schema.String }),
    },
    localStart: {
      output: Schema.Struct({ ok: Schema.Boolean, detail: Schema.String }),
    },
    localStop: {
      output: Schema.Struct({ ok: Schema.Boolean, detail: Schema.String }),
    },
    localCancel: {
      output: Schema.Struct({ ok: Schema.Boolean, detail: Schema.String }),
    },
  },
});

const emptyPool = { state: "unknown", model: "", refillAt: "", remainingMs: 0, detail: "free pool not checked yet" };
const initialRoute = { phase: "unknown", exit: "", detail: "checking route" };
const initialLocal = {
  phase: "idle",
  percent: 0,
  detail: "local model not installed",
  port: 0,
  model: "",
  installed: false,
  running: false,
};

function localBusy(local) {
  return !!local && (local.phase === "engine" || local.phase === "model" || local.phase === "server" || local.phase === "config");
}

function pillLabel(pool, local) {
  if (local && localBusy(local)) {
    return "Local " + Math.round(local.percent || 0) + "%";
  }
  if (!pool || pool.state === "unknown") return "Reset limit";
  return "Reset limit";
}

function pillTitle(pool, local) {
  if (local && localBusy(local)) return local.detail;
  if (local && local.phase === "ready") {
    return "Local model ready on 127.0.0.1:" + local.port + ". This one answers on any machine, no quota.";
  }
  if (!pool || pool.state === "unknown") return "Check the free-tier pool";
  if (pool.state === "open") return "Free pool answers now. " + (pool.model || "free model");
  if (pool.state === "ready") return "Refill time has passed. Send a message to confirm.";
  const at = pool.refillAt ? new Date(pool.refillAt).toLocaleString() : "";
  return "Click: register a fresh WARP exit now. Free pool refills " + at + ".";
}

function refillLine(pool) {
  if (!pool || !pool.refillAt) return "";
  const at = new Date(pool.refillAt);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return "Next refill: " + at.toLocaleDateString() + " " + clock;
}

const plugin = gui.Plugin.define({
  i18n: {
    en: {
      "pool.title": "Reset limit",
      "pool.open": "The free pool is answering right now. Nothing was reset and nothing needs to be.",
      "pool.empty": "Free pool is dry. A fresh WARP exit is one click away; the quota refills at the instant below.",
      "pool.fact":
        "Measured: six freshly registered WARP devices on six different exits all reported the same remaining time, counting down with the wall clock. The quota is held server-side against the shared free credential. Rotating still changes the egress address and restarts the app on it.",
      "pool.failed": "Free pool probe failed",
      "egress.title": "New WARP egress",
      "egress.action": "Rotate and restart",
      "egress.failed": "Rotation failed",
      "local.title": "Local model",
      "local.setupTitle": "Install the local model",
      "local.setupBody":
        "Downloads the llama.cpp server (~26 MB, more if the machine has Vulkan) and one GGUF model, then registers it as an OpenCode provider and makes it the default model.\n\nThis runs on the machine itself. No account, no quota, no egress rotation.",
      "local.setupAction": "Download and install",
      "local.readyTitle": "Local model ready",
      "local.restartBody": "Restart now so the provider loads? The app relaunches on its own.",
      "local.failTitle": "Local model setup failed",
      "local.cancelTitle": "Local model",
      "local.cancelBody": "Cancel the download? The partial file is kept and the download resumes from where it stopped.",
      "local.stopTitle": "Stop the local server",
      "local.stopped": "Local server stopped",
      "local.stateTitle": "Local model status",
    },
  },
  setup(ctx) {
    const client = ctx.main(ipc);
    const [busy, setBusy] = createSignal(false);
    const [phase, setPhase] = createSignal("idle");

    const check = async () => {
      if (busy()) return;
      setBusy(true);
      setPhase("checking");
      try {
        const pool = await client.probe();
        if (pool.state === "open") {
          await ctx.dialogs.alert({ title: ctx.t("pool.title"), description: ctx.t("pool.open") });
          return;
        }
        if (pool.state === "empty") {
          await ctx.dialogs.alert({
            title: ctx.t("pool.title"),
            description: ctx.t("pool.empty") + "\n\n" + refillLine(pool) + "\n\n" + ctx.t("pool.fact"),
          });
          return;
        }
        await ctx.dialogs.alert({ title: ctx.t("pool.failed"), description: pool.detail });
      } catch (error) {
        await ctx.dialogs.alert({ title: ctx.t("pool.failed"), description: String(error) });
      } finally {
        setBusy(false);
        setPhase("idle");
      }
    };

    // One click rotates the exit. No pool gate, no confirm: the registration
    // cycle is the action, and the app relaunches itself on the new address.
    const rotate = async () => {
      if (busy()) return;
      setBusy(true);
      setPhase("rotating");
      try {
        const result = await client.rotate();
        if (!result.ok) {
          await ctx.dialogs.alert({ title: ctx.t("egress.failed"), description: result.detail });
        }
      } catch (error) {
        await ctx.dialogs.alert({ title: ctx.t("egress.failed"), description: String(error) });
      } finally {
        setBusy(false);
        setPhase("idle");
      }
    };

    // The whole local install is one main-side call; progress arrives through
    // the shared state so the pill can show a real percentage.
    const setupLocal = async () => {
      if (busy()) return;
      const state = client.state()?.local;
      if (state && state.installed && state.running) {
        const stop = await ctx.dialogs.confirm({
          title: ctx.t("local.stopTitle"),
          description: "A local model is already installed on 127.0.0.1:" + state.port + ".",
          confirm: ctx.t("local.stopped"),
        });
        if (!stop) return;
        setBusy(true);
        try {
          await client.localStop();
        } finally {
          setBusy(false);
        }
        return;
      }
      const go = await ctx.dialogs.confirm({
        title: ctx.t("local.setupTitle"),
        description: ctx.t("local.setupBody"),
        confirm: ctx.t("local.setupAction"),
      });
      if (!go) return;
      setBusy(true);
      try {
        const result = await client.localSetup();
        if (!result.ok) {
          await ctx.dialogs.alert({ title: ctx.t("local.failTitle"), description: result.detail });
          return;
        }
        const restart = await ctx.dialogs.confirm({
          title: ctx.t("local.readyTitle"),
          description: result.detail + "\n\n" + ctx.t("local.restartBody"),
          confirm: "Restart now",
        });
        if (restart) await client.localStart().catch(() => {});
      } catch (error) {
        await ctx.dialogs.alert({ title: ctx.t("local.failTitle"), description: String(error) });
      } finally {
        setBusy(false);
      }
    };

    const localStatus = async () => {
      const state = client.state()?.local;
      if (!state) return;
      const lines = [
        "Phase: " + state.phase,
        state.installed ? "Installed: yes" : "Installed: no",
        state.running ? "Server: 127.0.0.1:" + state.port : "Server: stopped",
        state.model ? "Model: " + state.model : "",
        state.detail,
      ].filter((line) => line.length > 0);
      await ctx.dialogs.alert({ title: ctx.t("local.stateTitle"), description: lines.join("\n") });
    };

    const tick = setInterval(() => {
      client.refresh().catch(() => {});
    }, 20000);



    ctx.add(gui.Command, () => ({
      id: "free-limit",
      title: "Free pool status - when the free tier refills",
      run: () => {
        check();
      },
    }));

    ctx.add(gui.Command, () => ({
      id: "rotate",
      title: "Reset limit - rotate the WARP exit now",
      run: () => {
        rotate();
      },
    }));

    ctx.add(gui.Command, () => ({
      id: "local-model",
      title: ctx.t("local.title") + " - install or repair the offline model",
      run: () => {
        setupLocal();
      },
    }));

    ctx.add(gui.Command, () => ({
      id: "local-status",
      title: ctx.t("local.stateTitle"),
      run: () => {
        localStatus();
      },
    }));

    ctx.add(gui.ComposerPill, () => ({
      id: "infinite",
      order: 0,
      show: () => ({
        label: busy() ? (phase() === "rotating" ? "Rotating..." : "Checking...") : pillLabel(client.state()?.pool, client.state()?.local),
        title: busy() ? "Rotating the WARP exit" : pillTitle(client.state()?.pool, client.state()?.local),
        icon: "globe",
        tone:
          localBusy(client.state()?.local) || client.state()?.local?.phase === "ready"
            ? "success"
            : client.state()?.pool?.state === "open" || client.state()?.pool?.state === "ready"
              ? "success"
              : "warning",
        run: () => {
          rotate();
        },
      }),
    }));

    client.refresh().catch(() => {});
  },
  main(ctx) {
    ctx.log.write("info", "infinite gui ready", { version: ctx.app.version });

    let pool = emptyPool;
    let route = initialRoute;
    let local = initialLocal;
    let changed = () => {};
    let abort = null;

    const log = (level, message, extra) => ctx.log.write(level, message, extra || {});

    const cliPath = () => {
      try {
        return ctx.cli?.binary ?? ctx.cli?.command?.[0] ?? "";
      } catch (error) {
        return "";
      }
    };

    const refreshLocal = () => {
      const status = core.localStatus();
      local = {
        phase: local.phase === "ready" || local.phase === "error" ? local.phase : status.running ? "ready" : status.installed ? "idle" : "idle",
        percent: local.percent || 0,
        detail: status.detail,
        port: status.running ? status.port : local.port || 0,
        model: status.modelId,
        installed: status.installed,
        running: status.running,
      };
      if (status.running && status.port) local.port = status.port;
      if (!status.installed) local.phase = "idle";
      changed();
      return local;
    };

    const service = ctx.provide(ipc, {
      state: () => ({ pool, route, local }),
      refresh: async () => {
        pool = core.poolSnapshot();
        refreshLocal();
        return { pool, route, local };
      },
      probe: async () => {
        pool = { state: "unknown", model: "", refillAt: "", remainingMs: 0, detail: "probing the free pool" };
        changed();
        pool = await core.probePool({ log });
        changed();
        return pool;
      },
      rotate: async () => {
        route = { phase: "rotating", exit: route.exit, detail: "rotating WARP registration" };
        changed();
        const result = await core.rotateEgress({ log });
        if (result.ok) {
          route = { phase: "rotating", exit: result.exit, detail: "restarting on " + result.exit };
          changed();
          ctx.log.write("info", "infinite rotated", { exit: result.exit, detail: result.detail });
          setTimeout(() => {
            core.scheduleRelaunch(process.execPath, cliPath());
            app.quit();
          }, 500);
          return result;
        }
        route = await core.readRoute();
        changed();
        return result;
      },
      localSetup: async () => {
        if (abort) return { ok: false, detail: "a local setup is already running", phase: local.phase };
        abort = new AbortController();
        local = { phase: "engine", percent: 0, detail: "starting", port: local.port || 0, model: local.model || "", installed: local.installed, running: false };
        changed();
        try {
          const result = await core.setupLocal({
            log,
            signal: abort.signal,
            makeDefault: true,
            onProgress: (p) => {
              local = {
                phase: p.phase,
                percent: p.percent || 0,
                detail: p.detail,
                port: local.port || 0,
                model: local.model || "",
                installed: !!local.installed,
                running: false,
              };
              changed();
            },
          });
          abort = null;
          if (result.ok) {
            local = { phase: "ready", percent: 100, detail: result.detail, port: result.port, model: result.model, installed: true, running: true };
            changed();
            // The provider list is built at CLI start, so the relaunch is the
            // step that actually makes local/<model> selectable.
            setTimeout(() => {
              core.scheduleRestart(process.execPath, cliPath());
              app.quit();
            }, 1200);
            return { ok: true, detail: result.detail, phase: "ready" };
          }
          local = { phase: "error", percent: 0, detail: result.detail, port: local.port || 0, model: local.model || "", installed: !!local.installed, running: false };
          changed();
          return { ok: false, detail: result.detail, phase: result.phase || "error" };
        } catch (error) {
          abort = null;
          const detail = String((error && error.message) || error);
          local = { phase: "error", percent: 0, detail, port: local.port || 0, model: local.model || "", installed: !!local.installed, running: false };
          changed();
          return { ok: false, detail, phase: "error" };
        }
      },
      localStart: async () => {
        const result = await core.ensureLocalServer({ log });
        if (result.ok) {
          local = { phase: "ready", percent: 100, detail: result.detail, port: result.port, model: local.model || "", installed: true, running: true };
          changed();
          // Restart so the provider catalog is rebuilt with the local entry.
          route = { phase: route.phase, exit: route.exit, detail: "restarting for local provider" };
          setTimeout(() => {
            core.scheduleRestart(process.execPath, cliPath());
            app.quit();
          }, 500);
          return { ok: true, detail: result.detail };
        }
        return { ok: false, detail: result.detail };
      },
      localStop: async () => {
        if (abort) {
          abort.abort();
          abort = null;
        }
        const result = await core.stopLocalServer();
        local = { phase: "idle", percent: 0, detail: "local server stopped", port: 0, model: local.model || "", installed: local.installed, running: false };
        changed();
        return { ok: true, detail: result.detail };
      },
      localCancel: async () => {
        if (abort) abort.abort();
        abort = null;
        return { ok: true, detail: "cancelled" };
      },
    });

    changed = () => service.changed();

    pool = core.poolSnapshot();
    refreshLocal();

    // A machine that already has the model gets the server back up on launch,
    // silently, so the provider answers without the user touching anything.
    setTimeout(() => {
      try {
        if (core.localStatus().installed) {
          core
            .ensureLocalServer({ log })
            .then((r) => {
              if (r.ok) {
                local = { phase: "ready", percent: 100, detail: r.detail, port: r.port, model: local.model || "", installed: true, running: true };
                changed();
              }
            })
            .catch(() => {});
        }
      } catch (error) {
      }
    }, 2500);

    core.readRoute().then((next) => {
      route = next;
      if (route.phase === "warp" && route.exit) core.writeRoute(route.exit);
      changed();
    }).catch((error) => {
      route = { phase: "unknown", exit: "", detail: String(error) };
      changed();
    });
  },
});

exports.default = plugin;
exports.__core = core;

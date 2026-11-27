// TUI part of the infinite plugin: /resetlimit for the terminal client.
//
// The desktop exposes the rotation as a composer pill. The terminal has no
// pill, so the same work is registered as a local keymap command with a slash
// name. It runs inside the CLI process and only rotates the WARP egress: no
// prompt is submitted and no completion is spent.

const WARP_CLI = "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe";
const CURL = "C:\\Windows\\System32\\curl.exe";
const PROXY_URL = "http://127.0.0.1:40000";
const PROXY_PORT = "40000";
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const MAX_CYCLES = 3;
const CONNECT_WAIT_MS = 45000;
const TRACE_WAIT_MS = 20000;

const PROXY_ENV = {
  HTTP_PROXY: PROXY_URL,
  HTTPS_PROXY: PROXY_URL,
  ALL_PROXY: PROXY_URL,
  http_proxy: PROXY_URL,
  https_proxy: PROXY_URL,
  all_proxy: PROXY_URL,
  NO_PROXY: "localhost,127.0.0.1,0.0.0.0,::1,[::1]",
  no_proxy: "localhost,127.0.0.1,0.0.0.0,::1,[::1]",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstLine(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? line.slice(0, 200) : "no output";
}

function message(error) {
  return String((error && (error.message || error)) || "unknown error").slice(0, 200);
}

// execFile from the CLI's own node runtime. Nothing is imported at module
// scope so a host without these built-ins never fails the whole TUI.
async function exec(file, args, timeoutMs) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      if (!error) return resolve({ code: 0, out });
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: out || String(error.message || "") });
    });
  });
}

function warp(args) {
  return exec(WARP_CLI, ["--accept-tos", ...args], 90000);
}

function isConnected(text) {
  return /Status update:\s*Connected/i.test(text || "");
}

function isProxyMode(text) {
  return /Mode:\s*(WarpProxy|Proxy)\b/i.test(text || "");
}

function parseTrace(text) {
  const ip = /^ip=(.+)$/m.exec(text || "");
  return { ip: ip ? ip[1].trim() : "", warp: /^warp=on$/m.test(text || "") };
}

// The trace goes through the local WARP proxy, which is exactly the path the
// CLI server takes once its environment points at the proxy.
async function trace() {
  const result = await exec(CURL, ["-s", "--max-time", "12", "--proxy", PROXY_URL, TRACE_URL], 20000);
  if (result.code !== 0) return { ip: "", warp: false, error: firstLine(result.out) || "curl exit " + result.code };
  const parsed = parseTrace(result.out);
  return parsed.ip ? { ip: parsed.ip, warp: parsed.warp, error: "" } : { ip: "", warp: false, error: "trace returned no address" };
}

async function waitConnected(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const status = await warp(["status"]);
    if (isConnected(status.out)) return true;
    await sleep(750);
  }
  return false;
}

async function waitTrace(ms) {
  const end = Date.now() + ms;
  let last = { ip: "", warp: false, error: "no answer" };
  while (Date.now() < end) {
    last = await trace();
    if (last.ip) return last;
    await sleep(750);
  }
  return last;
}

// Proxy mode on the fixed port, connected. An older build may have left WARP
// in full-tunnel mode, which would put the whole machine on the WARP exit
// instead of only the processes pointed at the local proxy.
async function ensureProxy() {
  const { existsSync } = await import("node:fs");
  if (!existsSync(WARP_CLI)) {
    return { ok: false, detail: "Cloudflare WARP is not installed; run the OpenCode setup again" };
  }
  const settings = await warp(["settings"]);
  if (!isProxyMode(settings.out)) {
    const set = await warp(["mode", "proxy"]);
    if (set.code !== 0) return { ok: false, detail: "could not switch WARP to proxy mode: " + firstLine(set.out) };
    await sleep(1200);
  }
  const port = await warp(["proxy", "port", PROXY_PORT]);
  if (port.code !== 0) return { ok: false, detail: "could not set the WARP proxy port: " + firstLine(port.out) };
  const status = await warp(["status"]);
  if (!isConnected(status.out)) {
    await warp(["connect"]);
    if (!(await waitConnected(20000))) return { ok: false, detail: "WARP did not reach Connected" };
  }
  return { ok: true, detail: "WARP proxy on 127.0.0.1:" + PROXY_PORT };
}

// One full registration cycle: keep proxy mode, drop the device, register a
// new one, reconnect, and read the proxied exit.
async function cycle() {
  const mode = await warp(["mode", "proxy"]);
  if (mode.code !== 0) return { ok: false, detail: "could not set proxy mode: " + firstLine(mode.out) };
  await warp(["proxy", "port", PROXY_PORT]);
  await warp(["disconnect"]);
  await warp(["registration", "delete"]);
  const fresh = await warp(["registration", "new"]);
  if (fresh.code !== 0) return { ok: false, detail: "could not register a new device: " + firstLine(fresh.out) };
  const connect = await warp(["connect"]);
  if (connect.code !== 0) await warp(["connect"]);
  if (!(await waitConnected(CONNECT_WAIT_MS))) {
    await warp(["connect"]);
    if (!(await waitConnected(20000))) return { ok: false, detail: "WARP did not reach Connected" };
  }
  const result = await waitTrace(TRACE_WAIT_MS);
  if (!result.ip) return { ok: false, detail: "trace did not answer after reconnect: " + firstLine(result.error) };
  return { ok: true, exit: result.ip, warp: result.warp };
}

async function writeRoute(ip) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
  const dir = path.join(base, "opencode-infinite-desktop");
  const record = {
    mode: "proxy",
    proxy: PROXY_URL,
    port: Number(PROXY_PORT),
    ip,
    warp: true,
    updated: new Date().toISOString(),
    app: "cli",
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "route.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch (error) {
  }
  return record;
}

// The CLI client does not make the model calls; the background server does.
// Writing the proxy into the service config gives every future server spawn
// the same route without touching the user's shell or the rest of the machine.
async function ensureServiceEnv() {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
  const file = path.join(configDir, "service.json");
  let current = {};
  try {
    current = JSON.parse(await readFile(file, "utf8")) || {};
  } catch (error) {
    current = {};
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  const env = Object.assign({}, current.env || {});
  let changed = false;
  for (const key of Object.keys(PROXY_ENV)) {
    if (env[key] !== PROXY_ENV[key]) {
      env[key] = PROXY_ENV[key];
      changed = true;
    }
  }
  if (!changed) return false;
  current.env = env;
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(file, JSON.stringify(current, null, 2) + "\n", "utf8");
  } catch (error) {
    return false;
  }
  return true;
}

// Up to three registrations, stopping as soon as the proxied exit differs from
// the one the client started on.
async function rotate() {
  const up = await ensureProxy();
  if (!up.ok) return { ok: false, exit: "", detail: up.detail };
  const before = await trace();
  if (!before.ip) {
    return { ok: false, exit: "", detail: "the WARP proxy is up but the trace did not answer: " + firstLine(before.error) };
  }
  let detail = "rotation did not run";
  for (let attempt = 1; attempt <= MAX_CYCLES; attempt++) {
    const result = await cycle();
    if (result.ok && result.exit !== before.ip) {
      await writeRoute(result.exit);
      await ensureServiceEnv().catch(() => false);
      return { ok: true, exit: result.exit, detail: "new exit " + result.exit };
    }
    detail = result.ok ? "exit unchanged at " + result.exit + "; the edge reused the address" : result.detail;
    await sleep(1500);
  }
  await warp(["connect"]);
  await waitConnected(15000);
  return { ok: false, exit: "", detail };
}

export default {
  id: "infinite.cli",
  setup(context) {
    const toast = (text, variant) => {
      try {
        context.ui.toast.show({ message: text, variant });
      } catch (error) {
        try {
          console.log("[infinite] " + text);
        } catch (ignored) {
        }
      }
    };
    if (!context || !context.keymap || typeof context.keymap.layer !== "function") return;
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "infinite.resetlimit",
          title: "Reset free limit",
          description: "Rotate the WARP exit and record the new address",
          group: "Infinite",
          palette: true,
          slash: { name: "resetlimit" },
          suggested: true,
          run: async () => {
            toast("resetlimit: rotating the WARP exit", "info");
            let result;
            try {
              result = await rotate();
            } catch (error) {
              result = { ok: false, exit: "", detail: message(error) };
            }
            if (result.ok) toast("resetlimit: new exit " + result.exit + " (warp on)", "success");
            else toast("resetlimit: " + result.detail, "error");
          },
        },
      ],
    }));
  },
};

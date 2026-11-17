import { execFile } from "node:child_process"

// Presses Win+H, Windows' own voice typing, which types into the focused field. A recognizer started from a helper
// process got silence under Remote Desktop while Win+H heard fine, so the app drives the one that works.
const script = `
Add-Type -Namespace OC -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
[OC.Keys]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[OC.Keys]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)
[OC.Keys]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)
[OC.Keys]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
`

export function voiceTyping() {
  if (process.platform !== "win32") return Promise.resolve({ ok: false, message: "Dictation needs Windows." })
  return new Promise<{ ok: boolean; message: string }>((resolve) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 20_000, windowsHide: true },
      (error, _stdout, stderr) =>
        resolve(error ? { ok: false, message: String(stderr).trim().split(/\r?\n/)[0] || "Could not open Windows voice typing." } : { ok: true, message: "" }),
    ),
  )
}

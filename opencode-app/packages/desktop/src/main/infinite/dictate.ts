import { execFile, type ChildProcess, type ExecFileException } from "node:child_process"

// Windows' own speech engine, the one under Win+H: it listens once and stops by itself when the speaker goes quiet.
// Run through PowerShell 5.1 because it can await WinRT calls without a native module.
const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation\`\`1"
} | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait() | Out-Null; $t.Result }
$rec = if ($env:OC_DICTATE_LANG) { New-Object Windows.Media.SpeechRecognition.SpeechRecognizer (New-Object Windows.Globalization.Language $env:OC_DICTATE_LANG) } else { New-Object Windows.Media.SpeechRecognition.SpeechRecognizer }
$rec.Timeouts.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
$rec.Timeouts.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
$null = Await ($rec.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
$result = Await ($rec.RecognizeAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionResult])
[Console]::Out.Write($result.Text)
`
const listScript = `
$null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime]
([Windows.Media.SpeechRecognition.SpeechRecognizer]::SupportedTopicLanguages | ForEach-Object { $_.LanguageTag }) -join ","
`

export type DictateResult = { ok: boolean; text: string; message: string }

// One recording at a time; a second click stops it.
let current: ChildProcess | undefined

const powershell = (body: string, env: NodeJS.ProcessEnv, timeout: number, track: boolean) =>
  new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(body, "utf16le").toString("base64")],
      { timeout, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (track && current === child) current = undefined
        resolve({ error, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    if (track) current = child
  })

export async function dictate(language: string): Promise<DictateResult> {
  if (process.platform !== "win32") return { ok: false, text: "", message: "Dictation needs Windows." }
  if (current) return { ok: false, text: "", message: "Already listening." }
  const run = await powershell(script, { OC_DICTATE_LANG: language }, 90_000, true)
  if (!run.error) {
    const text = run.stdout.trim()
    return text ? { ok: true, text, message: "" } : { ok: false, text: "", message: "Nothing was heard." }
  }
  if (run.error.killed || run.error.signal) return { ok: false, text: "", message: "" }
  if (/privacy policy/i.test(run.stderr))
    return {
      ok: false,
      text: "",
      message: "Turn on Online speech recognition in Windows Settings > Privacy & security > Speech, then try again.",
    }
  if (/0x80045509|language/i.test(run.stderr))
    return { ok: false, text: "", message: "Windows has no speech recognition for this language. Pick another one in Settings." }
  return { ok: false, text: "", message: run.stderr.trim().split(/\r?\n/)[0] || "Dictation failed." }
}

export function stopDictation() {
  current?.kill()
  current = undefined
}

export async function dictationLanguages() {
  if (process.platform !== "win32") return []
  const run = await powershell(listScript, {}, 20_000, false)
  return run.stdout.trim().split(",").filter(Boolean)
}

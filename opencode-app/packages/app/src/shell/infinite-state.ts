import { createSignal } from "solid-js"

// Whether Auto-rotate is on. While it is, a free-usage limit is handled by rotating the IP and resuming the session,
// so the limit dialog and the "put the prompt back in the composer" recall step aside.
export const [autoRotate, setAutoRotate] = createSignal(true)

// Advanced mode shows every connection choice and the Advanced settings tab. Off by default: only Auto and None show.
// shortcut: kept in this app's local storage only, which is enough for a per-computer preference.
const advancedKey = "opencode.infinite.advanced"
const readAdvanced = () => {
  try {
    return localStorage.getItem(advancedKey) === "1"
  } catch {
    return false
  }
}
const [advancedMode, setAdvancedSignal] = createSignal(readAdvanced())
export { advancedMode }
export function setAdvancedMode(next: boolean) {
  setAdvancedSignal(next)
  try {
    localStorage.setItem(advancedKey, next ? "1" : "0")
  } catch {
    // Storage can be blocked; the choice then lasts until the app restarts.
  }
}

// Verbose status: when on, the bottom bar shows the full rotation detail (IP, reset seconds, "continue" sent…). Off by
// default, the bar shows only the mode and a one-word state (Working, Changing IP, Not connected).
// shortcut: kept in this app's local storage only, like Advanced mode.
const verboseKey = "opencode.infinite.verbose"
const readVerbose = () => {
  try {
    return localStorage.getItem(verboseKey) === "1"
  } catch {
    return false
  }
}
const [verboseStatus, setVerboseSignal] = createSignal(readVerbose())
export { verboseStatus }
export function setVerboseStatus(next: boolean) {
  setVerboseSignal(next)
  try {
    localStorage.setItem(verboseKey, next ? "1" : "0")
  } catch {
    // Storage can be blocked; the choice then lasts until the app restarts.
  }
}

// Voice dictation: a microphone button in the composer that opens Win+H and sends what it typed.
// shortcut: kept in this app's local storage only, like Advanced mode.
const dictationKey = "opencode.infinite.dictation"
const readDictation = () => {
  try {
    return JSON.parse(localStorage.getItem(dictationKey) ?? "null") as { on: boolean } | null
  } catch {
    return null
  }
}
const [dictation, setDictationSignal] = createSignal({ on: readDictation()?.on === true })
export { dictation }
export function setDictation(next: { on: boolean }) {
  setDictationSignal(next)
  try {
    localStorage.setItem(dictationKey, JSON.stringify(next))
  } catch {
    // Storage can be blocked; the choice then lasts until the app restarts.
  }
}

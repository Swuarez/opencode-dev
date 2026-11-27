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

// Reset limit asks first: it changes the IP, restarts the service and replaces the signed-in session.
const confirmResetKey = "opencode.infinite.confirm-reset"
const readConfirmReset = () => {
  try {
    return localStorage.getItem(confirmResetKey) !== "0"
  } catch {
    return true
  }
}
const [confirmReset, setConfirmResetSignal] = createSignal(readConfirmReset())
export { confirmReset }
export function setConfirmReset(next: boolean) {
  setConfirmResetSignal(next)
  try {
    localStorage.setItem(confirmResetKey, next ? "1" : "0")
  } catch {
    // Storage can be blocked; the choice then lasts until the app restarts.
  }
}

// When the free allowance comes back, from the last free-limit error. Only the time the provider gave is shown;
// the API does not expose how many messages are left.
const freeLimitKey = "opencode.infinite.free-limit"
const MAX_FREE_LIMIT_WAIT = 45 * 86_400_000
const readFreeLimit = () => {
  try {
    const at = Number(localStorage.getItem(freeLimitKey))
    return Number.isFinite(at) && at > Date.now() ? at : undefined
  } catch {
    return undefined
  }
}
const [freeLimitReset, setFreeLimitResetSignal] = createSignal<number | undefined>(readFreeLimit())
export { freeLimitReset }
export function rememberFreeLimit(created: number, retryAfterMs: number | undefined) {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > MAX_FREE_LIMIT_WAIT)
    return
  const at = created + retryAfterMs
  if (!Number.isFinite(at) || at <= Date.now()) return
  setFreeLimitResetSignal(at)
  try {
    localStorage.setItem(freeLimitKey, String(at))
  } catch {
    // Storage can be blocked; the time then lasts until the app restarts.
  }
}

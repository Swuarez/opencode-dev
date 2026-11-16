// Last connection changes, kept on this computer only. Storage can be blocked, so every access is guarded.
export type HistoryEntry = { at: number; mode: string; ok: boolean; ip?: string }

const key = "infinite-mode-history"
const max = 10

export function readHistory(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function addHistory(entry: Omit<HistoryEntry, "at">) {
  try {
    const next = [{ ...entry, at: Date.now() }, ...readHistory()].slice(0, max)
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Not saved; the connection itself still worked.
  }
}

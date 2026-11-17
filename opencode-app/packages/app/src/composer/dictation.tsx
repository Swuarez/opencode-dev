import { createSignal, onCleanup, Show } from "solid-js"
import { IconButton } from "@opencode/ui/icon-button"
import { showToast } from "@opencode/ui/toast"
import { Tooltip } from "@opencode/ui/tooltip"
import { usePlatform } from "@/runtime/platform/platform"
import { dictation } from "@/shell/infinite-state"
import type { ComposerEditorModel } from "./editor/interaction"

// After Win+H stops typing for this long, the message is sent.
const QUIET_MS = 1800
// Gives up when Win+H never types anything, so a stray later edit is not sent.
const START_MS = 15_000

// Microphone next to Send: opens Windows voice typing (Win+H) in the composer and sends what it typed once it goes
// quiet. Typing a key yourself, or clicking again, cancels the automatic send.
export function DictationButton(props: { controller: ComposerEditorModel; disabled?: boolean }) {
  const infinite = usePlatform().infinite
  const [armed, setArmed] = createSignal(false)
  let stop = () => {}
  let button: HTMLButtonElement | undefined

  const disarm = () => {
    stop()
    stop = () => {}
    setArmed(false)
  }
  onCleanup(disarm)

  const arm = (editor: HTMLElement) => {
    let typed = false
    let composing = false
    let timer = setTimeout(disarm, START_MS)
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (composing) return schedule()
        disarm()
        if (props.controller.canSubmit()) props.controller.submit()
      }, QUIET_MS)
    }
    const onInput = () => {
      typed = true
      schedule()
    }
    const onComposition = (event: CompositionEvent) => {
      composing = event.type !== "compositionend"
      if (typed || event.type === "compositionend") onInput()
    }
    // Voice typing arrives as input and composition events; a real key press means the user took over.
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return
      disarm()
    }
    editor.addEventListener("input", onInput)
    editor.addEventListener("compositionstart", onComposition)
    editor.addEventListener("compositionupdate", onComposition)
    editor.addEventListener("compositionend", onComposition)
    editor.addEventListener("keydown", onKey)
    stop = () => {
      clearTimeout(timer)
      editor.removeEventListener("input", onInput)
      editor.removeEventListener("compositionstart", onComposition)
      editor.removeEventListener("compositionupdate", onComposition)
      editor.removeEventListener("compositionend", onComposition)
      editor.removeEventListener("keydown", onKey)
    }
    setArmed(true)
  }

  const toggle = async () => {
    if (!infinite) return
    if (armed()) return disarm()
    const editor = button?.closest("form")?.querySelector<HTMLElement>('[contenteditable="true"]')
    if (!editor) return
    props.controller.restoreFocus()
    editor.focus()
    arm(editor)
    const result = await infinite.dictate()
    if (result.ok) return
    disarm()
    showToast(result.message)
  }

  return (
    <Show when={infinite?.dictate && dictation().on}>
      <Tooltip placement="top" value={armed() ? "Sends when you stop talking. Click to cancel" : "Dictate and send (Win+H)"}>
        <IconButton
          ref={button}
          data-action="composer-dictate"
          type="button"
          variant="ghost"
          class="me-1 size-7 rounded-md p-[6px]"
          classList={{ "text-v2-text-text-danger animate-pulse": armed() }}
          disabled={props.disabled && !armed()}
          aria-pressed={armed()}
          aria-label={armed() ? "Cancel automatic send" : "Dictate and send"}
          icon={
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          }
          // Keeps the caret in the composer, so Win+H types there.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault()
            void toggle()
          }}
        />
      </Tooltip>
    </Show>
  )
}

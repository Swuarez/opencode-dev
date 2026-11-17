import { createSignal, Show } from "solid-js"
import { IconButton } from "@opencode/ui/icon-button"
import { showToast } from "@opencode/ui/toast"
import { Tooltip } from "@opencode/ui/tooltip"
import { usePlatform } from "@/runtime/platform/platform"
import { dictation } from "@/shell/infinite-state"
import type { ComposerEditorModel } from "./editor/interaction"

// Microphone next to Send: Windows listens until you stop talking, the words go into the composer and are sent.
// A second click while listening stops it without sending.
export function DictationButton(props: { controller: ComposerEditorModel; disabled?: boolean }) {
  const infinite = usePlatform().infinite
  const [listening, setListening] = createSignal(false)

  const toggle = async () => {
    if (!infinite) return
    if (listening()) return void infinite.dictateStop()
    setListening(true)
    const result = await infinite.dictate(dictation().language).finally(() => setListening(false))
    if (!result.ok) {
      if (result.message) showToast(result.message)
      return
    }
    props.controller.restoreFocus()
    const current = props.controller.value()
    // Typed through the editor so it parses the text the same way as a keystroke.
    document.execCommand("insertText", false, (current && !/\s$/.test(current) ? " " : "") + result.text)
    requestAnimationFrame(() => {
      if (props.controller.canSubmit()) props.controller.submit()
    })
  }

  return (
    <Show when={infinite?.dictate && dictation().on}>
      <Tooltip placement="top" value={listening() ? "Listening… click to stop" : "Dictate and send"}>
        <IconButton
          data-action="composer-dictate"
          type="button"
          variant="ghost"
          class="me-1 size-7 rounded-md p-[6px]"
          classList={{ "text-v2-text-text-danger animate-pulse": listening() }}
          disabled={props.disabled && !listening()}
          aria-pressed={listening()}
          aria-label={listening() ? "Stop listening" : "Dictate and send"}
          icon={
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          }
          onClick={(event) => {
            event.preventDefault()
            void toggle()
          }}
        />
      </Tooltip>
    </Show>
  )
}

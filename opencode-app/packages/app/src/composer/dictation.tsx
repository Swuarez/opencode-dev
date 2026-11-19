import { Show } from "solid-js"
import { IconButton } from "@opencode/ui/icon-button"
import { showToast } from "@opencode/ui/toast"
import { Tooltip } from "@opencode/ui/tooltip"
import { usePlatform } from "@/runtime/platform/platform"
import { dictation } from "@/shell/infinite-state"
import type { ComposerEditorModel } from "./editor/interaction"

// Microphone next to Send: puts the caret in the composer and opens Windows voice typing (Win+H), which types what you
// say into the box. Windows gives no signal for "done talking" and its panel cannot be closed from here, so the message
// is not sent automatically: you press Enter yourself when the text looks right.
export function DictationButton(props: { controller: ComposerEditorModel; disabled?: boolean }) {
  const infinite = usePlatform().infinite
  let button: HTMLButtonElement | undefined

  const open = async () => {
    if (!infinite) return
    const editor = button?.closest("form")?.querySelector<HTMLElement>('[contenteditable="true"]')
    // Win+H types into the focused field, so the caret has to be in the composer before it opens.
    props.controller.restoreFocus()
    editor?.focus()
    const result = await infinite.dictate()
    if (!result.ok) showToast(result.message)
  }

  return (
    <Show when={infinite?.dictate && dictation().on}>
      <Tooltip placement="top" value="Dictate with Win+H, then press Enter to send">
        <IconButton
          ref={button}
          data-action="composer-dictate"
          type="button"
          variant="ghost"
          class="me-1 size-7 rounded-md p-[6px]"
          disabled={props.disabled}
          aria-label="Dictate with Windows voice typing"
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
            void open()
          }}
        />
      </Tooltip>
    </Show>
  )
}

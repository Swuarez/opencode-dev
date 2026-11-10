// Custom background image and the moving "rainbow" accent of OpenCode Infinite. Everything lives in the renderer:
// the image is stored (downscaled) in localStorage, and the surfaces are made translucent by overriding their color
// variables inline, so the image shows through and the theme keeps working.
const KEY_IMAGE = "infinite-bg"
const KEY_OPACITY = "infinite-bg-opacity"
const MAX_SIDE = 1920
// The layers that paint the window; the rest of the interface sits on top of them.
const SURFACES = ["base", "deep", "layer-01", "layer-02", "layer-03", "layer-04"].map((name) => `--v2-background-bg-${name}`)
// The accent tokens the rainbow theme moves, like the .bat's flowing colors.
const ACCENTS = [
  "--v2-background-bg-accent",
  "--surface-interactive-base",
  "--text-interactive-base",
  "--border-interactive-base",
  "--icon-interactive-base",
]

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const getBackground = () => ({ image: read(KEY_IMAGE) ?? "", opacity: clampOpacity(Number(read(KEY_OPACITY) ?? 78)) })

const clampOpacity = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(30, Math.round(value))) : 78)

let observer: MutationObserver | undefined

/** Paints the stored image (or removes it) and re-reads the surface colors, which change with the theme. */
export function applyBackground() {
  const root = document.documentElement
  const { image, opacity } = getBackground()
  for (const name of SURFACES) root.style.removeProperty(name)
  // body and #root paint the same deep color under everything; without a picture they keep it.
  const frame = [document.body, document.getElementById("root")]
  for (const element of frame) element?.style.setProperty("background-color", image ? "transparent" : "")
  if (!image) {
    root.style.removeProperty("background-image")
    return
  }
  // Two translucent layers (window and panel) stack over the picture, so each one gets the alpha that adds up to the setting.
  const alpha = Math.round((1 - Math.sqrt(1 - opacity / 100)) * 100)
  root.style.backgroundImage = `url("${image}")`
  root.style.backgroundSize = "cover"
  root.style.backgroundPosition = "center"
  root.style.backgroundRepeat = "no-repeat"
  const computed = getComputedStyle(root)
  for (const name of SURFACES) {
    const value = computed.getPropertyValue(name).trim()
    if (value) root.style.setProperty(name, `color-mix(in srgb, ${value} ${alpha}%, transparent)`)
  }
}

/** Saves a picked image: shrunk to 1920 px and stored as JPEG so it fits in localStorage. Returns an error text on failure. */
export async function setBackgroundFile(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/")) return "That file is not an image."
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    localStorage.setItem(KEY_IMAGE, canvas.toDataURL("image/jpeg", 0.85))
  } catch {
    return "Could not use that image (too big for the app's storage, or not a readable picture)."
  }
  applyBackground()
}

export function clearBackground() {
  try {
    localStorage.removeItem(KEY_IMAGE)
  } catch {}
  applyBackground()
}

export function setBackgroundOpacity(value: number) {
  try {
    localStorage.setItem(KEY_OPACITY, String(clampOpacity(value)))
  } catch {}
  applyBackground()
}

// Hue moves ~36 degrees a second, a frame every 90 ms as in the .bat; a still page when the user asks for less motion.
function tickRainbow() {
  const root = document.documentElement
  if (root.dataset.theme !== "rainbow") {
    for (const name of ACCENTS) root.style.removeProperty(name)
    return
  }
  const hue = (Date.now() / 28) % 360
  const dark = root.dataset.colorScheme === "dark"
  const color = `hsl(${hue.toFixed(0)} 85% ${dark ? 66 : 46}%)`
  root.style.setProperty("--v2-background-bg-accent", `hsl(${hue.toFixed(0)} 70% ${dark ? 36 : 52}%)`)
  for (const name of ACCENTS.slice(1)) root.style.setProperty(name, color)
}

/** Starts both effects once; the theme machine changes data-theme / data-color-scheme and the style element on every switch. */
export function initLook() {
  if (observer) return
  applyBackground()
  observer = new MutationObserver(() => applyBackground())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme"] })
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  setInterval(tickRainbow, 90)
}


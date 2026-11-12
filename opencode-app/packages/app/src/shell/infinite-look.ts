// Custom background image, custom text color and the moving "rainbow" colors of OpenCode Infinite. Everything lives in the renderer:
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

// Text tokens by weight: the full color, then the muted and the faint steps mixed from it.
const TEXTS: [string, number][] = [
  ["--v2-text-text-base", 100],
  ["--text-base", 100],
  ["--text-strong", 100],
  ["--text-stronger", 100],
  ["--v2-text-text-muted", 72],
  ["--text-weak", 72],
  ["--v2-text-text-faint", 52],
  ["--text-weaker", 52],
  // The icons sit beside the text and follow it.
  ["--v2-icon-icon-base", 100],
  ["--v2-icon-icon-muted", 72],
  ["--v2-icon-icon-faint", 52],
]
const KEY_TEXT = "infinite-text-color"

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
let flowing = false
let lastDrift = -1
// Share of each surface that stays over the background picture; 100 without a picture.
let surfaceAlpha = 100
// Lightness of the rainbow surfaces, in SURFACES order: dark mode, then light mode.
const RAINBOW_SURFACES = { dark: [15, 11, 18, 22, 26, 30], light: [96, 93, 91, 88, 85, 82] }

/** The text color the user picked ("#rrggbb"), or "" for the theme's own. */
export const getTextColor = () => {
  const value = read(KEY_TEXT) ?? ""
  return /^#[0-9a-f]{6}$/i.test(value) ? value : ""
}

// One color for every text weight; undefined gives the theme's colors back.
function paintText(color: string | undefined) {
  const root = document.documentElement
  for (const [name, share] of TEXTS) {
    if (!color) root.style.removeProperty(name)
    else root.style.setProperty(name, share === 100 ? color : `color-mix(in srgb, ${color} ${share}%, transparent)`)
  }
}

/** Saves the picked text color ("" removes it). In the rainbow theme a picked color stops the text from flowing. */
export function setTextColor(color: string) {
  try {
    if (/^#[0-9a-f]{6}$/i.test(color)) localStorage.setItem(KEY_TEXT, color)
    else localStorage.removeItem(KEY_TEXT)
  } catch {}
  paintText(getTextColor() || undefined)
}

/** Paints the stored image (or removes it) and re-reads the surface colors, which change with the theme. */
export function applyBackground() {
  const root = document.documentElement
  const { image, opacity } = getBackground()
  for (const name of SURFACES) root.style.removeProperty(name)
  // body and #root paint the same deep color under everything; without a picture they keep it.
  const frame = [document.body, document.getElementById("root")]
  for (const element of frame) element?.style.setProperty("background-color", image ? "transparent" : "")
  surfaceAlpha = 100
  if (!image) {
    root.style.removeProperty("background-image")
    return
  }
  // Two translucent layers (window and panel) stack over the picture, so each one gets the alpha that adds up to the setting.
  const alpha = Math.round((1 - Math.sqrt(1 - opacity / 100)) * 100)
  surfaceAlpha = alpha
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

// The accents move ~36 degrees a second, a frame every 90 ms as in the .bat; a still page when the user asks for less motion.
function tickRainbow() {
  const root = document.documentElement
  if (root.dataset.theme !== "rainbow") {
    if (!flowing) return
    flowing = false
    lastDrift = -1
    for (const name of ACCENTS) root.style.removeProperty(name)
    paintText(getTextColor() || undefined)
    applyBackground()
    return
  }
  flowing = true
  const hue = (Date.now() / 28) % 360
  const dark = root.dataset.colorScheme === "dark"
  const color = `hsl(${hue.toFixed(0)} 85% ${dark ? 66 : 46}%)`
  root.style.setProperty("--v2-background-bg-accent", `hsl(${hue.toFixed(0)} 70% ${dark ? 36 : 52}%)`)
  for (const name of ACCENTS.slice(1)) root.style.setProperty(name, color)
  // Only the accents move fast. The background and the text drift: one degree every half second, a full turn in
  // three minutes, so the window is never seen changing while you read.
  const drift = Math.floor(Date.now() / 500) % 360
  if (drift === lastDrift) return
  lastDrift = drift
  const textHue = (drift + 180) % 360
  RAINBOW_SURFACES[dark ? "dark" : "light"].forEach((light, index) => {
    const surface = `hsl(${drift} ${dark ? 60 : 80}% ${light}%)`
    root.style.setProperty(SURFACES[index]!, surfaceAlpha === 100 ? surface : `color-mix(in srgb, ${surface} ${surfaceAlpha}%, transparent)`)
  })
  // The text takes the opposite hue of the background, lighter (darker in light mode), so it stays readable.
  if (!getTextColor()) paintText(`hsl(${textHue} 90% ${dark ? 82 : 26}%)`)
}

/** Starts both effects once; the theme machine changes data-theme / data-color-scheme and the style element on every switch. */
export function initLook() {
  if (observer) return
  applyBackground()
  paintText(getTextColor() || undefined)
  observer = new MutationObserver(() => applyBackground())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme"] })
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  setInterval(tickRainbow, 90)
}


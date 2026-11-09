import { createSignal } from "solid-js"

// Whether Auto-rotate is on. While it is, a free-usage limit is handled by rotating the IP and resuming the session,
// so the limit dialog and the "put the prompt back in the composer" recall step aside.
export const [autoRotate, setAutoRotate] = createSignal(false)

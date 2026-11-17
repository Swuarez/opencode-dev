import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"
import { setPinchZoomEnabled, setZoomLevel, webviewZoom, zoomLevel } from "../window/zoom"
import { windowFullscreen } from "../window/fullscreen"
import { DragCancelEvent } from "../../shared/ipc-transport"
import { createPluginBridge } from "../plugins"
import { createDesktopFiles } from "./files"
import { createDesktopMenuAction } from "./menu"
import { createDesktopNotify } from "./notifications"
import { createDesktopStorage } from "./storage"

export type DesktopWindowState = {
  id: string
  version: string
}

export function createDesktopPlatform(api: ElectronAPI, windowState: DesktopWindowState): Platform {
  const os = desktopOS()

  return {
    platform: "desktop",
    os,
    version: windowState.version,
    windowID: windowState.id,
    ...createDesktopFiles(api, os),
    ...createDesktopStorage(api),
    exportDebugLogs: () => api.exportDebugLogs(),
    setForceFocus: (enabled) => api.setForceFocus(enabled),
    recordFatalRendererError: (error) => api.recordFatalRendererError(error),
    restart: async () => api.relaunch(),
    notify: createDesktopNotify(api),
    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)

      return fetch(input, init)
    },
    webviewZoom,
    zoomLevel,
    setZoomLevel,
    windowFullscreen,
    requestMicrophone: () => api.requestMicrophone(),
    setVoiceCallActive: (active) => api.setVoiceCallActive(active),
    setTrafficLightsPosition: (position) => api.setTrafficLightsPosition(position),
    getPinchZoomEnabled: () => api.getPinchZoomEnabled(),
    setPinchZoomEnabled,
    getSpellcheckEnabled: () => api.getSpellcheckEnabled(),
    setSpellcheckEnabled: (enabled) => api.setSpellcheckEnabled(enabled),
    infinite: {
      getMode: () => api.infiniteGetMode(),
      setMode: (mode) => api.infiniteSetMode(mode),
      resetLimit: () => api.infiniteResetLimit(),
      getOptions: () => api.infiniteGetOptions(),
      setOptions: (options) => api.infiniteSetOptions(options),
      checkIp: () => api.infiniteCheckIp(),
      restoreSession: () => api.infiniteRestoreSession(),
      autoRotate: (sessionID: string) => api.infiniteAutoRotate(sessionID),
      fetchList: (url: string) => api.infiniteFetchList(url),
      dictate: () => api.infiniteDictate(),
      clearBurned: () => api.infiniteClearBurned(),
      route64Import: (text: string) => api.infiniteRoute64Import(text),
      route64Status: () => api.infiniteRoute64Status(),
      route64Up: () => api.infiniteRoute64Up(),
      route64Remove: () => api.infiniteRoute64Remove(),
      toolPlan: (tool: "WARP" | "WIREGUARD") => api.infiniteToolPlan(tool),
      toolInstall: (tool: "WARP" | "WIREGUARD", confirmed: boolean) => api.infiniteToolInstall(tool, confirmed),
    },
    onDragCancel: (callback) => {
      window.addEventListener(DragCancelEvent, callback)

      return () => window.removeEventListener(DragCancelEvent, callback)
    },
    runDesktopMenuAction: createDesktopMenuAction(api),
    checkAppExists: async (appName) => {
      return api.checkAppExists(appName)
    },
    plugins: createPluginBridge(),
  }
}

function desktopOS() {
  if (navigator.userAgent.includes("Mac")) return "macos"

  if (navigator.userAgent.includes("Windows")) return "windows"

  if (navigator.userAgent.includes("Linux")) return "linux"

  return undefined
}

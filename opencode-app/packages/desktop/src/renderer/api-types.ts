import type { DesktopMenuAction, DesktopZoomLevel } from "@opencode/app/desktop-menu"
import type { DesktopNativeBundle } from "@opencode/app/i18n/desktop-native"
import type { StorageSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"
import type {
  ClipboardImage,
  DirectoryPickerOptions,
  FatalRendererError,
  FilePickerOptions,
  PickedFiles,
  SaveFilePickerOptions,
  ServerReadyData,
  TitlebarTheme,
} from "../shared/ipc-contract"

export type ElectronAPI = {
  awaitInitialization(): Promise<ServerReadyData>
  reconnectService(signal?: AbortSignal): Promise<ServerReadyData>
  onSidecarChanged(cb: (data: ServerReadyData) => void): () => void
  readyDeepLinks(): void
  acknowledgeDeepLinks(attempt: number): void
  isFirstLaunchOnboardingPending(): Promise<boolean>
  finishFirstLaunchOnboarding(createDefaultProject: boolean): Promise<string | null>
  checkAppExists(appName: string): Promise<boolean>
  resolveAppPath(appName: string): Promise<string | null>
  /** The namespaces the preload read before the page ran; `createDesktopStorage` serves each first read from it. */
  getStorageSnapshot(): Promise<StorageSnapshot>
  storeItems(name: string): Promise<{ items: Record<string, string>; revision: number }>
  storeUpdate(name: string, insert: Record<string, string>, remove: string[]): Promise<number>
  storeClear(name: string): Promise<void>
  onStoreChanged(
    cb: (name: string, insert: Record<string, string>, remove: string[], revision: number) => void,
  ): () => void
  draftGet(key: string): Promise<string | null>
  draftSet(key: string, value: string, strict: boolean): Promise<string[]>
  draftDelete(key: string): Promise<void>
  draftBlobPut(data: ArrayBuffer): Promise<string>
  draftBlobGet(id: string): Promise<ArrayBuffer | null>
  getWindowID(): string
  getWindowBootstrap(): WindowBootstrap
  themeReady(): Promise<void>
  onMenuCommand(cb: (id: string) => void): () => void
  onDeepLink(cb: (delivery: { attempt: number; urls: string[] }) => void): () => void
  openDirectoryPicker(opts?: DirectoryPickerOptions): Promise<string | string[] | null>
  openFilePicker(opts?: FilePickerOptions): Promise<PickedFiles | null>
  readPickedFile(token: string, path: string): Promise<ArrayBuffer>
  releasePickedFiles(token: string): Promise<void>
  getPathForFile(file: File): string
  saveFile(opts: SaveFilePickerOptions, content: string): Promise<boolean>
  openExternal(url: string): void
  openBrowser(url: string): Promise<boolean>
  openLocalFile(url: string): void
  openPath(path: string, app?: string): Promise<string | undefined>
  revealPath(path: string): Promise<boolean>
  readClipboardImage(): Promise<ClipboardImage | null>
  writeClipboardText(text: string): Promise<void>
  getWindowFocused(): Promise<boolean>
  requestMicrophone(): Promise<boolean>
  setVoiceCallActive(active: boolean): Promise<void>
  getWindowFullscreen(): Promise<boolean>
  onWindowFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  setWindowFocus(): Promise<void>
  showWindow(): Promise<void>
  relaunch(): void
  getZoomFactor(): Promise<number>
  setZoomFactor(factor: number): Promise<void>
  getPinchZoomEnabled(): Promise<boolean>
  setPinchZoomEnabled(enabled: boolean): Promise<void>
  onPinchZoomEnabledChanged(cb: (enabled: boolean) => void): () => void
  getZoomLevel(): Promise<DesktopZoomLevel>
  setZoomLevel(level: DesktopZoomLevel): Promise<void>
  onZoomChanged(cb: (zoom: { factor: number; level: DesktopZoomLevel }) => void): () => void
  setTitlebar(theme: TitlebarTheme): Promise<void>
  setTrafficLightsPosition(position: { x: number; y: number }): Promise<void>
  runDesktopMenuAction(action: DesktopMenuAction): Promise<void>
  setBackgroundColor(color: string): Promise<void>
  exportDebugLogs(): Promise<string>
  setForceFocus(enabled: boolean): Promise<void>
  getSpellcheckEnabled(): Promise<boolean>
  setSpellcheckEnabled(enabled: boolean): Promise<void>
  recordFatalRendererError(error: FatalRendererError): Promise<void>
  setNativeTranslations(bundle: DesktopNativeBundle): Promise<void>
  infiniteGetMode(): Promise<"POOL" | "WARP" | "TOR" | "PROXY" | "SOCKS" | "ROUTE64" | "MULLVAD" | "WINDSCRIBE" | "NONE">
  infiniteSetMode(mode: "POOL" | "WARP" | "TOR" | "PROXY" | "SOCKS" | "ROUTE64" | "MULLVAD" | "WINDSCRIBE" | "NONE"): Promise<{ ok: boolean; message: string; ip?: string }>
  infiniteResetLimit(): Promise<{ ok: boolean; message: string; ip?: string }>
  infiniteGetOptions(): Promise<{ auto: boolean; country: string; custom: string; fast: boolean; attempts: number; rotateUrl: string; vpnLocations: string; socks: string; chain: string; burned: number }>
  infiniteSetOptions(options: { auto: boolean; country: string; custom: string; fast: boolean; attempts: number; rotateUrl: string; vpnLocations: string; socks: string; chain: string; burned: number }): Promise<{ auto: boolean; country: string; custom: string; fast: boolean; attempts: number; rotateUrl: string; vpnLocations: string; socks: string; chain: string; burned: number }>
  infiniteCheckIp(): Promise<{ ok: boolean; message: string; ip?: string }>
  infiniteRestoreSession(): Promise<{ ok: boolean; message: string; ip?: string }>
  infiniteAutoRotate(sessionID: string): Promise<void>
  infiniteFetchList(url: string): Promise<{ ok: boolean; text: string }>
  infiniteDictate(): Promise<{ ok: boolean; message: string; ip?: string }>
  infiniteClearBurned(): Promise<{ ok: boolean; message: string }>
  infiniteRoute64Import(text: string): Promise<{ ok: boolean; message: string; endpoint?: string }>
  infiniteRoute64Status(): Promise<{ imported: boolean; endpoint?: string; up: boolean }>
  infiniteRoute64Up(): Promise<{ ok: boolean; message: string }>
  infiniteRoute64Remove(): Promise<{ ok: boolean; message: string }>
  infiniteToolPlan(tool: "WARP" | "WIREGUARD"): Promise<{ installed: boolean; url?: string; publisher?: string }>
  infiniteToolInstall(tool: "WARP" | "WIREGUARD", confirmed: boolean): Promise<{ ok: boolean; message: string }>
}

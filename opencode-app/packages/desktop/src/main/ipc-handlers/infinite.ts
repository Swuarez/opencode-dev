import { Effect } from "effect"
import { InfiniteRpcs } from "../../shared/ipc-rpc/infinite"
import {
  applyMode,
  archiveAuth,
  checkIp,
  clearBurned,
  fetchList,
  getMode,
  getOptions,
  autoStatus,
  huntIp,
  leaveMode,
  lock,
  restoreSession,
  pending,
  resumeSession,
  rotateOnly,
  setMode,
  setOptions,
  startWatch,
  type Result,
} from "../infinite/infinite"
import { dictate, dictationLanguages, stopDictation } from "../infinite/dictate"
import { install, plan } from "../infinite/install"
import { bringUpRoute64, importRoute64, removeRoute64, route64Status } from "../infinite/route64"
import { BackgroundService, customChannelFile, registrationFile } from "../service/background-service"
import { DesktopCli } from "../service/desktop-cli"

export const infiniteHandlers = InfiniteRpcs.toLayer(
  Effect.gen(function* () {
    const background = yield* BackgroundService.Service
    const desktopCli = yield* DesktopCli.Service
    const runFork = Effect.runForkWith(yield* Effect.context())

    // This CLI registers under its own channel name, so stopping must look in that file, not the default one.
    const stopService = Effect.gen(function* () {
      const cli = yield* desktopCli.resolve
      yield* Effect.tryPromise(async () => {
        const client = await import("@opencode/client/service")
        await client.Service.stop({ file: registrationFile() ?? customChannelFile(cli.version) })
      })
    })
    const startService = Effect.asVoid(background.reconnect)

    // The service reads its proxy environment only when it starts. Where the proxy URL is already known (WARP, Tor,
    // None) it starts while the network work runs, instead of after it.
    const withService = (network: () => Promise<Result>) =>
      Effect.gen(function* () {
        // The service only ever sees a local address (the door or a bridge), so it starts while the network work runs.
        const [result] = yield* Effect.all([Effect.tryPromise(network), startService], { concurrency: 2 })
        return result
      })

    // One action at a time: the lock is taken before anything is stopped.
    const guarded = (body: Effect.Effect<Result, unknown>): Effect.Effect<Result> => {
      const release = lock()
      if (!release) return Effect.succeed({ ok: false, message: "Another action is still running." })
      return body.pipe(
        Effect.catch((error) =>
          Effect.succeed<Result>({ ok: false, message: error instanceof Error ? error.message : String(error) }),
        ),
        Effect.ensuring(Effect.sync(release)),
      )
    }

    const setModeFlow = (mode: Parameters<typeof applyMode>[0]) =>
      guarded(
        Effect.gen(function* () {
          const previous = getMode()
          yield* stopService
          yield* Effect.tryPromise(() => setMode(mode))
          // Leaving Route64 takes its tunnel down; leaving Mullvad or Windscribe disconnects that client.
          yield* Effect.tryPromise(() => leaveMode(previous, mode))
          return yield* withService(() => applyMode(mode))
        }),
      )

    // "Reset limit": the session is archived while the service is stopped, then the IP is renewed.
    const resetFlow = () =>
      guarded(
        Effect.gen(function* () {
          yield* stopService
          const archived = yield* Effect.tryPromise(archiveAuth)
          const net = yield* withService(rotateOnly)
          const note = archived ? "Session saved and removed. " : "No session found. "
          return { ...net, message: note + net.message }
        }),
      )

    const restoreFlow = () =>
      guarded(
        Effect.gen(function* () {
          yield* stopService
          const result = yield* Effect.tryPromise(restoreSession)
          yield* startService
          return result
        }),
      )

    // Auto-rotate keeps the session. WARP and Tor keep the same local proxy, so they rotate without a restart.
    // The IPs are tried on throwaway probe sessions; the chat is only touched once one works.
    const autoRotate = (sessionID: string) =>
      guarded(
        Effect.gen(function* () {
          const started = Date.now()
          const cli = yield* desktopCli.resolve
          const net = yield* Effect.tryPromise(() => huntIp(cli.command))
          if (!net.ok) return net
          // Every chat that is waiting gets "continue" on this one new IP, in parallel.
          if (sessionID) pending.add(sessionID)
          const chats = [...pending]
          pending.clear()
          const seconds = ((Date.now() - started) / 1000).toFixed(1)
          if (!chats.length) {
            autoStatus(`new IP ${net.ip ?? ""} works in ${seconds}s, no chat to continue`, true)
            return net
          }
          autoStatus(`new IP ${net.ip ?? ""} works, sending "continue" to ${chats.length} chat(s)…`)
          const results = yield* Effect.promise(() =>
            Promise.all(chats.map((id) => resumeSession(id).catch(() => false))),
          )
          const sent = results.filter(Boolean).length
          // Timing of the whole rotation, for checking the 3-5 s target in logs.
          console.info(`[auto-rotate] ${chats.length} chat(s) continued in ${seconds}s (${sent} sent)`)
          autoStatus(
            sent === chats.length
              ? `new IP ${net.ip ?? ""} in ${seconds}s, "continue" sent to ${sent} chat(s)`
              : `new IP ${net.ip ?? ""} in ${seconds}s, "continue" sent to ${sent} of ${chats.length} chat(s): send the rest yourself`,
            true,
          )
          return net
        }),
      )

    // Failed hunts in a row. The chats stay waiting and are retried a little later, then reported for the user.
    let failedHunts = 0
    const trigger = startWatch((sessionID) =>
      void runFork(
        autoRotate(sessionID).pipe(
          Effect.tap((net) =>
            Effect.sync(() => {
              if (net.ok) {
                failedHunts = 0
                // A chat that reached the limit while this rotation was resuming the others starts its own rotation.
                if (pending.size) trigger("chats waiting")
                return
              }
              if (!pending.size) return
              if (failedHunts < 3) {
                failedHunts++
                autoStatus(`no working IP (${net.message}), retrying in 60 s (${failedHunts}/3)`)
                setTimeout(() => trigger("retry after a failed IP"), 60_000)
                return
              }
              failedHunts = 0
              autoStatus(`no working IP after 3 tries: send "continue" yourself in ${pending.size} chat(s)`, true)
              pending.clear()
            }),
          ),
        ),
      ),
      // The chat is retrying the free limit itself: only the IP changes (the old one is remembered as used), no probe.
      () =>
        void runFork(
          guarded(
            Effect.gen(function* () {
              const started = Date.now()
              const net = yield* Effect.tryPromise(rotateOnly)
              const seconds = ((Date.now() - started) / 1000).toFixed(1)
              autoStatus(
                net.ok ? `new IP ${net.ip ?? ""} in ${seconds}s, the chat resends on it` : `IP change failed: ${net.message}`,
                true,
              )
              return net
            }),
          ),
        ),
    )

    return InfiniteRpcs.of({
      InfiniteGetMode: () => Effect.sync(getMode),
      InfiniteSetMode: ({ mode }) => setModeFlow(mode),
      InfiniteResetLimit: resetFlow,
      InfiniteRestoreSession: restoreFlow,
      InfiniteAutoRotate: ({ sessionID }) => Effect.sync(() => trigger("limit reached", sessionID)),
      InfiniteFetchList: ({ url }) => Effect.promise(() => fetchList(url)),
      InfiniteDictate: ({ language }) => Effect.promise(() => dictate(language)),
      InfiniteDictateStop: () => Effect.sync(stopDictation),
      InfiniteDictateLanguages: () => Effect.promise(dictationLanguages),
      InfiniteClearBurned: () => Effect.promise(clearBurned),
      InfiniteCheckIp: () => Effect.promise(checkIp),
      InfiniteGetOptions: () => Effect.sync(getOptions),
      InfiniteSetOptions: (options) => Effect.promise(() => setOptions(options).then(getOptions)),
      InfiniteToolPlan: ({ tool }) => Effect.promise(() => plan(tool)),
      InfiniteToolInstall: ({ tool, confirmed }) => Effect.promise(() => install(tool, confirmed)),
      InfiniteRoute64Import: ({ text }) => Effect.promise(() => importRoute64(text)),
      InfiniteRoute64Status: () => Effect.promise(route64Status),
      InfiniteRoute64Up: () => Effect.promise(bringUpRoute64),
      InfiniteRoute64Remove: () => Effect.promise(removeRoute64),
    })
  }),
)

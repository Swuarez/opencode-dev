import { Effect } from "effect"
import { InfiniteRpcs } from "../../shared/ipc-rpc/infinite"
import {
  applyMode,
  archiveAuth,
  checkIp,
  fetchList,
  getMode,
  getOptions,
  huntIp,
  lock,
  restoreSession,
  resumeSession,
  rotateOnly,
  setMode,
  setOptions,
  startWatch,
  upstreamKnown,
  type Result,
} from "../infinite/infinite"
import { BackgroundService, registrationFile } from "../service/background-service"
import { DesktopCli } from "../service/desktop-cli"

export const infiniteHandlers = InfiniteRpcs.toLayer(
  Effect.gen(function* () {
    const background = yield* BackgroundService.Service
    const desktopCli = yield* DesktopCli.Service
    const runFork = Effect.runForkWith(yield* Effect.context())

    const stopService = Effect.tryPromise(async () => {
      const client = await import("@opencode/client/service")
      await client.Service.stop({ file: registrationFile() })
    })
    const startService = Effect.asVoid(background.reconnect)

    // The service reads its proxy environment only when it starts. Where the proxy URL is already known (WARP, Tor,
    // None) it starts while the network work runs, instead of after it.
    const withService = (network: () => Promise<Result>) =>
      Effect.gen(function* () {
        const work = Effect.tryPromise(network)
        if (!upstreamKnown()) {
          const result = yield* work
          yield* startService
          return result
        }
        const [result] = yield* Effect.all([work, startService], { concurrency: 2 })
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
          yield* stopService
          yield* Effect.tryPromise(() => setMode(mode))
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
          const cli = yield* desktopCli.resolve
          const net = yield* Effect.tryPromise(() => huntIp(cli.command))
          // A proxy that changed needs the service restarted behind it.
          if (net.ok && !upstreamKnown()) {
            yield* stopService
            yield* startService
          }
          // The conversation goes on by itself once the new IP works.
          if (net.ok && sessionID) yield* Effect.ignore(Effect.tryPromise(() => resumeSession(sessionID)))
          return net
        }),
      )

    const trigger = startWatch((sessionID) => void runFork(autoRotate(sessionID)))

    return InfiniteRpcs.of({
      InfiniteGetMode: () => Effect.sync(getMode),
      InfiniteSetMode: ({ mode }) => setModeFlow(mode),
      InfiniteResetLimit: resetFlow,
      InfiniteRestoreSession: restoreFlow,
      InfiniteAutoRotate: ({ sessionID }) => Effect.sync(() => trigger("limit reached", sessionID)),
      InfiniteFetchList: ({ url }) => Effect.promise(() => fetchList(url)),
      InfiniteCheckIp: () => Effect.promise(checkIp),
      InfiniteGetOptions: () => Effect.sync(getOptions),
      InfiniteSetOptions: (options) => Effect.promise(() => setOptions(options).then(getOptions)),
    })
  }),
)

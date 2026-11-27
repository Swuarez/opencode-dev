import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const Mode = Schema.Literals(["POOL", "WARP", "TOR", "PROXY", "SOCKS", "ROUTE64", "MULLVAD", "WINDSCRIBE", "NONE"])

const Result = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  ip: Schema.optionalKey(Schema.String),
  busy: Schema.optionalKey(Schema.Boolean),
})

export const InfiniteGetMode = Rpc.make("InfiniteGetMode", { success: Mode })

export const InfiniteSetMode = Rpc.make("InfiniteSetMode", { payload: { mode: Mode }, success: Result })

export const InfiniteResetLimit = Rpc.make("InfiniteResetLimit", {
  payload: { sessionID: Schema.optionalKey(Schema.String) },
  success: Result,
})

export const InfiniteCheckIp = Rpc.make("InfiniteCheckIp", { success: Result })

const Stage = Schema.Literals([
  "idle",
  "stopping",
  "archiving",
  "rotating",
  "starting",
  "resuming",
  "continuing",
  "done",
  "failed",
])

export const InfiniteGetStatus = Rpc.make("InfiniteGetStatus", {
  success: Schema.Struct({ stage: Stage, message: Schema.String, at: Schema.Number }),
})

export const InfiniteRestoreSession = Rpc.make("InfiniteRestoreSession", { success: Result })

export const InfiniteAutoRotate = Rpc.make("InfiniteAutoRotate", { payload: { sessionID: Schema.String } })

export const InfiniteFetchList = Rpc.make("InfiniteFetchList", {
  payload: { url: Schema.String },
  success: Schema.Struct({ ok: Schema.Boolean, text: Schema.String }),
})

const Options = Schema.Struct({
  auto: Schema.Boolean,
  country: Schema.String,
  custom: Schema.String,
  fast: Schema.Boolean,
  attempts: Schema.Number,
  rotateUrl: Schema.String,
  vpnLocations: Schema.String,
  socks: Schema.String,
  chain: Schema.String,
  burned: Schema.Number,
})

export const InfiniteClearBurned = Rpc.make("InfiniteClearBurned", { success: Result })

export const InfiniteGetOptions = Rpc.make("InfiniteGetOptions", { success: Options })

export const InfiniteSetOptions = Rpc.make("InfiniteSetOptions", { payload: Options, success: Options })

const Route64Result = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })

export const InfiniteRoute64Import = Rpc.make("InfiniteRoute64Import", {
  payload: { text: Schema.String },
  success: Schema.Struct({ ok: Schema.Boolean, message: Schema.String, endpoint: Schema.optionalKey(Schema.String) }),
})

export const InfiniteRoute64Status = Rpc.make("InfiniteRoute64Status", {
  success: Schema.Struct({ imported: Schema.Boolean, endpoint: Schema.optionalKey(Schema.String), up: Schema.Boolean }),
})

export const InfiniteRoute64Up = Rpc.make("InfiniteRoute64Up", { success: Route64Result })

export const InfiniteRoute64Remove = Rpc.make("InfiniteRoute64Remove", { success: Route64Result })

const Tool = Schema.Literals(["WARP", "WIREGUARD"])

export const InfiniteToolPlan = Rpc.make("InfiniteToolPlan", {
  payload: { tool: Tool },
  success: Schema.Struct({
    installed: Schema.Boolean,
    url: Schema.optionalKey(Schema.String),
    publisher: Schema.optionalKey(Schema.String),
  }),
})

export const InfiniteToolInstall = Rpc.make("InfiniteToolInstall", {
  payload: { tool: Tool, confirmed: Schema.Boolean },
  success: Route64Result,
})

export const InfiniteDictate = Rpc.make("InfiniteDictate", { success: Result })

export const InfiniteRpcs = RpcGroup.make(
  InfiniteDictate,
  InfiniteToolPlan,
  InfiniteToolInstall,
  InfiniteRoute64Import,
  InfiniteRoute64Status,
  InfiniteRoute64Up,
  InfiniteRoute64Remove,
  InfiniteClearBurned,
  InfiniteGetOptions,
  InfiniteSetOptions,
  InfiniteGetMode,
  InfiniteSetMode,
  InfiniteResetLimit,
  InfiniteCheckIp,
  InfiniteGetStatus,
  InfiniteRestoreSession,
  InfiniteAutoRotate,
  InfiniteFetchList,
)

import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const Mode = Schema.Literals(["WARP", "TOR", "PROXY", "NONE"])

const Result = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  ip: Schema.optionalKey(Schema.String),
})

export const InfiniteGetMode = Rpc.make("InfiniteGetMode", { success: Mode })

export const InfiniteSetMode = Rpc.make("InfiniteSetMode", { payload: { mode: Mode }, success: Result })

export const InfiniteResetLimit = Rpc.make("InfiniteResetLimit", { success: Result })

export const InfiniteCheckIp = Rpc.make("InfiniteCheckIp", { success: Result })

export const InfiniteRestoreSession = Rpc.make("InfiniteRestoreSession", { success: Result })

export const InfiniteAutoRotate = Rpc.make("InfiniteAutoRotate", { payload: { sessionID: Schema.String } })

export const InfiniteFetchList = Rpc.make("InfiniteFetchList", {
  payload: { url: Schema.String },
  success: Schema.Struct({ ok: Schema.Boolean, text: Schema.String }),
})

const Options = Schema.Struct({ auto: Schema.Boolean, country: Schema.String, custom: Schema.String })

export const InfiniteGetOptions = Rpc.make("InfiniteGetOptions", { success: Options })

export const InfiniteSetOptions = Rpc.make("InfiniteSetOptions", { payload: Options, success: Options })

export const InfiniteRpcs = RpcGroup.make(
  InfiniteGetOptions,
  InfiniteSetOptions,
  InfiniteGetMode,
  InfiniteSetMode,
  InfiniteResetLimit,
  InfiniteCheckIp,
  InfiniteRestoreSession,
  InfiniteAutoRotate,
  InfiniteFetchList,
)

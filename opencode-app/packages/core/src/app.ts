export * as App from "./app.js"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? "opencode",
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

// The free tier rejects clients older than this. Our own builds are versioned `0.0.0-<channel>-<timestamp>`
// (the version also picks the service file and DB), so they advertise this floor instead.
// shortcut: raise when the server's minimum goes up.
const MIN_SERVER_VERSION = "1.18.0"

export function useragent(app: Info) {
  const version = app.version.startsWith("0.0.0-") ? MIN_SERVER_VERSION : app.version
  return `opencode/${app.channel}/${version}/${app.name}`
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

export const node = configured()

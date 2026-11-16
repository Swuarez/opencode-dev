import { expect } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { OmniRoutePlugin, baseURLOf } from "@opencode/core/plugin/provider/omniroute"
import { Provider } from "@opencode/core/provider"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("omniroute")
const providerID = Provider.ID.make("omniroute")

it.effect("the address typed at login is trimmed and only http(s) counts", () =>
  Effect.sync(() => {
    expect(baseURLOf(" https://gw.example.com/v1/ ")).toBe("https://gw.example.com/v1")
    expect(baseURLOf("ftp://gw.example.com")).toBeUndefined()
    expect(baseURLOf("gw.example.com")).toBeUndefined()
    expect(baseURLOf(undefined)).toBeUndefined()
  }),
)

it.effect("a stored login makes the gateway's models a provider that uses its address and key", () =>
  Effect.gen(function* () {
    const requests: Request[] = []
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        requests.push(yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ data: [{ id: "auto/best-coding" }, { id: "gpt-x", context_length: 64_000 }] }),
        )
      }),
    )
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID,
      value: Credential.Key.make({ type: "key", key: "secret", metadata: { baseURL: "https://gw.example.com/v1/" } }),
    })
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin, "test")
    yield* OmniRoutePlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
    yield* drain

    expect(requests[0]?.url).toBe("https://gw.example.com/v1/models")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret")
    const providers = yield* Provider.Service
    const provider = yield* providers.get(providerID)
    expect(provider?.settings).toMatchObject({ baseURL: "https://gw.example.com/v1", apiKey: "secret" })
    const integrations = yield* Integration.Service
    expect((yield* integrations.get(integrationID))?.methods).toContainEqual(
      expect.objectContaining({ type: "key", form: [expect.objectContaining({ key: "baseURL", required: true })] }),
    )
  }),
)

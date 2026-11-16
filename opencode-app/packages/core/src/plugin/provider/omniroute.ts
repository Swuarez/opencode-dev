import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Effect, Equal, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { activeCredential, credentialSettings } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

// The user's own OmniRoute (or any OpenAI-compatible gateway): connecting asks for its API address and key, and the
// models are whatever that server lists at `<address>/models`.

const providerID = Provider.ID.make("omniroute")
const integrationID = Integration.ID.make("omniroute")
const catalogKey = "omniroute-model-catalog"
// shortcut: gateways rarely report limits, so a listed model without one gets these; set them per model in config if they matter.
const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 16_384

const Catalog = Schema.Struct({
  baseURL: Schema.String,
  models: Schema.Array(Schema.Struct({ id: Schema.String, context: Schema.Int })),
})
type Catalog = typeof Catalog.Type
const Listing = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, context_length: Schema.optionalKey(Schema.Number) })),
})

/** The address as typed, without trailing slashes; anything that is not http(s) counts as none. */
export function baseURLOf(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().replace(/\/+$/, "")
  return /^https?:\/\/[^\s/]+/i.test(trimmed) ? trimmed : undefined
}

export const OmniRoutePlugin = define({
  id: "opencode.provider.omniroute",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const saved = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(catalogKey))
    const catalog = { current: Option.getOrElse(saved, (): Catalog => ({ baseURL: "", models: [] })) }
    // The key method's form answer (the address) is stored as credential metadata beside the key.
    const account = yield* credentialSettings(ctx, integrationID, (value) =>
      value.type === "key"
        ? { apiKey: value.key, ...(baseURLOf(value.metadata?.baseURL) ? { baseURL: baseURLOf(value.metadata?.baseURL) } : {}) }
        : {},
    )

    const refresh = Effect.fn("OmniRoutePlugin.refresh")(function* () {
      const { credential } = yield* activeCredential(ctx, integrationID)
      const baseURL = credential?.type === "key" ? baseURLOf(credential.metadata?.baseURL) : undefined
      if (credential?.type !== "key" || !baseURL) return
      const response = yield* http.execute(
        HttpClientRequest.get(`${baseURL}/models`).pipe(
          HttpClientRequest.acceptJson,
          credential.key ? HttpClientRequest.bearerToken(credential.key) : (request) => request,
        ),
      )
      if (response.status !== 200) return
      const listing = yield* HttpClientResponse.schemaBodyJson(Listing)(response)
      const next: Catalog = {
        baseURL,
        models: listing.data
          .filter((item) => /^[^\s]{1,200}$/.test(item.id))
          .map((item) => ({ id: item.id, context: Math.round(item.context_length ?? DEFAULT_CONTEXT) })),
      }
      if (next.models.length === 0 || Equal.equals(next, catalog.current)) return
      catalog.current = next
      yield* ctx.storage.set(catalogKey, next)
      yield* ctx.provider.reload()
    })
    // A server that is down or answers something else leaves the last known list in place.
    const safeRefresh = refresh().pipe(
      Effect.catch((error) => Effect.logWarning("OmniRoute model list failed", { error })),
    )
    yield* ProviderRefresh.onSwitch(integrationID, safeRefresh)
    yield* safeRefresh.pipe(Effect.forkScoped)

    yield* ctx.integration.transform((integrations) => {
      if (!integrations.get(integrationID))
        integrations.update(integrationID, (integration) => {
          integration.name = "OmniRoute"
        })
      integrations.method.update({
        integrationID,
        method: {
          type: "key",
          label: "API key",
          form: Form.Fields.make([
            {
              type: "string",
              key: "baseURL",
              title: "Enter your OmniRoute API address",
              placeholder: "e.g. https://omniroute.example.com/v1",
              required: true,
            },
          ]),
        },
      })
    })

    yield* ctx.provider.transform((providers) => {
      const baseURL = account.settings.baseURL ?? catalog.current.baseURL
      providers.add({
        info: {
          id: providerID,
          integrationID,
          name: "OmniRoute",
          activation: "auto",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { provider: providerID, ...(baseURL ? { baseURL } : {}), ...account.settings },
        },
        models: catalog.current.models.map((model) => ({
          id: Model.ID.make(model.id),
          modelID: Model.ID.make(model.id),
          providerID,
          name: model.id,
          family: Model.Family.make("omniroute"),
          capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true },
          compatibility: { supportsDeveloperRole: false, supportsEffortUpdates: false },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active" as const,
          enabled: true,
          limit: { context: model.context, output: DEFAULT_OUTPUT },
        })),
      })
    })
  }),
} satisfies PluginInternal.InternalPlugin)

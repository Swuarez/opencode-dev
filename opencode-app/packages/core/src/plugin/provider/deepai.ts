import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Effect, Equal, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Server } from "node:http"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"
import { activeCredential, credentialSettings } from "./credential-settings.js"
import { headers as machineHeaders } from "./deepai-machine.js"
import { ProviderRefresh } from "./refresh.js"

// DeepAI Code's own wire contract, recovered from its desktop build: sign-in is an RFC 8252 loopback exchange, and
// models are served from an OpenAI-compatible endpoint whose requests carry the account key plus attribution headers.
// DeepAI Code proxies the same calls through a 127.0.0.1 gateway; opencode talks to the origin directly.

const providerID = Provider.ID.deepai
const integrationID = Integration.ID.make("deepai")
const methodID = Integration.MethodID.make("browser")
const API_ORIGIN = "https://api.deepai.org"
const MODEL_BASE = `${API_ORIGIN}/deepai_code`
const LANE = "6"
const instance = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")
const catalogKey = "deepai-model-catalog"
const maxExpiry = 8_640_000_000_000_000
const LEVELS = ["none", "low", "medium", "high", "max"] as const

const CatalogModel = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,128}$/)),
  name: Schema.String,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.Literals(["text", "image"])),
  contextWindow: Schema.Int,
  maxTokens: Schema.Int,
  premier: Schema.optionalKey(Schema.Boolean),
  theosPerRequest: Schema.optionalKey(Schema.String),
  theosPerSecond: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
const Catalog = Schema.Struct({ models: Schema.Array(CatalogModel) })
type Catalog = typeof Catalog.Type
const SignIn = Schema.Struct({ api_key: Schema.String.check(Schema.isMinLength(1)), username: Schema.optionalKey(Schema.String) })

/** Attribution DeepAI's own client sends on every model call. */
const laneHeaders = () => ({ "X-DeepAI-Code-Theos": LANE, "X-DeepAI-Code-Instance": instance })

export const DeepAIPlugin = define({
  id: "opencode.provider.deepai",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const saved = Schema.decodeUnknownOption(Catalog)(yield* ctx.storage.get(catalogKey))
    const catalog = { current: Option.getOrElse(saved, (): Catalog => ({ models: [] })) }
    const machine = yield* Effect.promise(machineHeaders)
    const account = yield* credentialSettings(ctx, integrationID, (value) => ({
      apiKey: value.type === "oauth" ? value.access : "",
    }))

    // The catalog follows the signed-in account: fetched at startup and again whenever that account switches.
    const refresh = Effect.fn("DeepAIPlugin.refresh")(function* () {
      const { connection, credential } = yield* activeCredential(ctx, integrationID)
      if (!connection || credential?.type !== "oauth" || credential.methodID !== methodID) return
      const response = yield* http.execute(
        HttpClientRequest.get(`${MODEL_BASE}/models`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({ ...laneHeaders(), "api-key": credential.access }),
        ),
      )
      if (response.status !== 200) return
      const body = yield* HttpClientResponse.schemaBodyJson(Catalog)(response)
      if (body.models.length === 0 || Equal.equals(body, catalog.current)) return
      catalog.current = body
      yield* ctx.storage.set(catalogKey, body)
      yield* ctx.provider.reload()
    })
    yield* ProviderRefresh.onSwitch(integrationID, refresh())
    yield* refresh().pipe(Effect.forkScoped)

    yield* ctx.integration.transform((integrations) => {
      if (!integrations.get(integrationID))
        integrations.update(integrationID, (integration) => {
          integration.name = "DeepAI"
        })
      integrations.method.update(oauth(http))
    })

    yield* ctx.provider.transform((providers) => {
      providers.add({
        info: {
          id: providerID,
          integrationID,
          name: "DeepAI",
          activation: "auto",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: MODEL_BASE, provider: providerID, ...account.settings },
          headers: {
            ...laneHeaders(),
            ...machine,
            ...(typeof account.settings.apiKey === "string" && account.settings.apiKey
              ? { "api-key": account.settings.apiKey }
              : {}),
          },
        },
        models: catalog.current.models.map((model) => ({
          id: Model.ID.make(model.id),
          modelID: Model.ID.make(model.id),
          providerID,
          name: model.name,
          family: Model.Family.make("deepai"),
          capabilities: {
            tools: true,
            input: model.input,
            output: ["text"],
            temperature: !model.reasoning,
          },
          compatibility: { supportsDeveloperRole: false, supportsEffortUpdates: false },
          // DeepAI names thinking levels itself; `none` is the plain answer and the rest raise effort.
          variants: model.reasoning
            ? LEVELS.filter((level) => level !== "max" || /deepai-cyber|muse-ember/.test(model.id)).map((level) => ({
                id: Model.VariantID.make(level),
                body: { reasoning_effort: level },
              }))
            : [],
          time: { released: 0 },
          cost: [],
          status: "active" as const,
          enabled: true,
          limit: { context: model.contextWindow, output: model.maxTokens },
        })),
      })
    })

    yield* ctx.session.hook(
      "http.request",
      Effect.fn(function* (event) {
        // Resolved per request: the stored key changes with the account and a retry must carry the current one.
        const { credential } = yield* activeCredential(ctx, integrationID)
        if (credential?.type === "oauth") event.request.headers.set("api-key", credential.access)
        for (const [name, value] of Object.entries({ ...laneHeaders(), ...(yield* Effect.promise(machineHeaders)) }))
          event.request.headers.set(name, value)
      }),
      { providerID },
    )
    // A spent allowance is not a rate limit: the app's rotation reacts to `provider.free-limit`, which the session error
    // mapping derives from a `FreeUsageLimitError` body, so a refusal is relabelled into that shape.
    yield* ctx.session.hook(
      "http.response",
      Effect.fn(function* (event) {
        if (event.response.status !== 402 && event.response.status !== 429) return
        const body = yield* Effect.promise(() => event.response.clone().text().catch(() => ""))
        if (!/theos|allowance|limit|quota/i.test(body)) return
        event.response = Response.json(
          { error: { code: "FreeUsageLimitError", type: "quota_exceeded", message: "DeepAI allowance spent." } },
          { status: 402 },
        )
      }),
      { providerID },
    )
  }),
} satisfies PluginInternal.InternalPlugin)

const listen = (server: Server) =>
  Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => resolve())
      }),
  )

const oauth = (http: HttpClient.HttpClient) => ({
  integrationID,
  method: { id: methodID, type: "oauth", label: "Login with DeepAI (browser)" },
  // The key has no expiry; a dead connection is reported when DeepAI answers 401.
  refresh: (value: Credential.OAuth) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        value.expires > now
          ? Effect.succeed(value)
          : Effect.fail(new Error("The DeepAI connection expired. Log in with DeepAI again.")),
      ),
    ),
  authorize: () =>
    Effect.gen(function* () {
      const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
      const code = yield* Deferred.make<string, Error>()
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        if (request.method !== "GET" || url.pathname !== "/auth-callback") return void response.writeHead(404).end()
        const value = url.searchParams.get("code")
        const failure =
          url.searchParams.get("state") !== state ? "Invalid sign-in state" : !value ? "Missing code" : undefined
        response
          .writeHead(failure ? 400 : 200, { "Content-Type": "text/html" })
          .end(
            failure
              ? OauthCallbackPage.error(failure, { provider: "DeepAI" })
              : OauthCallbackPage.success({ provider: "DeepAI" }),
          )
        Effect.runFork(failure ? Deferred.fail(code, new Error(failure)) : Deferred.succeed(code, value ?? ""))
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.close()
          server.closeAllConnections()
        }),
      )
      yield* listen(server)
      const address = server.address()
      if (!address || typeof address === "string") return yield* Effect.fail(new Error("Missing callback port"))
      return {
        mode: "auto" as const,
        url: `${MODEL_BASE}/desktop_auth/?${new URLSearchParams({ state, port: String(address.port) })}`,
        instructions: "Complete the DeepAI sign-in in your browser. This window closes automatically.",
        callback: Effect.gen(function* () {
          const value = yield* Deferred.await(code)
          const response = yield* HttpClientRequest.post(`${MODEL_BASE}/desktop_auth/exchange/`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.schemaBodyJson(Schema.Struct({ code: Schema.String }))({ code: value }),
            Effect.flatMap((request) => http.execute(request)),
          )
          if (response.status === 400 || response.status === 401)
            return yield* Effect.fail(
              new Error("This sign-in link expired or was already used. Start sign-in again."),
            )
          if (response.status !== 200)
            return yield* Effect.fail(new Error(`DeepAI sign-in failed (${response.status})`))
          const decoded = yield* HttpClientResponse.schemaBodyJson(SignIn)(response).pipe(
            Effect.mapError(() => new Error("Invalid DeepAI sign-in response")),
          )
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: decoded.api_key,
            refresh: "",
            expires: maxExpiry,
            metadata: { username: decoded.username ?? "" },
          })
        }),
      }
    }),
}) satisfies IntegrationOAuthMethodRegistration

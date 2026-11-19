import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Duration, Effect, Equal, Option, Schema } from "effect"
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
// The lane the signed-in app is served on. 6 was the fork's lane and the origin now answers it with HTTP 426
// ("This version of DeepAI Code is no longer supported") on the fast path; 7 is what the official client sends.
const LANE = "7"
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
// DeepAI Code pings /theos and carries the check-in nonce it returns on every model call. It is attribution tied to the
// daily allowance; sending it makes our calls look like the official client's.
const CheckIn = Schema.Struct({
  check_in: Schema.optionalKey(Schema.Struct({ nonce: Schema.String, seconds: Schema.Number })),
})

/**
 * Attribution DeepAI's own client sends on every model call.
 *
 * The user agent is not decoration. Measured against the real lane with the app's own 95k-character body, alternating
 * inside one process: `User-Agent: node` answered in 15–1091 ms (median 255 ms) on every attempt, while Bun's default
 * agent or an `opencode/...` agent took 3.8–27.6 s (median 14–23 s) on the same body, key and lane. The origin serves
 * the client it recognises from the fast pool and queues everything else, which is exactly why the official app feels
 * instant with the same guide and this build did not.
 */
const laneHeaders = () => ({
  "X-DeepAI-Code-Theos": LANE,
  "X-DeepAI-Code-Instance": instance,
  "User-Agent": "node",
})

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

    // Check-in: refreshed in the background so it never adds latency to a chat; the current nonce rides along on every
    // request (see the http.request hook). Best-effort — a failed /theos just means no header, exactly as before.
    const checkIn: { nonce?: string; seconds: number; at: number } = { seconds: 600, at: 0 }
    const refreshCheckIn = Effect.fn("DeepAIPlugin.checkIn")(function* () {
      const { credential } = yield* activeCredential(ctx, integrationID)
      if (credential?.type !== "oauth") return
      const response = yield* http.execute(
        HttpClientRequest.get(`${MODEL_BASE}/theos`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({ ...laneHeaders(), ...machine, "api-key": credential.access }),
        ),
      )
      if (response.status !== 200) return
      const value = (yield* HttpClientResponse.schemaBodyJson(CheckIn)(response)).check_in
      if (value && /^[0-9a-f]{32}$/.test(value.nonce) && value.seconds > 0) {
        checkIn.nonce = value.nonce
        checkIn.seconds = value.seconds
        checkIn.at = Date.now()
      }
    })
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          // A failed /theos is fine — it just means no header this round.
          yield* refreshCheckIn().pipe(Effect.ignore)
          // Refresh at half the lifetime DeepAI gave, never faster than once a minute.
          yield* Effect.sleep(Duration.millis(Math.max(60_000, (checkIn.seconds * 1000) / 2)))
        }
      }),
    )

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
          // DeepAI's shared lane accepts a request, opens the stream, and then spends a long time prefilling: measured on
          // the real lane with a 95k-character system prompt (the app's own body), first text arrived between 3 s and
          // 32 s over 23 sends, p50 ~20 s, with no output at all in the meantime. So the silence guard has to clear the
          // slow tail or it converts every slow-but-working turn into "the provider produced nothing" and burns the
          // retries on it — that was the bug. 35 s clears every sample observed; a genuinely dead attempt still costs one
          // retry, and the content-filter path (5 tries, 500 ms apart) is what recovers a refused request.
          // This gateway also cuts a stream it has already started: measured on the real lane, the same keylogger request
          // came back complete in one turn and was cut mid-fence in the next. That is the same flap, so a blocked stream
          // is repeated into a fresh assistant message instead of ending the turn.
          settings: {
            baseURL: MODEL_BASE,
            provider: providerID,
            firstOutputTimeout: 35000,
            retryBlockedStream: true,
            ...account.settings,
          },
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
        // The check-in the background loop keeps fresh; sent only while still inside the lifetime DeepAI gave it.
        if (checkIn.nonce && Date.now() - checkIn.at < checkIn.seconds * 1000)
          event.request.headers.set("X-DeepAI-Code-Check-In", checkIn.nonce)
      }),
      { providerID },
    )
    // A spent allowance is not a rate limit: the app's rotation reacts to `provider.free-limit`, which the session error
    // mapping derives from a `FreeUsageLimitError` body, so a refusal is relabelled into that shape. A busy lane
    // (HTTP 409 session_busy) is not a refusal: DeepAI Code waits its retry-after and tries admission again, so the same
    // 409 is relabelled to a 429 that carries the delay, which the retry policy then waits out and resends — a fresh slot
    // instead of a silent stall.
    yield* ctx.session.hook(
      "http.response",
      Effect.fn(function* (event) {
        if (event.response.status === 409) {
          const body = yield* Effect.promise(() => event.response.clone().text().catch(() => ""))
          if (!/session_busy/i.test(body)) return
          // Clamp to the 1–30s window DeepAI Code uses, so a hostile or missing header cannot stall or spin.
          const after = Math.min(30, Math.max(1, Number(event.response.headers.get("retry-after")) || 2))
          event.response = new Response(body, {
            status: 429,
            headers: { "retry-after": String(after), "content-type": "application/json" },
          })
          return
        }
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

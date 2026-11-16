import { ai } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { DeepAIPlugin } from "@opencode/core/plugin/provider/deepai"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { expect } from "bun:test"
import { Effect, Layer, Schedule, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const integrationID = Integration.ID.make("deepai")
const providerID = Provider.ID.deepai
const methodID = Integration.MethodID.make("browser")
const modelID = Model.ID.make("glm-5.3-flash")

const catalog = {
  models: [
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 320_000,
      maxTokens: 131_072,
      theosPerRequest: "0",
    },
  ],
}

const fixture = Effect.gen(function* () {
  const requests: Request[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push(web)
      const url = new URL(web.url)
      const body = () =>
        url.pathname.endsWith("/models")
          ? Response.json(catalog)
          : url.pathname.endsWith("/desktop_auth/exchange/")
            ? Response.json({ api_key: "deep-key", username: "tester" })
            : new Response(
                'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "Content-Type": "text/event-stream" } },
              )
      return HttpClientResponse.fromWeb(request, body())
    }),
  )
  const integrations = yield* Integration.Service
  const providers = yield* Provider.Service
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* DeepAIPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))

  const connect = Effect.gen(function* () {
    const attempt = yield* integrations.oauth.connect({ integrationID, methodID, label: "DeepAI browser" })
    const url = new URL(attempt.url)
    const callback = new URL(`http://127.0.0.1:${url.searchParams.get("port")}/auth-callback`)
    callback.searchParams.set("state", url.searchParams.get("state") ?? "")
    callback.searchParams.set("code", "auth-code")
    return { attempt, url, callback }
  })
  const wait = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.repeat({ until: (value: A) => Boolean(value), schedule: Schedule.spaced("10 millis"), times: 200 }),
    )
  const send = (variant?: Model.VariantID) =>
    Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const resolved = yield* resolver.resolve(Model.Ref.make({ providerID, id: modelID, ...(variant ? { variant } : {}) }))
    if (!resolved) throw new Error("Expected a DeepAI model")
    expect(resolved.model.route.id).toBe("openai-compatible-chat")
    return yield* LLMClient.stream(ai.request({ model: resolved.model, prompt: "Hello" })).pipe(
      Stream.runCollect,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
      Effect.provideService(HttpClient.HttpClient, http),
    )
  }).pipe(Effect.provide(ModelResolver.layer))
  return { requests, providers, integrations, connect, wait, send }
})

it.effect("registers the DeepAI browser login and no provider before sign-in", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    expect(ProviderPlugins).toContain(DeepAIPlugin)
    expect((yield* test.integrations.get(integrationID))?.methods).toEqual([
      { id: methodID, type: "oauth", label: "Login with DeepAI (browser)" },
    ])
    expect(test.requests).toHaveLength(0)
  }),
)

it.live("signs in over loopback, loads the catalog and attributes every model call", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const login = yield* test.connect
    expect(login.url.origin + login.url.pathname).toBe("https://api.deepai.org/deepai_code/desktop_auth/")
    // The port the browser is told to come back to is the listener's own.
    expect(Number(login.url.searchParams.get("port"))).toBe(Number(login.callback.port))
    expect((yield* Effect.promise(() => fetch(login.callback, { headers: { Connection: "close" } }))).status).toBe(200)
    expect((yield* test.integrations.oauth.status({ integrationID, attemptID: login.attempt.attemptID })).status).toBe(
      "complete",
    )
    const exchange = test.requests.find((request) => request.url.endsWith("/desktop_auth/exchange/"))!
    expect(JSON.parse(yield* Effect.promise(() => exchange.text()))).toEqual({ code: "auth-code" })

    // The catalog load follows the credential switch; a model exists only once it has landed.
    const info = yield* test.wait(test.providers.get(providerID))
    expect(info?.settings?.baseURL).toBe("https://api.deepai.org/deepai_code")
    expect(info?.integrationID).toBe(integrationID)

    expect(yield* test.send()).toContainEqual(expect.objectContaining({ type: "text-delta", text: "Hello" }))
    const call = test.requests.at(-1)!
    expect(call.url).toBe("https://api.deepai.org/deepai_code/chat/completions")
    expect(call.headers.get("api-key")).toBe("deep-key")
    expect(call.headers.get("x-deepai-code-theos")).toBe("6")
    expect(call.headers.get("x-deepai-code-instance")).toHaveLength(32)

    expect(yield* test.send(Model.VariantID.make("high"))).toContainEqual(
      expect.objectContaining({ type: "text-delta", text: "Hello" }),
    )
    expect(JSON.parse(yield* Effect.promise(() => test.requests.at(-1)!.text()))).toMatchObject({
      model: "glm-5.3-flash",
      reasoning_effort: "high",
    })
  }),
)

it.live("rejects a callback whose state does not match", () =>
  Effect.gen(function* () {
    const test = yield* fixture
    const login = yield* test.connect
    login.callback.searchParams.set("state", "wrong")
    expect((yield* Effect.promise(() => fetch(login.callback, { headers: { Connection: "close" } }))).status).toBe(400)
    expect((yield* test.integrations.oauth.status({ integrationID, attemptID: login.attempt.attemptID }))).toMatchObject(
      { status: "failed", message: "Invalid sign-in state" },
    )
    expect(test.requests).toHaveLength(0)
  }),
)

it.effect("relabels a spent allowance so the app's rotation recognizes it as a free limit", () =>
  Effect.gen(function* () {
    yield* fixture
    const hooks = yield* PluginHooks.Service
    const event = yield* hooks.trigger("session", "http.response", {
      sessionID: Session.ID.make("ses_test"),
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID, id: modelID }),
      kind: "primary",
      request: new Request("https://api.deepai.org/deepai_code/chat/completions"),
      response: Response.json({ error: { code: "insufficient_theos", message: "Out of Theos." } }, { status: 402 }),
    })
    expect(event.response.status).toBe(402)
    expect(yield* Effect.promise(() => event.response.json())).toMatchObject({
      error: { code: "FreeUsageLimitError" },
    })
  }),
)

it.effect("leaves a DeepAI rate limit alone when the body names no allowance", () =>
  Effect.gen(function* () {
    yield* fixture
    const hooks = yield* PluginHooks.Service
    const event = yield* hooks.trigger("session", "http.response", {
      sessionID: Session.ID.make("ses_test"),
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID, id: modelID }),
      kind: "primary",
      request: new Request("https://api.deepai.org/deepai_code/chat/completions"),
      response: Response.json({ error: { code: "slow_down" } }, { status: 429 }),
    })
    expect(event.response.status).toBe(429)
    expect(yield* Effect.promise(() => event.response.json())).toEqual({ error: { code: "slow_down" } })
  }),
)

import { expect, mock, test } from "bun:test"

// Live check of the two Auto-rotate steps that talk to OpenCode: the probe on a temporary session and the
// "continue" sent to the chat. It spends free messages, so it only runs when a server is given:
//   OCINF_LIVE_URL=http://127.0.0.1:PORT OCINF_LIVE_PASSWORD=... OCINF_LIVE_SESSION=ses_... OCINF_LIVE_CLI=path\opencode-cli.exe
const electron = { app: { getPath: () => ".", once: () => undefined } }
mock.module("electron", () => ({ ...electron, default: electron }))

const { OCINF_LIVE_URL: url, OCINF_LIVE_PASSWORD: password, OCINF_LIVE_SESSION: session, OCINF_LIVE_CLI: cli } = process.env

test.skipIf(!url || !password || !session || !cli)(
  "the probe answers and continue reaches the chat",
  async () => {
    const { probeIp, resumeSession } = await import("./infinite")
    const { SidecarCredentials } = await import("../service/sidecar-credentials")
    SidecarCredentials.set({ url: url!, password: password! })

    const started = Date.now()
    expect(await probeIp([cli!])).toBe("ok")
    console.log(`probe took ${((Date.now() - started) / 1000).toFixed(1)} s`)

    expect(await resumeSession(session!)).toBe(true)
    const auth = { Authorization: SidecarCredentials.authorization(SidecarCredentials.get(), `${url}/api`)! }
    // The server took the message; the chat must also show it and get an answer after it.
    for (let i = 0; i < 60; i++) {
      const messages: { type: string; text?: string }[] = (await (await fetch(`${url}/api/session/${session}/message`, { headers: auth })).json()).data
      const sent = messages.findIndex((message) => message.type === "user" && message.text === "continue")
      // Newest first: an assistant message before the "continue" one is its answer.
      if (sent > 0 && messages.slice(0, sent).some((message) => message.type === "assistant")) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('no answer after "continue"')
  },
  180_000,
)
